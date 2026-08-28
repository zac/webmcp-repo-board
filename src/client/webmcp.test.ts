import { describe, expect, it, vi } from "vitest";
import type { AssignmentKind, BoardView, PullRequestSnapshot, TaskColumn, TaskView } from "../shared";
import { registerBoardTools, type BoardToolHandlers, type WebMcpContext, type WebMcpTool } from "./webmcp";

class Registry implements WebMcpContext {
  readonly tools = new Map<string, WebMcpTool>();

  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => this.tools.delete(tool.name), { once: true });
  }
}

function pullRequest(): PullRequestSnapshot {
  return {
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    title: "Implement ticket",
    state: "open",
    draft: false,
    merged: false,
    headSha: "abc123",
    approvals: 1,
    changesRequestedBy: [],
    reviewCommentCount: 2,
    conversationCommentCount: 1,
    checks: { passed: 2, failed: 0, pending: 1, failedNames: [], pendingNames: ["integration"] },
    recentReviews: [],
    syncedAt: 100,
  };
}

function task(column: TaskColumn, assigned = false): TaskView {
  const kind: AssignmentKind = column === "todo" ? "planning" : "implementation";
  return {
    id: `task-${column}`,
    title: `${column} task`,
    description: "Untrusted ticket text",
    column,
    archivedAt: null,
    createdBy: "zac",
    createdAt: 1,
    updatedAt: 2,
    revision: 3,
    revisions: [{ revision: 1, title: `${column} task`, description: "Untrusted ticket text", authorUserId: "u1", authorLogin: "zac", createdAt: 1 }],
    plan: column === "todo" ? null : { revision: 1, markdown: "Do the work", authorUserId: "u1", authorLogin: "zac", createdAt: 2, delegatedApproval: true },
    assignment: assigned ? {
      id: `assignment-${column}`,
      taskId: `task-${column}`,
      kind,
      userId: "u1",
      userLogin: "zac",
      agentLabel: "Codex",
      claimedAt: 2,
      lastActivityAt: 3,
      leaseExpiresAt: Date.now() + 60_000,
      phase: column === "todo" ? "planning" : "implementing",
      summary: "Working",
      stats: {},
      isMine: true,
    } : null,
    pullRequest: column === "in_pr" || column === "done" ? pullRequest() : null,
    recentEvents: [],
  };
}

function board(taskValue: TaskView, canMutate = true): BoardView {
  return {
    id: "board-1",
    owner: "acme",
    repo: "widgets",
    fullName: "acme/widgets",
    htmlUrl: "https://github.com/acme/widgets",
    isPrivate: false,
    materialized: true,
    revision: 3,
    viewer: { userId: canMutate ? "u1" : null, login: canMutate ? "zac" : null, avatarUrl: null, roleName: canMutate ? "write" : null, canMutate },
    tasks: [taskValue],
  };
}

function handlers(boardValue: BoardView, selected = boardValue.tasks[0]?.id ?? null): BoardToolHandlers {
  return {
    getBoard: () => boardValue,
    getSelectedTaskId: () => selected,
    getActiveAssignmentId: () => boardValue.tasks[0]?.assignment?.id ?? null,
    loadTask: vi.fn(async (taskId) => boardValue.tasks.find((taskValue) => taskValue.id === taskId) ?? null),
    runCommand: vi.fn(async () => boardValue),
    refreshPullRequest: vi.fn(async () => boardValue),
    confirmArchive: vi.fn(async () => undefined),
  };
}

async function namesFor(boardValue: BoardView): Promise<string[]> {
  const registry = new Registry();
  await registerBoardTools(registry, handlers(boardValue), new AbortController().signal);
  return [...registry.tools.keys()];
}

