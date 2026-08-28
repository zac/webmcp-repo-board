import { DurableObject } from "cloudflare:workers";
import {
  TransitionError,
  assertClaimAllowed,
  canArchive,
  columnForPullRequest,
  type Actor,
  type AgentPhase,
  type AgentStats,
  type AssignmentKind,
  type AssignmentView,
  type BoardSocketMessage,
  type BoardView,
  type CommandEnvelope,
  type InternalBoardCommand,
  type PlanRevision,
  type PullRequestSnapshot,
  type RpcResult,
  type TaskColumn,
  type TaskEvent,
  type TaskRevision,
  type TaskView,
  type Viewer,
} from "../shared";

const LEASE_MS = 15 * 60 * 1_000;
const RECONCILE_MS = 5 * 60 * 1_000;
const MAX_TASKS = 200;

interface BoardMetadata {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
}

interface TaskRow extends Record<string, SqlStorageValue> {
  id: string;
  title: string;
  description: string;
  column_name: TaskColumn;
  archived_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  task_revision: number;
  latest_plan_revision: number;
  linked_pr_number: number | null;
}

interface AssignmentRow extends Record<string, SqlStorageValue> {
  id: string;
  task_id: string;
  kind: AssignmentKind;
  user_id: string;
  user_login: string;
  agent_label: string;
  status: string;
  claimed_at: number;
  last_activity_at: number;
  lease_expires_at: number;
  phase: AgentPhase;
  summary: string;
  stats_json: string;
}

interface SocketAttachment {
  viewer: Viewer;
  authorizedUntil: number;
  lastRevision: number;
}

interface LinkedPullRequest {
  taskId: string;
  number: number;
  nextReconcileAt: number;
}

