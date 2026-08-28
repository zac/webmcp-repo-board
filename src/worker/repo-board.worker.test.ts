import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Actor, BoardView, CommandEnvelope, InternalBoardCommand, PullRequestSnapshot, RpcResult, Viewer } from "../shared";
import type { RepoBoard } from "./repo-board";

const zac: Actor = { userId: "user-zac", login: "zac" };
const ada: Actor = { userId: "user-ada", login: "ada" };

function viewer(actor: Actor): Viewer {
  return { userId: actor.userId, login: actor.login, avatarUrl: null, roleName: "write", canMutate: true };
}

function pullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 23,
    url: "https://github.com/acme/widgets/pull/23",
    title: "Implement the ticket",
    state: "open",
    draft: false,
    merged: false,
    headSha: "deadbeef",
    approvals: 0,
    changesRequestedBy: [],
    reviewCommentCount: 0,
    conversationCommentCount: 0,
    checks: { passed: 1, failed: 0, pending: 0, failedNames: [], pendingNames: [] },
    recentReviews: [],
    syncedAt: Date.now(),
    ...overrides,
  };
}

async function freshBoard(label: string): Promise<DurableObjectStub<RepoBoard>> {
  const stub = env.REPO_BOARD.getByName(`${label}-${crypto.randomUUID()}`);
  await stub.initialize({
    id: crypto.randomUUID(),
    owner: "acme",
    repo: "widgets",
    fullName: "acme/widgets",
    htmlUrl: "https://github.com/acme/widgets",
    isPrivate: false,
  });
  return stub;
}

async function command(
  stub: DurableObjectStub<RepoBoard>,
  actor: Actor,
  expectedRevision: number,
  value: InternalBoardCommand,
  options: { actionId?: string; now?: number } = {},
): Promise<RpcResult<BoardView>> {
  const envelope: CommandEnvelope<InternalBoardCommand> = {
    actionId: options.actionId ?? crypto.randomUUID(),
    expectedRevision,
    command: value,
  };
  return stub.execute(actor, viewer(actor), envelope, options.now ?? Date.now());
}

