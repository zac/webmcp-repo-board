import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Actor, BoardView, CommandEnvelope, InternalBoardCommand, PullRequestSnapshot, RpcResult, Viewer } from "../shared";
import { boardIdentityMatches, type RepositoryBoard } from "./repo-board";

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
    baseRef: "main",
    approvals: 0,
    authorLogin: "builder",
    changesRequestedBy: [],
    requestedReviewers: [],
    latestReviews: [],
    reviewRequirement: { requiredApprovals: 2, decision: "review_required", codeOwnerReviewRequired: false, latestPushApprovalRequired: false },
    mergeState: "blocked",
    reviewCommentCount: 0,
    conversationCommentCount: 0,
    checks: { passed: 1, failed: 0, pending: 0, failedNames: [], pendingNames: [] },
    recentReviews: [],
    syncedAt: Date.now(),
    ...overrides,
  };
}

async function freshBoard(label: string): Promise<DurableObjectStub<RepositoryBoard>> {
  const stub = env.REPO_BOARD.getByName(`${label}-${crypto.randomUUID()}`);
  await stub.initialize({
    id: crypto.randomUUID(),
    owner: "acme",
    repo: "widgets",
    fullName: "acme/widgets",
    repositoryId: 1,
    installationId: 1,
    htmlUrl: "https://github.com/acme/widgets",
    isPrivate: false,
  });
  return stub;
}