describe("dynamic WebMCP profiles", () => {
  it("exposes only bounded read tools to anonymous viewers", async () => {
    const registry = new Registry();
    await registerBoardTools(registry, handlers(board(task("todo"), false)), new AbortController().signal);

    expect([...registry.tools.keys()]).toEqual(["list_tasks", "inspect_task"]);
    expect(registry.tools.get("inspect_task")?.annotations?.readOnlyHint).toBe(true);
  });

  it("exposes claiming to authorized unassigned viewers", async () => {
    expect(await namesFor(board(task("ready")))).toEqual(["list_tasks", "inspect_task", "claim_task"]);
  });

  it.each([
    ["todo", ["list_tasks", "inspect_task", "report_progress", "release_task", "set_plan", "set_plan_and_start_work"]],
    ["ready", ["list_tasks", "inspect_task", "report_progress", "release_task", "read_plan", "update_plan", "start_work"]],
    ["in_progress", ["list_tasks", "inspect_task", "report_progress", "release_task", "read_plan", "link_pull_request"]],
    ["in_pr", ["list_tasks", "inspect_task", "report_progress", "release_task", "read_pull_request", "read_review", "check_status"]],
  ] satisfies Array<[TaskColumn, string[]]>)("registers the exact %s assignment profile", async (column, expected) => {
    expect(await namesFor(board(task(column, true)))).toEqual(expected);
  });

  it("adds confirmed archival only for the selected Done task", async () => {
    expect(await namesFor(board(task("done")))).toEqual(["list_tasks", "inspect_task", "claim_task", "archive_task"]);
  });

  it("removes every imperative tool when its profile signal aborts", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    await registerBoardTools(registry, handlers(board(task("ready", true))), controller.signal);
    expect(registry.tools.size).toBeGreaterThan(0);
    controller.abort();
    expect(registry.tools.size).toBe(0);
  });

  it("waits for in-page confirmation before archival", async () => {
    const registry = new Registry();
    const boardValue = board(task("done"));
    const toolHandlers = handlers(boardValue);
    await registerBoardTools(registry, toolHandlers, new AbortController().signal);
    await registry.tools.get("archive_task")!.execute({});
    expect(toolHandlers.confirmArchive).toHaveBeenCalledOnce();
    expect(toolHandlers.runCommand).toHaveBeenCalledWith({ type: "archive_task", taskId: "task-done" }, expect.any(AbortSignal));
  });

  it("cancels registration before any stale profile tool is added", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    controller.abort();
    await expect(registerBoardTools(registry, handlers(board(task("todo"))), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(registry.tools.size).toBe(0);
  });

  it("does not cancel an accepted call when its registry is replaced by the resulting broadcast", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    const boardValue = board(task("todo"));
    const toolHandlers = handlers(boardValue);
    toolHandlers.runCommand = vi.fn(async (_command, executionSignal) => {
      controller.abort();
      expect(executionSignal.aborted).toBe(false);
      return boardValue;
    });
    await registerBoardTools(registry, toolHandlers, controller.signal);
    const claim = registry.tools.get("claim_task")!;
    const executionController = new AbortController();
    await expect(claim.execute({ taskId: "task-todo", kind: "planning", agentLabel: "Codex" }, { signal: executionController.signal })).resolves.toContain('"status":"claimed"');
  });

  it("sets a plan and starts work through one explicit assignment-scoped call", async () => {
    const registry = new Registry();
    const boardValue = board(task("todo", true));
    const nextBoard = board({
      ...task("in_progress", true),
      id: "task-todo",
      assignment: { ...task("in_progress", true).assignment!, id: "implementation-assignment" },
    });
    const toolHandlers = handlers(boardValue);
    toolHandlers.runCommand = vi.fn(async () => nextBoard);
    await registerBoardTools(registry, toolHandlers, new AbortController().signal);

    const result = await registry.tools.get("set_plan_and_start_work")!.execute({ markdown: "1. Build\n2. Test" });

    expect(toolHandlers.runCommand).toHaveBeenCalledWith(
      { type: "set_plan_and_start_work", assignmentId: "assignment-todo", markdown: "1. Build\n2. Test" },
      expect.any(AbortSignal),
    );
    expect(result).toContain('"status":"in_progress"');
    expect(result).toContain('"implementation-assignment"');
  });

  it("marks user and GitHub content as untrusted in read results", async () => {
    const registry = new Registry();
    const boardValue = board(task("in_pr", true));
    await registerBoardTools(registry, handlers(boardValue), new AbortController().signal);
    expect(registry.tools.get("inspect_task")?.annotations?.untrustedContentHint).toBe(true);
    const result = await registry.tools.get("read_review")!.execute({});
    expect(String(result).length).toBeLessThanOrEqual(40_000);
  });

  it("loads archived task history without adding it to the live board", async () => {
    const registry = new Registry();
    const archivedTask = { ...task("done"), archivedAt: 100 };
    const liveBoard = { ...board(task("done")), tasks: [] };
    const toolHandlers = handlers(liveBoard, archivedTask.id);
    toolHandlers.loadTask = vi.fn(async (taskId) => taskId === archivedTask.id ? archivedTask : null);
    await registerBoardTools(registry, toolHandlers, new AbortController().signal);

    const result = await registry.tools.get("inspect_task")!.execute({ taskId: archivedTask.id });

    expect(result).toContain('"archivedAt":100');
    expect(toolHandlers.loadTask).toHaveBeenCalledWith(archivedTask.id, expect.any(AbortSignal));
    expect(liveBoard.tasks).toEqual([]);
  });

  it("does not label lease-renewing assignment tools as read-only", async () => {
    const registry = new Registry();
    await registerBoardTools(registry, handlers(board(task("in_pr", true))), new AbortController().signal);

    expect(registry.tools.get("list_tasks")?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["inspect_task", "read_pull_request", "read_review", "check_status"]) {
      expect(registry.tools.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
  });

  it.each(["ready", "in_progress"] satisfies TaskColumn[])("marks %s plan reads as lease-renewing", async (column) => {
    const registry = new Registry();
    await registerBoardTools(registry, handlers(board(task(column, true))), new AbortController().signal);
    expect(registry.tools.get("read_plan")?.annotations?.readOnlyHint).toBe(false);
  });
});