function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("RepoBoard Durable Object", () => {
  it("serializes simultaneous claims and returns the winner's lease in a structured conflict", async () => {
    const stub = await freshBoard("claim-race");
    const created = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Race", description: "Only one agent may win" }));
    const taskId = created.tasks[0].id;

    const [zacResult, adaResult] = await Promise.all([
      command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Codex Z" }),
      command(stub, ada, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Codex A" }),
    ]);
    const winners = [zacResult, adaResult].filter((result) => result.ok);
    const losers = [zacResult, adaResult].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.error.code).toBe("assignment_conflict");
      expect(loser.error.ownerLogin).toMatch(/zac|ada/);
      expect(loser.error.leaseExpiresAt).toBeGreaterThan(Date.now());
      expect(loser.error.currentRevision).toBe(2);
    }
  });

  it("executes the delegated plan, implementation, PR, merge, and archival workflow", async () => {
    const stub = await freshBoard("workflow");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Build coordination", description: "Preserve the workflow" }));
    const taskId = view.tasks[0].id;

    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Planner" }));
    const planningId = view.tasks[0].assignment!.id;
    view = unwrap(await command(stub, zac, 2, { type: "set_plan", assignmentId: planningId, markdown: "1. Model\n2. Verify" }));
    expect(view.tasks[0]).toMatchObject({ column: "ready", assignment: null, plan: { revision: 1, delegatedApproval: true } });

    view = unwrap(await command(stub, ada, 3, { type: "claim_task", taskId, kind: "implementation", agentLabel: "Builder" }));
    const implementationId = view.tasks[0].assignment!.id;
    view = unwrap(await command(stub, ada, 4, { type: "update_plan", assignmentId: implementationId, markdown: "1. Model\n2. Build\n3. Verify" }));
    expect(view.tasks[0].plan?.revision).toBe(2);
    view = unwrap(await command(stub, ada, 5, { type: "start_work", assignmentId: implementationId }));
    expect(view.tasks[0].column).toBe("in_progress");
    view = unwrap(await command(stub, ada, 6, { type: "report_progress", assignmentId: implementationId, phase: "testing", summary: "Reducer suite is green", stats: { filesChanged: 4, testsPassed: 18, testsFailed: 0 } }));
    expect(view.tasks[0].assignment).toMatchObject({ phase: "testing", summary: "Reducer suite is green", stats: { filesChanged: 4, testsPassed: 18, testsFailed: 0 } });

    view = unwrap(await command(stub, ada, 7, { type: "link_pull_request_snapshot", assignmentId: implementationId, snapshot: pullRequest() }));
    expect(view.tasks[0]).toMatchObject({ column: "in_pr", pullRequest: { number: 23 } });
    const newestSync = Date.now() + 10_000;
    unwrap(await stub.applyPullRequest(pullRequest({ approvals: 2, syncedAt: newestSync }), "manual", Date.now()));
    expect(unwrap(await stub.applyPullRequest(pullRequest({ state: "closed", merged: true, syncedAt: 1 }), "delayed-webhook", Date.now()))).toBeNull();
    expect(unwrap(await stub.getView(viewer(ada), false)).tasks[0].column).toBe("in_pr");
    const merged = await stub.applyPullRequest(pullRequest({ state: "closed", merged: true, approvals: 2, syncedAt: newestSync + 1 }), "webhook", Date.now());
    expect(unwrap(merged)?.tasks[0].column).toBe("done");
    view = unwrap(await command(stub, zac, 10, { type: "archive_task", taskId }));
    expect(view.tasks).toHaveLength(0);
    const history = unwrap(await stub.getView(viewer(zac), true));
    expect(history.tasks[0].archivedAt).not.toBeNull();
  });

  it("atomically saves an explicitly approved plan and replaces planning with implementation", async () => {
    const stub = await freshBoard("plan-and-start");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Plan and build", description: "Continue without a second turn" }));
    const taskId = view.tasks[0].id;
    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Primary Codex thread" }));
    const planningId = view.tasks[0].assignment!.id;

    view = unwrap(await command(stub, zac, 2, { type: "set_plan_and_start_work", assignmentId: planningId, markdown: "1. Implement\n2. Verify" }));

    expect(view.tasks[0]).toMatchObject({
      column: "in_progress",
      plan: { revision: 1, markdown: "1. Implement\n2. Verify", delegatedApproval: true },
      assignment: {
        kind: "implementation",
        userLogin: "zac",
        agentLabel: "Primary Codex thread",
        phase: "implementing",
        summary: "Implementation started",
        isMine: true,
      },
    });
    expect(view.tasks[0].assignment?.id).not.toBe(planningId);
    expect(view.tasks[0].recentEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["plan_set", "work_started"]));

    const formerMutation = await command(stub, zac, 3, { type: "report_progress", assignmentId: planningId, phase: "planning", summary: "Old lease", stats: {} });
    expect(formerMutation.ok).toBe(false);
    if (!formerMutation.ok) expect(formerMutation.error.code).toBe("assignment_inactive");
  });

  it("returns closed-unmerged work to In Progress and rejects invalid archival", async () => {
    const stub = await freshBoard("rollback");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Rollback", description: "PR can close" }));
    const taskId = view.tasks[0].id;
    const invalid = await command(stub, zac, 1, { type: "archive_task", taskId });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("task_not_archivable");

    const planning = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Planner" }));
    unwrap(await command(stub, zac, 2, { type: "set_plan", assignmentId: planning.tasks[0].assignment!.id, markdown: "Plan" }));
    view = unwrap(await command(stub, zac, 3, { type: "claim_task", taskId, kind: "implementation", agentLabel: "Builder" }));
    const assignmentId = view.tasks[0].assignment!.id;
    unwrap(await command(stub, zac, 4, { type: "start_work", assignmentId }));
    unwrap(await command(stub, zac, 5, { type: "link_pull_request_snapshot", assignmentId, snapshot: pullRequest() }));
    const closed = unwrap(await stub.applyPullRequest(pullRequest({ state: "closed" }), "webhook", Date.now()));
    expect(closed?.tasks[0].column).toBe("in_progress");
  });

  it("deduplicates actions, rejects stale agents, and expires leases through the alarm", async () => {
    const stub = await freshBoard("idempotency");
    const actionId = crypto.randomUUID();
    const first = await command(stub, zac, 0, { type: "create_task", title: "Once", description: "Idempotent" }, { actionId });
    const replay = await command(stub, zac, 0, { type: "create_task", title: "Once", description: "Idempotent" }, { actionId });
    expect(replay).toEqual(first);
    const view = unwrap(first);
    expect(view.tasks).toHaveLength(1);

    const stale = await command(stub, zac, 0, { type: "edit_task", taskId: view.tasks[0].id, title: "Stale", description: "No" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatchObject({ code: "stale_revision", currentRevision: 1 });

    unwrap(await command(stub, zac, 1, { type: "claim_task", taskId: view.tasks[0].id, kind: "planning", agentLabel: "Ephemeral" }));
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("UPDATE assignments SET lease_expires_at = 0 WHERE status = 'active'");
      await instance.alarm();
    });
    const expiredView = unwrap(await stub.getView(viewer(zac), false));
    expect(expiredView.tasks[0].assignment).toBeNull();
    expect(expiredView.revision).toBe(3);
    const takeover = unwrap(await command(stub, ada, 3, { type: "claim_task", taskId: view.tasks[0].id, kind: "planning", agentLabel: "Takeover" }));
    expect(takeover.tasks[0].assignment).toMatchObject({ userLogin: "ada", agentLabel: "Takeover" });
  });

  it("releases ownership immediately and rejects the former assignment", async () => {
    const stub = await freshBoard("release");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Release", description: "Hand it over" }));
    const taskId = view.tasks[0].id;
    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "First" }));
    const formerId = view.tasks[0].assignment!.id;
    view = unwrap(await command(stub, zac, 2, { type: "release_task", assignmentId: formerId }));
    expect(view.tasks[0].assignment).toBeNull();
    view = unwrap(await command(stub, ada, 3, { type: "claim_task", taskId, kind: "planning", agentLabel: "Second" }));
    expect(view.tasks[0].assignment?.userLogin).toBe("ada");
    const formerMutation = await command(stub, zac, 4, { type: "report_progress", assignmentId: formerId, phase: "planning", summary: "Stale owner", stats: {} });
    expect(formerMutation.ok).toBe(false);
    if (!formerMutation.ok) expect(formerMutation.error.code).toBe("assignment_inactive");
  });

  it("replays missed events and sends revisioned WebSocket updates", async () => {
    const stub = await freshBoard("websocket");
    unwrap(await command(stub, zac, 0, { type: "create_task", title: "First", description: "Before connect" }));
    const response = await stub.fetch(new Request("https://board.internal/socket?revision=0", {
      headers: {
        upgrade: "websocket",
        "x-board-viewer": JSON.stringify(viewer(zac)),
        "x-board-authorized-until": String(Date.now() + 60_000),
      },
    }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const snapshotPromise = nextSocketMessage(socket);
    socket.accept();
    const snapshot = await snapshotPromise;
    expect(snapshot).toMatchObject({ type: "snapshot", revision: 1 });
    expect(snapshot.events).toHaveLength(1);

    const updatePromise = nextSocketMessage(socket);
    unwrap(await command(stub, zac, 1, { type: "create_task", title: "Second", description: "Live update" }));
    const update = await updatePromise;
    expect(update).toMatchObject({ type: "updated", revision: 2 });
    const replayPromise = nextSocketMessage(socket);
    socket.send(JSON.stringify({ type: "resync", revision: 0 }));
    const replay = await replayPromise;
    expect(replay).toMatchObject({ type: "snapshot", revision: 2 });
    expect(replay.events).toHaveLength(2);
    socket.close(1000, "done");
  });

  it("recovers its SQLite state after eviction", async () => {
    const stub = await freshBoard("eviction");
    unwrap(await command(stub, zac, 0, { type: "create_task", title: "Durable", description: "Survives eviction" }));
    await evictDurableObject(stub);
    const recovered = unwrap(await stub.getView(viewer(zac), false));
    expect(recovered).toMatchObject({ fullName: "acme/widgets", revision: 1 });
    expect(recovered.tasks[0].title).toBe("Durable");
  });
});

function nextSocketMessage(socket: WebSocket): Promise<{ type: string; revision: number; events: unknown[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)) as { type: string; revision: number; events: unknown[] });
    }, { once: true });
  });
}