async function command(
  stub: DurableObjectStub<RepositoryBoard>,
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

describe("RepositoryBoard Durable Object", () => {
  it("boots one strict canonical schema and rejects identity changes", async () => {
    const stub = await freshBoard("canonical-schema");
    await runInDurableObject(stub, async (_instance, state) => {
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name);
      expect(tables).not.toContain("_sql_schema_migrations");
      const actionColumns = state.storage.sql.exec<{ name: string }>("PRAGMA table_info(processed_actions)").toArray().map((row) => row.name);
      expect(actionColumns).toEqual(["action_id", "actor_user_id", "revision", "processed_at"]);
    });
    expect(boardIdentityMatches(
      { fullName: "acme/widgets", repositoryId: 1, installationId: 1 },
      { fullName: "ACME/widgets", repositoryId: 1, installationId: 1 },
    )).toBe(true);
    expect(boardIdentityMatches(
      { fullName: "acme/widgets", repositoryId: 1, installationId: 1 },
      { fullName: "acme/widgets", repositoryId: 2, installationId: 1 },
    )).toBe(false);
  });

  it("allocates unique immutable word pairs inside one repository board", async () => {
    const stub = await freshBoard("task-references");
    let revision = 0;
    const references = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const view = unwrap(await command(stub, zac, revision, { type: "create_task", title: `Task ${index + 1}`, description: "Reference allocation" }));
      revision = view.revision;
      references.add(view.tasks.at(-1)!.reference);
    }
    expect(references.size).toBe(50);
    for (const reference of references) expect(reference).toMatch(/^[a-z]{3,6}-[a-z]{3,6}$/);
  });

  it("serializes simultaneous claims and returns the winner's lease in a structured conflict", async () => {
    const stub = await freshBoard("claim-race");
    const created = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Race", description: "Only one agent may win" }));
    const taskId = created.tasks[0].id;
    expect(created.tasks[0].reference).toMatch(/^[a-z]{3,6}-[a-z]{3,6}$/);

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
    const taskReference = view.tasks[0].reference;

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
    const approvalRefresh = unwrap(await stub.reservePullRequestRefresh(taskId));
    unwrap(await stub.applyPullRequest(pullRequest({ approvals: 2, syncedAt: newestSync }), "manual", Date.now(), approvalRefresh.generation));
    expect(unwrap(await stub.getView(viewer(ada), false)).tasks[0].column).toBe("in_pr");
    const mergeRefresh = unwrap(await stub.reservePullRequestRefresh(taskId));
    const merged = await stub.applyPullRequest(pullRequest({ state: "closed", merged: true, approvals: 2, syncedAt: newestSync + 1 }), "webhook", Date.now(), mergeRefresh.generation);
    expect(unwrap(merged)?.tasks[0]).toMatchObject({ column: "done", resolution: "completed", resolutionReason: null, assignment: null });
    view = unwrap(await command(stub, zac, 10, { type: "archive_task", taskId }));
    expect(view.tasks).toHaveLength(0);
    expect(view.archivedTaskCount).toBe(1);
    const history = unwrap(await stub.getView(viewer(zac), true));
    expect(history.archivedTaskCount).toBe(1);
    expect(history.tasks[0]).toMatchObject({ resolution: "completed", resolutionReason: null });
    expect(history.tasks[0].reference).toBe(taskReference);
    expect(history.tasks[0].archivedAt).not.toBeNull();
  });

  it("applies the newest reserved pull-request refresh even when requests finish out of order", async () => {
    const stub = await freshBoard("pr-generation");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Ordered PR", description: "Keep terminal state" }));
    const taskId = view.tasks[0].id;
    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Planner" }));
    unwrap(await command(stub, zac, 2, { type: "set_plan", assignmentId: view.tasks[0].assignment!.id, markdown: "Plan" }));
    view = unwrap(await command(stub, zac, 3, { type: "claim_task", taskId, kind: "implementation", agentLabel: "Builder" }));
    view = unwrap(await command(stub, zac, 4, { type: "start_work", assignmentId: view.tasks[0].assignment!.id }));
    unwrap(await command(stub, zac, 5, { type: "link_pull_request_snapshot", assignmentId: view.tasks[0].assignment!.id, snapshot: pullRequest() }));

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 5005
      ) INSERT INTO events (revision, event_type, task_id, actor_login, occurred_at, data_json)
      SELECT 0, 'historical', NULL, 'test', value, '{}' FROM sequence`);
    });
    const refreshNow = Date.now();
    const first = unwrap(await stub.reservePullRequestRefresh(taskId));
    await stub.recordPullRequestRefreshFailure(taskId, first.generation, refreshNow);
    await runInDurableObject(stub, async (_instance, state) => {
      const retry = state.storage.sql.exec<{ failure_count: number; next_reconcile_at: number }>(
        "SELECT failure_count, next_reconcile_at FROM pr_snapshots WHERE task_id = ?",
        taskId,
      ).one();
      expect(retry).toEqual({ failure_count: 1, next_reconcile_at: refreshNow + 5 * 60 * 1_000 });
    });
    const second = unwrap(await stub.reservePullRequestRefresh(taskId));
    unwrap(await stub.applyPullRequest(pullRequest({ state: "closed", merged: true }), "newer", Date.now(), second.generation));
    expect(unwrap(await stub.applyPullRequest(pullRequest({ state: "open", merged: false }), "older", Date.now(), first.generation))).toBeNull();
    expect(unwrap(await stub.getView(viewer(zac), false)).tasks[0]).toMatchObject({ column: "done", resolution: "completed" });
    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count).toBe(5_000);
      state.storage.sql.exec(`WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10
      ) INSERT INTO events (revision, event_type, task_id, actor_login, occurred_at, data_json)
      SELECT 0, 'historical', NULL, 'test', value, '{}' FROM sequence`);
      state.storage.sql.exec("UPDATE pr_snapshots SET next_reconcile_at = 0 WHERE task_id = ?", taskId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count).toBe(5_000);
    });
  });

  it("cancels active work atomically and retains its reason in archived history", async () => {
    const stub = await freshBoard("cancel");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Obsolete approach", description: "Try an experiment" }));
    const taskId = view.tasks[0].id;
    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Planner" }));
    const assignmentId = view.tasks[0].assignment!.id;

    view = unwrap(await command(stub, zac, 2, { type: "cancel_task", taskId, reason: "The upstream API now provides this behavior." }));

    expect(view.tasks).toHaveLength(0);
    expect(view.archivedTaskCount).toBe(1);
    const history = unwrap(await stub.getView(viewer(zac), true));
    expect(history.archivedTaskCount).toBe(1);
    expect(history.tasks[0]).toMatchObject({
      resolution: "canceled",
      resolutionReason: "The upstream API now provides this behavior.",
      assignment: null,
    });
    expect(history.tasks[0].archivedAt).not.toBeNull();
    expect(history.tasks[0].resolvedAt).not.toBeNull();
    expect(history.tasks[0].recentEvents[0]).toMatchObject({ type: "task_canceled", data: { archived: true } });

    const staleMutation = await command(stub, zac, 3, { type: "report_progress", assignmentId, phase: "planning", summary: "Still working", stats: {} });
    expect(staleMutation.ok).toBe(false);
    if (!staleMutation.ok) expect(staleMutation.error.code).toBe("assignment_inactive");
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

  it("uses the task-wide lease to serialize feedback-addressing work", async () => {
    const stub = await freshBoard("feedback-lock");
    let view = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Address review", description: "Keep author work exclusive" }));
    const taskId = view.tasks[0].id;
    view = unwrap(await command(stub, zac, 1, { type: "claim_task", taskId, kind: "planning", agentLabel: "Planner" }));
    unwrap(await command(stub, zac, 2, { type: "set_plan", assignmentId: view.tasks[0].assignment!.id, markdown: "Plan" }));
    view = unwrap(await command(stub, zac, 3, { type: "claim_task", taskId, kind: "implementation", agentLabel: "Builder" }));
    view = unwrap(await command(stub, zac, 4, { type: "start_work", assignmentId: view.tasks[0].assignment!.id }));
    view = unwrap(await command(stub, zac, 5, { type: "link_pull_request_snapshot", assignmentId: view.tasks[0].assignment!.id, snapshot: pullRequest({ authorLogin: "zac", changesRequestedBy: ["reviewer"] }) }));
    unwrap(await command(stub, zac, 6, { type: "release_task", assignmentId: view.tasks[0].assignment!.id }));

    view = unwrap(await command(stub, zac, 7, { type: "claim_task", taskId, kind: "implementation", focus: "review_feedback", agentLabel: "Feedback agent" }));
    expect(view.tasks[0]).toMatchObject({
      column: "in_pr",
      assignment: { focus: "review_feedback", phase: "reviewing", agentLabel: "Feedback agent" },
    });

    const competing = await command(stub, ada, 8, { type: "claim_task", taskId, kind: "implementation", focus: "fix_checks", agentLabel: "Checks agent" });
    expect(competing.ok).toBe(false);
    if (!competing.ok) expect(competing.error).toMatchObject({ code: "assignment_conflict", ownerLogin: "zac", currentRevision: 8 });
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
    const cannotCancel = await command(stub, zac, 6, { type: "cancel_task", taskId, reason: "No longer needed" });
    expect(cannotCancel.ok).toBe(false);
    if (!cannotCancel.ok) expect(cannotCancel.error).toMatchObject({ code: "task_not_cancelable" });
    const refresh = unwrap(await stub.reservePullRequestRefresh(taskId));
    const closed = unwrap(await stub.applyPullRequest(pullRequest({ state: "closed" }), "webhook", Date.now(), refresh.generation));
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
    await runInDurableObject(stub, async (_instance, state) => {
      const receipt = state.storage.sql.exec<{ revision: number }>("SELECT revision FROM processed_actions WHERE action_id = ?", actionId).one();
      expect(receipt.revision).toBe(1);
    });

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

  it("bounds retained webhook receipts", async () => {
    const stub = await freshBoard("webhook-retention");
    for (let index = 0; index < 2_050; index += 1) await stub.beginWebhook(`delivery-${index}`, index);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM processed_webhooks").one().count).toBe(2_000);
    });
  }, 15_000);

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
    const closePromise = nextSocketClose(socket);
    socket.send(JSON.stringify({ type: "resync", revision: 0 }));
    expect(await closePromise).toMatchObject({ code: 1008, reason: "Client messages are not supported" });
  });

  it("recovers its SQLite state after eviction", async () => {
    const stub = await freshBoard("eviction");
    const before = unwrap(await command(stub, zac, 0, { type: "create_task", title: "Durable", description: "Survives eviction" }));
    await evictDurableObject(stub);
    const recovered = unwrap(await stub.getView(viewer(zac), false));
    expect(recovered.tasks[0].reference).toBe(before.tasks[0].reference);
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

function nextSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), 2_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}