export class RepoBoard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  async initialize(metadata: BoardMetadata): Promise<void> {
    const existing = this.getMetadata();
    if (existing) {
      if (existing.fullName !== metadata.fullName) throw new Error("Board identity cannot change");
      this.ctx.storage.sql.exec("UPDATE board_metadata SET html_url = ?, is_private = ? WHERE id = ?", metadata.htmlUrl, metadata.isPrivate ? 1 : 0, metadata.id);
      return;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO board_metadata (id, owner, repo, full_name, html_url, is_private, revision) VALUES (?, ?, ?, ?, ?, ?, 0)",
      metadata.id,
      metadata.owner,
      metadata.repo,
      metadata.fullName,
      metadata.htmlUrl,
      metadata.isPrivate ? 1 : 0,
    );
  }

  async getView(viewer: Viewer, includeArchived = false): Promise<RpcResult<BoardView>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);
    return success(this.buildView(metadata, viewer, includeArchived));
  }

  async execute(actor: Actor, viewer: Viewer, envelope: CommandEnvelope<InternalBoardCommand>, now: number): Promise<RpcResult<BoardView>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);

    const processed = this.ctx.storage.sql
      .exec<{ actor_user_id: string; result_json: string }>("SELECT actor_user_id, result_json FROM processed_actions WHERE action_id = ?", envelope.actionId)
      .toArray()[0];
    if (processed) {
      if (processed.actor_user_id !== actor.userId) return failure("action_owner_mismatch", "Action ID was already used by another user", 409);
      return JSON.parse(processed.result_json) as RpcResult<BoardView>;
    }

    const currentRevision = this.currentRevision();
    if (envelope.expectedRevision !== currentRevision) {
      if (envelope.command.type === "claim_task") {
        const active = this.activeAssignment(envelope.command.taskId, now);
        if (active) {
          return failure(
            "assignment_conflict",
            `${active.user_login} owns this task until ${new Date(active.lease_expires_at).toISOString()}`,
            409,
            currentRevision,
            { ownerLogin: active.user_login, leaseExpiresAt: active.lease_expires_at },
          );
        }
      }
      return failure("stale_revision", "Board changed before this command was applied", 409, currentRevision);
    }

    try {
      let result!: RpcResult<BoardView>;
      this.ctx.storage.transactionSync(() => {
        const event = this.applyCommand(metadata, actor, envelope.command, now, currentRevision + 1);
        this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", currentRevision + 1, metadata.id);
        this.insertEvent(currentRevision + 1, event.type, event.taskId, actor.login, now, event.data);
        result = success(this.buildView(metadata, viewer, false));
        this.ctx.storage.sql.exec(
          "INSERT INTO processed_actions (action_id, actor_user_id, result_json, processed_at) VALUES (?, ?, ?, ?)",
          envelope.actionId,
          actor.userId,
          JSON.stringify(result),
          now,
        );
      });
      this.broadcast(currentRevision + 1);
      await this.rescheduleAlarm();
      return result;
    } catch (error) {
      if (error instanceof BoardError || error instanceof TransitionError) {
        return failure(
          error.code,
          error.message,
          error instanceof BoardError ? error.status : 409,
          this.currentRevision(),
          error instanceof BoardError ? error.details : undefined,
        );
      }
      console.error(JSON.stringify({ event: "board_command_failed", error: error instanceof Error ? error.message : "unknown" }));
      return failure("internal_error", "The board command could not be applied", 500);
    }
  }

  async beginWebhook(deliveryId: string, now: number): Promise<boolean> {
    const seen = this.ctx.storage.sql.exec<{ delivery_id: string }>("SELECT delivery_id FROM processed_webhooks WHERE delivery_id = ?", deliveryId).toArray()[0];
    if (seen) return false;
    this.ctx.storage.sql.exec("INSERT INTO processed_webhooks (delivery_id, processed_at) VALUES (?, ?)", deliveryId, now);
    return true;
  }

  async getLinkedPullRequest(taskId: string): Promise<RpcResult<{ taskId: string; number: number }>> {
    const row = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId).toArray()[0];
    if (!row || row.linked_pr_number === null) return failure("pull_request_not_linked", "Task has no linked pull request", 404);
    return success({ taskId, number: row.linked_pr_number });
  }

  async listPullRequestsDue(now: number, limit = 25): Promise<LinkedPullRequest[]> {
    return this.ctx.storage.sql
      .exec<{ task_id: string; pr_number: number; next_reconcile_at: number }>(
        "SELECT task_id, pr_number, next_reconcile_at FROM pr_snapshots WHERE reconcile_due = 1 OR next_reconcile_at <= ? ORDER BY next_reconcile_at LIMIT ?",
        now,
        limit,
      )
      .toArray()
      .map((row) => ({ taskId: row.task_id, number: row.pr_number, nextReconcileAt: row.next_reconcile_at }));
  }

  async listLinkedPullRequests(limit = 100): Promise<LinkedPullRequest[]> {
    return this.ctx.storage.sql
      .exec<{ task_id: string; pr_number: number; next_reconcile_at: number }>(
        "SELECT task_id, pr_number, next_reconcile_at FROM pr_snapshots ORDER BY task_id LIMIT ?",
        limit,
      )
      .toArray()
      .map((row) => ({ taskId: row.task_id, number: row.pr_number, nextReconcileAt: row.next_reconcile_at }));
  }

  async applyPullRequest(snapshot: PullRequestSnapshot, source: string, now: number): Promise<RpcResult<BoardView | null>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);
    const task = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE linked_pr_number = ?", snapshot.number).toArray()[0];
    if (!task) return success(null);

    const existing = this.ctx.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM pr_snapshots WHERE task_id = ?", task.id).toArray()[0];
    const previous = existing ? (JSON.parse(existing.snapshot_json) as PullRequestSnapshot) : null;
    if (previous && snapshot.syncedAt < previous.syncedAt) return success(null);
    const nextColumn = columnForPullRequest(snapshot);
    const materiallyChanged = !previous || JSON.stringify({ ...previous, syncedAt: 0 }) !== JSON.stringify({ ...snapshot, syncedAt: 0 }) || task.column_name !== nextColumn;

    const revision = this.currentRevision() + (materiallyChanged ? 1 : 0);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO pr_snapshots (task_id, pr_number, snapshot_json, next_reconcile_at, reconcile_due)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(task_id) DO UPDATE SET pr_number = excluded.pr_number, snapshot_json = excluded.snapshot_json,
         next_reconcile_at = excluded.next_reconcile_at, reconcile_due = 0`,
        task.id,
        snapshot.number,
        JSON.stringify(snapshot),
        now + RECONCILE_MS,
      );
      if (!materiallyChanged) return;
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET column_name = ?, updated_at = ?, task_revision = ? WHERE id = ?",
        nextColumn,
        now,
        revision,
        task.id,
      );
      if (nextColumn === "done") {
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'completed', last_activity_at = ? WHERE task_id = ? AND status = 'active'", now, task.id);
      }
      this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", revision, metadata.id);
      this.insertEvent(revision, snapshot.merged ? "pull_request_merged" : snapshot.state === "closed" ? "pull_request_closed" : "pull_request_updated", task.id, "github", now, { source, pullRequest: snapshot.number, column: nextColumn });
    });
    if (!materiallyChanged) {
      await this.rescheduleAlarm();
      return success(null);
    }
    this.broadcast(revision);
    await this.rescheduleAlarm();
    return success(this.buildView(metadata, systemViewer(), false));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const viewerHeader = request.headers.get("x-board-viewer");
    const authorizedUntil = Number(request.headers.get("x-board-authorized-until"));
    const lastRevision = Number(new URL(request.url).searchParams.get("revision") ?? "0");
    if (!viewerHeader || !Number.isFinite(authorizedUntil)) return new Response("Unauthorized", { status: 401 });
    const viewer = JSON.parse(viewerHeader) as Viewer;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { viewer, authorizedUntil, lastRevision };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    const metadata = this.getMetadata();
    if (metadata) {
      const revision = this.currentRevision();
      const message: BoardSocketMessage = {
        type: "snapshot",
        revision,
        board: this.buildView(metadata, viewer, false),
        events: this.eventsSince(lastRevision),
      };
      server.send(JSON.stringify(message));
    }
    await this.rescheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: { type?: string; revision?: number };
    try {
      parsed = JSON.parse(message) as { type?: string; revision?: number };
    } catch {
      ws.close(1003, "Invalid message");
      return;
    }
    if (parsed.type !== "resync") return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    const metadata = this.getMetadata();
    if (!attachment || !metadata) return;
    const revision = this.currentRevision();
    ws.send(JSON.stringify({
      type: "snapshot",
      revision,
      board: this.buildView(metadata, attachment.viewer, false),
      events: this.eventsSince(Number(parsed.revision ?? 0)),
    } satisfies BoardSocketMessage));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const metadata = this.getMetadata();
    if (!metadata) return;
    const expiredAssignments = this.ctx.storage.sql
      .exec<{ id: string; task_id: string; user_login: string }>("SELECT id, task_id, user_login FROM assignments WHERE status = 'active' AND lease_expires_at <= ?", now)
      .toArray();
    const duePullRequests = this.ctx.storage.sql.exec<{ task_id: string }>("SELECT task_id FROM pr_snapshots WHERE next_reconcile_at <= ?", now).toArray();

    let revision: number | null = null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE assignments SET status = 'expired', last_activity_at = ? WHERE status = 'active' AND lease_expires_at <= ?", now, now);
      this.ctx.storage.sql.exec("UPDATE pr_snapshots SET reconcile_due = 1, next_reconcile_at = ? WHERE next_reconcile_at <= ?", now + RECONCILE_MS, now);
      if (expiredAssignments.length === 0 && duePullRequests.length === 0) return;
      revision = this.currentRevision() + 1;
      this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", revision, metadata.id);
      for (const assignment of expiredAssignments) {
        this.insertEvent(revision, "assignment_expired", assignment.task_id, assignment.user_login, now, { assignmentId: assignment.id });
      }
      for (const pullRequest of duePullRequests) {
        this.insertEvent(revision, "pull_request_reconciliation_due", pullRequest.task_id, "system", now, {});
      }
    });

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.authorizedUntil <= now) socket.close(4001, "Authorization expired");
    }

    if (revision !== null) this.broadcast(revision);
    await this.rescheduleAlarm();
  }

  private applyCommand(metadata: BoardMetadata, actor: Actor, command: InternalBoardCommand, now: number, revision: number): { type: string; taskId: string | null; data: Record<string, string | number | boolean | null> } {
    switch (command.type) {
      case "create_task": {
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NULL").one().count;
        if (count >= MAX_TASKS) throw new BoardError("task_limit", "Board already has the maximum number of active tasks", 409);
        const taskId = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `INSERT INTO tasks (id, title, description, column_name, archived_at, created_by, created_at, updated_at, task_revision, latest_plan_revision, linked_pr_number)
           VALUES (?, ?, ?, 'todo', NULL, ?, ?, ?, ?, 0, NULL)`,
          taskId,
          command.title,
          command.description,
          actor.login,
          now,
          now,
          revision,
        );
        this.insertTaskRevision(taskId, revision, command.title, command.description, actor, now);
        return { type: "task_created", taskId, data: { title: command.title } };
      }
      case "edit_task": {
        const task = this.requireTask(command.taskId);
        if (task.column_name !== "todo" || task.archived_at !== null) throw new BoardError("task_not_editable", "Only active Todo tasks can be edited", 409);
        if (this.activeAssignment(task.id, now)) throw new BoardError("task_assigned", "Release the planning assignment before editing this task", 409);
        this.ctx.storage.sql.exec("UPDATE tasks SET title = ?, description = ?, updated_at = ?, task_revision = ? WHERE id = ?", command.title, command.description, now, revision, task.id);
        this.insertTaskRevision(task.id, revision, command.title, command.description, actor, now);
        return { type: "task_edited", taskId: task.id, data: { title: command.title } };
      }
      case "claim_task": {
        const task = this.requireTask(command.taskId);
        assertClaimAllowed(task.column_name, command.kind, task.archived_at);
        const active = this.activeAssignment(task.id, now);
        if (active) throw new BoardError(
          "assignment_conflict",
          `${active.user_login} owns this task until ${new Date(active.lease_expires_at).toISOString()}`,
          409,
          { ownerLogin: active.user_login, leaseExpiresAt: active.lease_expires_at },
        );
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'expired' WHERE task_id = ? AND status = 'active' AND lease_expires_at <= ?", task.id, now);
        const assignmentId = crypto.randomUUID();
        const phase: AgentPhase = command.kind === "planning" ? "planning" : "investigating";
        this.ctx.storage.sql.exec(
          `INSERT INTO assignments (id, task_id, kind, user_id, user_login, agent_label, status, claimed_at, last_activity_at, lease_expires_at, phase, summary, stats_json)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, '', '{}')`,
          assignmentId,
          task.id,
          command.kind,
          actor.userId,
          actor.login,
          command.agentLabel,
          now,
          now,
          now + LEASE_MS,
          phase,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, task.id);
        return { type: "task_claimed", taskId: task.id, data: { assignmentId, kind: command.kind, agentLabel: command.agentLabel } };
      }
      case "renew_assignment": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now);
        this.renewAssignment(assignment.id, now, assignment.phase, assignment.summary, parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, assignment.task_id);
        return { type: "assignment_renewed", taskId: assignment.task_id, data: { assignmentId: assignment.id } };
      }
      case "report_progress": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now);
        this.renewAssignment(assignment.id, now, command.phase, command.summary, command.stats);
        this.ctx.storage.sql.exec(
          "INSERT INTO progress_reports (id, assignment_id, task_id, phase, summary, stats_json, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(), assignment.id, assignment.task_id, command.phase, command.summary, JSON.stringify(command.stats), now,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, assignment.task_id);
        return { type: "progress_reported", taskId: assignment.task_id, data: { phase: command.phase, summary: command.summary } };
      }
      case "set_plan": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now, "planning");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "todo") throw new BoardError("invalid_transition", "A plan can only be set on a Todo task", 409);
        const planRevision = task.latest_plan_revision + 1;
        this.insertPlan(task.id, planRevision, command.markdown, actor, now);
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'ready', latest_plan_revision = ?, updated_at = ?, task_revision = ? WHERE id = ?", planRevision, now, revision, task.id);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'completed', last_activity_at = ? WHERE id = ?", now, assignment.id);
        return { type: "plan_set", taskId: task.id, data: { planRevision, column: "ready" } };
      }
      case "update_plan": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "ready") throw new BoardError("invalid_transition", "An implementation agent can update a plan only while the task is Ready", 409);
        const planRevision = task.latest_plan_revision + 1;
        this.insertPlan(task.id, planRevision, command.markdown, actor, now);
        this.renewAssignment(assignment.id, now, "planning", "Updated the delegated plan", parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET latest_plan_revision = ?, updated_at = ?, task_revision = ? WHERE id = ?", planRevision, now, revision, task.id);
        return { type: "plan_updated", taskId: task.id, data: { planRevision } };
      }
      case "start_work": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "ready" || task.latest_plan_revision < 1) throw new BoardError("invalid_transition", "Only a Ready task with a plan can start work", 409);
        this.renewAssignment(assignment.id, now, "implementing", "Implementation started", parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'in_progress', updated_at = ?, task_revision = ? WHERE id = ?", now, revision, task.id);
        return { type: "work_started", taskId: task.id, data: { column: "in_progress" } };
      }
      case "release_task": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'released', last_activity_at = ? WHERE id = ?", now, assignment.id);
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, assignment.task_id);
        return { type: "task_released", taskId: assignment.task_id, data: { assignmentId: assignment.id } };
      }
      case "link_pull_request_snapshot": {
        const assignment = this.requireAssignment(command.assignmentId, actor, now, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "in_progress") throw new BoardError("invalid_transition", "A pull request can be linked only while work is in progress", 409);
        if (command.snapshot.state !== "open" || command.snapshot.merged) throw new BoardError("pull_request_not_open", "The linked pull request must be open", 409);
        this.renewAssignment(assignment.id, now, "waiting", `Linked PR #${command.snapshot.number}`, parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'in_pr', linked_pr_number = ?, updated_at = ?, task_revision = ? WHERE id = ?", command.snapshot.number, now, revision, task.id);
        this.ctx.storage.sql.exec(
          "INSERT INTO pr_snapshots (task_id, pr_number, snapshot_json, next_reconcile_at, reconcile_due) VALUES (?, ?, ?, ?, 0)",
          task.id,
          command.snapshot.number,
          JSON.stringify(command.snapshot),
          now + RECONCILE_MS,
        );
        return { type: "pull_request_linked", taskId: task.id, data: { pullRequest: command.snapshot.number, column: "in_pr" } };
      }
      case "archive_task": {
        const task = this.requireTask(command.taskId);
        if (!canArchive(task.column_name, task.archived_at)) throw new BoardError("task_not_archivable", "Only an unarchived Done task can be archived", 409);
        this.ctx.storage.sql.exec("UPDATE tasks SET archived_at = ?, updated_at = ?, task_revision = ? WHERE id = ?", now, now, revision, task.id);
        return { type: "task_archived", taskId: task.id, data: { archived: true } };
      }
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS board_metadata (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, full_name TEXT NOT NULL,
        html_url TEXT NOT NULL, is_private INTEGER NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, column_name TEXT NOT NULL,
        archived_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        task_revision INTEGER NOT NULL, latest_plan_revision INTEGER NOT NULL, linked_pr_number INTEGER
      );
      CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_name, archived_at);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_linked_pr_idx ON tasks(linked_pr_number) WHERE linked_pr_number IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_revisions (
        task_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        author_user_id TEXT NOT NULL, author_login TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, revision)
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        task_id TEXT NOT NULL, revision INTEGER NOT NULL, markdown TEXT NOT NULL, author_user_id TEXT NOT NULL,
        author_login TEXT NOT NULL, created_at INTEGER NOT NULL, delegated_approval INTEGER NOT NULL,
        PRIMARY KEY(task_id, revision)
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, user_login TEXT NOT NULL,
        agent_label TEXT NOT NULL, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL, phase TEXT NOT NULL, summary TEXT NOT NULL, stats_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assignments_active_idx ON assignments(task_id, status, lease_expires_at);
      CREATE TABLE IF NOT EXISTS progress_reports (
        id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, task_id TEXT NOT NULL, phase TEXT NOT NULL,
        summary TEXT NOT NULL, stats_json TEXT NOT NULL, reported_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pr_snapshots (
        task_id TEXT PRIMARY KEY, pr_number INTEGER NOT NULL UNIQUE, snapshot_json TEXT NOT NULL,
        next_reconcile_at INTEGER NOT NULL, reconcile_due INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, event_type TEXT NOT NULL, task_id TEXT,
        actor_login TEXT, occurred_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_revision_idx ON events(revision);
      CREATE TABLE IF NOT EXISTS processed_actions (
        action_id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, result_json TEXT NOT NULL, processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        delivery_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (1, unixepoch() * 1000);
    `);
  }

  private getMetadata(): BoardMetadata | null {
    const row = this.ctx.storage.sql.exec<{ id: string; owner: string; repo: string; full_name: string; html_url: string; is_private: number }>("SELECT id, owner, repo, full_name, html_url, is_private FROM board_metadata LIMIT 1").toArray()[0];
    return row ? { id: row.id, owner: row.owner, repo: row.repo, fullName: row.full_name, htmlUrl: row.html_url, isPrivate: Boolean(row.is_private) } : null;
  }

  private currentRevision(): number {
    return this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM board_metadata LIMIT 1").toArray()[0]?.revision ?? 0;
  }

  private requireTask(taskId: string): TaskRow {
    const task = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId).toArray()[0];
    if (!task) throw new BoardError("task_not_found", "Task was not found", 404);
    return task;
  }

  private activeAssignment(taskId: string, now: number): AssignmentRow | null {
    return this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE task_id = ? AND status = 'active' AND lease_expires_at > ? ORDER BY claimed_at DESC LIMIT 1", taskId, now).toArray()[0] ?? null;
  }

  private requireAssignment(assignmentId: string, actor: Actor, now: number, kind?: AssignmentKind): AssignmentRow {
    const assignment = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE id = ?", assignmentId).toArray()[0];
    if (!assignment) throw new BoardError("assignment_not_found", "Assignment was not found", 404);
    if (assignment.user_id !== actor.userId) throw new BoardError("assignment_owner_mismatch", "Assignment belongs to another GitHub user", 403);
    if (assignment.status !== "active") throw new BoardError("assignment_inactive", "Assignment is no longer active", 409);
    if (assignment.lease_expires_at <= now) {
      this.ctx.storage.sql.exec("UPDATE assignments SET status = 'expired' WHERE id = ?", assignment.id);
      throw new BoardError("assignment_expired", "Assignment lease expired and the task can be claimed again", 409);
    }
    if (kind && assignment.kind !== kind) throw new BoardError("wrong_assignment_kind", `This command requires a ${kind} assignment`, 409);
    return assignment;
  }

  private renewAssignment(id: string, now: number, phase: AgentPhase, summary: string, stats: AgentStats): void {
    this.ctx.storage.sql.exec(
      "UPDATE assignments SET last_activity_at = ?, lease_expires_at = ?, phase = ?, summary = ?, stats_json = ? WHERE id = ?",
      now,
      now + LEASE_MS,
      phase,
      summary,
      JSON.stringify(stats),
      id,
    );
  }

  private insertPlan(taskId: string, revision: number, markdown: string, actor: Actor, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO plan_revisions (task_id, revision, markdown, author_user_id, author_login, created_at, delegated_approval) VALUES (?, ?, ?, ?, ?, ?, 1)",
      taskId,
      revision,
      markdown,
      actor.userId,
      actor.login,
      now,
    );
  }

  private insertTaskRevision(taskId: string, revision: number, title: string, description: string, actor: Actor, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO task_revisions (task_id, revision, title, description, author_user_id, author_login, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      taskId,
      revision,
      title,
      description,
      actor.userId,
      actor.login,
      now,
    );
  }

  private insertEvent(revision: number, type: string, taskId: string | null, actorLogin: string | null, at: number, data: Record<string, string | number | boolean | null>): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (revision, event_type, task_id, actor_login, occurred_at, data_json) VALUES (?, ?, ?, ?, ?, ?)",
      revision,
      type,
      taskId,
      actorLogin,
      at,
      JSON.stringify(data),
    );
  }

  private buildView(metadata: BoardMetadata, viewer: Viewer, includeArchived: boolean): BoardView {
    const tasks = this.ctx.storage.sql
      .exec<TaskRow>(`SELECT * FROM tasks ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at ASC LIMIT ?`, MAX_TASKS)
      .toArray()
      .map((task) => this.buildTaskView(task, viewer));
    return { ...metadata, revision: this.currentRevision(), viewer, tasks };
  }

  private buildTaskView(task: TaskRow, viewer: Viewer): TaskView {
    const assignment = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE task_id = ? AND status = 'active' AND lease_expires_at > ? ORDER BY claimed_at DESC LIMIT 1", task.id, Date.now()).toArray()[0];
    const planRow = task.latest_plan_revision > 0
      ? this.ctx.storage.sql.exec<{ revision: number; markdown: string; author_user_id: string; author_login: string; created_at: number }>("SELECT revision, markdown, author_user_id, author_login, created_at FROM plan_revisions WHERE task_id = ? AND revision = ?", task.id, task.latest_plan_revision).toArray()[0]
      : undefined;
    const prRow = this.ctx.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM pr_snapshots WHERE task_id = ?", task.id).toArray()[0];
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      column: task.column_name,
      archivedAt: task.archived_at,
      createdBy: task.created_by,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      revision: task.task_revision,
      revisions: this.ctx.storage.sql.exec<{
        revision: number; title: string; description: string; author_user_id: string; author_login: string; created_at: number;
      }>("SELECT revision, title, description, author_user_id, author_login, created_at FROM task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 20", task.id)
        .toArray()
        .map((row) => ({ revision: row.revision, title: row.title, description: row.description, authorUserId: row.author_user_id, authorLogin: row.author_login, createdAt: row.created_at } satisfies TaskRevision)),
      plan: planRow ? { revision: planRow.revision, markdown: planRow.markdown, authorUserId: planRow.author_user_id, authorLogin: planRow.author_login, createdAt: planRow.created_at, delegatedApproval: true } satisfies PlanRevision : null,
      assignment: assignment ? assignmentView(assignment, viewer.userId) : null,
      pullRequest: prRow ? JSON.parse(prRow.snapshot_json) as PullRequestSnapshot : null,
      recentEvents: this.ctx.storage.sql.exec<{ id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }>("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 20", task.id).toArray().map(eventView),
    };
  }

  private eventsSince(revision: number): TaskEvent[] {
    return this.ctx.storage.sql.exec<{ id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }>("SELECT * FROM events WHERE revision > ? ORDER BY id ASC LIMIT 100", revision).toArray().map(eventView);
  }

  private broadcast(revision: number): void {
    const metadata = this.getMetadata();
    if (!metadata) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.authorizedUntil <= Date.now()) continue;
      const message: BoardSocketMessage = { type: "updated", revision, board: this.buildView(metadata, attachment.viewer, false), events: this.eventsSince(attachment.lastRevision) };
      attachment.lastRevision = revision;
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify(message));
    }
  }

  private async rescheduleAlarm(): Promise<void> {
    const now = Date.now();
    const lease = this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(lease_expires_at) AS due FROM assignments WHERE status = 'active'").one().due;
    const reconcile = this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(next_reconcile_at) AS due FROM pr_snapshots").one().due;
    let socketDue: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment && (socketDue === null || attachment.authorizedUntil < socketDue)) socketDue = attachment.authorizedUntil;
    }
    const candidates = [lease, reconcile, socketDue].filter((value): value is number => value !== null && value > now);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }
}

class BoardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: { ownerLogin?: string; leaseExpiresAt?: number },
  ) {
    super(message);
    this.name = "BoardError";
  }
}

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function failure<T>(
  code: string,
  message: string,
  status: number,
  currentRevision?: number,
  details: { ownerLogin?: string; leaseExpiresAt?: number } = {},
): RpcResult<T> {
  return { ok: false, error: { code, message, status, ...(currentRevision === undefined ? {} : { currentRevision }), ...details } };
}

function parseStats(value: string): AgentStats {
  return JSON.parse(value) as AgentStats;
}

function assignmentView(row: AssignmentRow, viewerUserId: string | null): AssignmentView {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    userId: row.user_id,
    userLogin: row.user_login,
    agentLabel: row.agent_label,
    claimedAt: row.claimed_at,
    lastActivityAt: row.last_activity_at,
    leaseExpiresAt: row.lease_expires_at,
    phase: row.phase,
    summary: row.summary,
    stats: parseStats(row.stats_json),
    isMine: row.user_id === viewerUserId,
  };
}

function eventView(row: { id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }): TaskEvent {
  return { id: row.id, revision: row.revision, type: row.event_type, taskId: row.task_id, actorLogin: row.actor_login, at: row.occurred_at, data: JSON.parse(row.data_json) as TaskEvent["data"] };
}

function systemViewer(): Viewer {
  return { userId: null, login: null, avatarUrl: null, roleName: null, canMutate: false };
}
