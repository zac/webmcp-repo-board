import { DurableObject } from "cloudflare:workers";
import {
  TransitionError,
  assertClaimAllowed,
  canArchive,
  canCancel,
  columnForPullRequest,
  taskReferenceCandidate,
  TASK_REFERENCE_CAPACITY,
  type Actor,
  type AgentPhase,
  type AgentStats,
  type AssignmentFocus,
  type AssignmentKind,
  type AssignmentView,
  type BoardSocketMessage,
  type BoardView,
  type ClientIdentity,
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

const RECONCILE_MS = 5 * 60 * 1_000;
const MAX_TASKS = 200;
const MAX_TOTAL_TASKS = 1_000;
const MAX_RECEIPTS = 2_000;
const MAX_HISTORY_ROWS = 5_000;
const ACTION_RECEIPT_MS = 24 * 60 * 60 * 1_000;
const WEBHOOK_RECEIPT_MS = 7 * 24 * 60 * 60 * 1_000;

interface BoardMetadata {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  repositoryId: number;
  installationId: number;
  htmlUrl: string;
  isPrivate: boolean;
}

interface TaskRow extends Record<string, SqlStorageValue> {
  id: string;
  task_reference: string;
  title: string;
  description: string;
  column_name: TaskColumn;
  archived_at: number | null;
  resolution: "completed" | "canceled" | null;
  resolution_reason: string | null;
  resolved_at: number | null;
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
  focus: AssignmentFocus;
  user_id: string;
  user_login: string;
  agent_label: string;
  status: string;
  claimed_at: number;
  last_activity_at: number;
  lease_expires_at: number;
  client_id: string;
  capability_hash: string;
  last_seen_at: number;
  phase: AgentPhase;
  summary: string;
  stats_json: string;
}

interface SocketAttachment {
  viewer: Viewer;
  clientId: string;
  authorizedUntil: number;
  lastRevision: number;
}

interface LinkedPullRequest {
  taskId: string;
  number: number;
  generation: number;
}

export class RepositoryBoard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  async initialize(metadata: BoardMetadata): Promise<void> {
    const existing = this.getMetadata();
    if (existing) {
      if (!boardIdentityMatches(existing, metadata)) {
        throw new Error("Board identity cannot change");
      }
      const accessChanged = existing.isPrivate !== metadata.isPrivate;
      this.ctx.storage.sql.exec(
        "UPDATE board_metadata SET repository_id = ?, installation_id = ?, html_url = ?, is_private = ? WHERE id = ?",
        metadata.repositoryId,
        metadata.installationId,
        metadata.htmlUrl,
        metadata.isPrivate ? 1 : 0,
        metadata.id,
      );
      if (accessChanged) for (const socket of this.ctx.getWebSockets()) socket.close(4002, "Repository access changed");
      return;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO board_metadata (id, owner, repo, full_name, repository_id, installation_id, html_url, is_private, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      metadata.id,
      metadata.owner,
      metadata.repo,
      metadata.fullName,
      metadata.repositoryId,
      metadata.installationId,
      metadata.htmlUrl,
      metadata.isPrivate ? 1 : 0,
    );
  }

  async getView(viewer: Viewer, includeArchived = false, clientId: string | null = null): Promise<RpcResult<BoardView>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);
    return success(this.buildView(metadata, viewer, includeArchived, clientId));
  }

  async execute(actor: Actor, viewer: Viewer, client: ClientIdentity, envelope: CommandEnvelope<InternalBoardCommand>, now: number): Promise<RpcResult<BoardView>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);

    const processed = this.ctx.storage.sql
      .exec<{ actor_user_id: string; processed_at: number }>("SELECT actor_user_id, processed_at FROM processed_actions WHERE action_id = ?", envelope.actionId)
      .toArray()[0];
    if (processed) {
      if (processed.actor_user_id !== actor.userId) return failure("action_owner_mismatch", "Action ID was already used by another user", 409);
      if (processed.processed_at >= now - ACTION_RECEIPT_MS) return success(this.buildView(metadata, viewer, false, client.id));
      this.ctx.storage.sql.exec("DELETE FROM processed_actions WHERE action_id = ?", envelope.actionId);
    }

    const currentRevision = this.currentRevision();
    if (envelope.expectedRevision !== currentRevision) {
      if (envelope.command.type === "claim_task") {
        const active = this.activeAssignment(envelope.command.taskId);
        if (active) {
          return failure(
            "assignment_conflict",
            `${active.agent_label} owned by @${active.user_login} has this task until it is released or explicitly taken over`,
            409,
            currentRevision,
            { ownerLogin: active.user_login, ownerAgentLabel: active.agent_label },
          );
        }
      }
      return failure("stale_revision", "Board changed before this command was applied", 409, currentRevision);
    }

    try {
      let result!: RpcResult<BoardView>;
      this.ctx.storage.transactionSync(() => {
        const event = this.applyCommand(metadata, actor, client, envelope.command, now, currentRevision + 1);
        this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", currentRevision + 1, metadata.id);
        this.insertEvent(currentRevision + 1, event.type, event.taskId, actor.login, now, event.data);
        result = success(this.buildView(metadata, viewer, false, client.id));
        this.ctx.storage.sql.exec(
          "INSERT INTO processed_actions (action_id, actor_user_id, revision, processed_at) VALUES (?, ?, ?, ?)",
          envelope.actionId,
          actor.userId,
          currentRevision + 1,
          now,
        );
        this.compactStorage(now);
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
    this.ctx.storage.sql.exec("DELETE FROM processed_webhooks WHERE processed_at < ?", now - WEBHOOK_RECEIPT_MS);
    const seen = this.ctx.storage.sql.exec<{ delivery_id: string }>("SELECT delivery_id FROM processed_webhooks WHERE delivery_id = ?", deliveryId).toArray()[0];
    if (seen) return false;
    this.ctx.storage.sql.exec("INSERT INTO processed_webhooks (delivery_id, processed_at) VALUES (?, ?)", deliveryId, now);
    this.ctx.storage.sql.exec("DELETE FROM processed_webhooks WHERE delivery_id NOT IN (SELECT delivery_id FROM processed_webhooks ORDER BY processed_at DESC LIMIT ?)", MAX_RECEIPTS);
    return true;
  }

  async reservePullRequestRefresh(taskId: string): Promise<RpcResult<LinkedPullRequest>> {
    const row = this.ctx.storage.sql.exec<{ task_id: string; pr_number: number; refresh_generation: number }>(
      `SELECT pr.task_id, pr.pr_number, pr.refresh_generation
       FROM pr_snapshots pr JOIN tasks task ON task.id = pr.task_id
       WHERE pr.task_id = ? AND task.archived_at IS NULL`,
      taskId,
    ).toArray()[0];
    if (!row) return failure("pull_request_not_linked", "Task has no linked pull request", 404);
    const generation = row.refresh_generation + 1;
    this.ctx.storage.sql.exec("UPDATE pr_snapshots SET refresh_generation = ? WHERE task_id = ?", generation, taskId);
    return success({ taskId, number: row.pr_number, generation });
  }

  async reservePullRequestRefreshes(numbers: number[] | null, now: number, limit = 25): Promise<LinkedPullRequest[]> {
    const boundedLimit = Math.max(1, Math.min(25, limit));
    const requested = numbers ? [...new Set(numbers)].slice(0, 20) : null;
    if (requested && requested.length === 0) return [];
    const placeholders = requested?.map(() => "?").join(", ");
    const rows = this.ctx.storage.sql.exec<{ task_id: string; pr_number: number; refresh_generation: number }>(
      `SELECT pr.task_id, pr.pr_number, pr.refresh_generation
       FROM pr_snapshots pr JOIN tasks task ON task.id = pr.task_id
       WHERE task.archived_at IS NULL AND ${requested ? `pr.pr_number IN (${placeholders})` : "(pr.reconcile_due = 1 OR pr.next_reconcile_at <= ?)"}
       ORDER BY pr.failure_count, pr.next_reconcile_at, pr.task_id LIMIT ?`,
      ...(requested ?? [now]),
      boundedLimit,
    ).toArray();
    return this.ctx.storage.transactionSync(() => rows.map((row) => {
      const generation = row.refresh_generation + 1;
      this.ctx.storage.sql.exec("UPDATE pr_snapshots SET refresh_generation = ?, reconcile_due = 0 WHERE task_id = ?", generation, row.task_id);
      return { taskId: row.task_id, number: row.pr_number, generation };
    }));
  }

  async applyPullRequest(snapshot: PullRequestSnapshot, source: string, now: number, generation: number): Promise<RpcResult<BoardView | null>> {
    const metadata = this.getMetadata();
    if (!metadata) return failure("board_not_initialized", "Board has not been initialized", 404);
    const task = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE linked_pr_number = ?", snapshot.number).toArray()[0];
    if (!task || task.archived_at !== null) return success(null);

    const existing = this.ctx.storage.sql.exec<{ snapshot_json: string; applied_generation: number }>("SELECT snapshot_json, applied_generation FROM pr_snapshots WHERE task_id = ?", task.id).toArray()[0];
    if (!existing) return failure("pull_request_state_missing", "Linked pull request state is missing", 500);
    const previous = JSON.parse(existing.snapshot_json) as PullRequestSnapshot;
    if (generation <= existing.applied_generation) return success(null);
    const nextColumn = columnForPullRequest(snapshot);
    const materiallyChanged = !previous || JSON.stringify({ ...previous, syncedAt: 0 }) !== JSON.stringify({ ...snapshot, syncedAt: 0 }) || task.column_name !== nextColumn;

    const revision = this.currentRevision() + (materiallyChanged ? 1 : 0);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE pr_snapshots SET pr_number = ?, snapshot_json = ?, next_reconcile_at = ?, reconcile_due = 0,
         applied_generation = ?, failure_count = 0 WHERE task_id = ?`,
        snapshot.number,
        JSON.stringify(snapshot),
        now + RECONCILE_MS,
        generation,
        task.id,
      );
      if (!materiallyChanged) return;
      this.ctx.storage.sql.exec(
        `UPDATE tasks SET column_name = ?, resolution = ?, resolution_reason = NULL, resolved_at = ?,
         updated_at = ?, task_revision = ? WHERE id = ?`,
        nextColumn,
        nextColumn === "done" ? "completed" : null,
        nextColumn === "done" ? now : null,
        now,
        revision,
        task.id,
      );
      if (nextColumn === "done") {
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'completed', last_activity_at = ? WHERE task_id = ? AND status = 'active'", now, task.id);
      }
      this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", revision, metadata.id);
      this.insertEvent(revision, snapshot.merged ? "pull_request_merged" : snapshot.state === "closed" ? "pull_request_closed" : "pull_request_updated", task.id, "github", now, { source, pullRequest: snapshot.number, column: nextColumn });
      this.compactStorage(now);
    });
    if (!materiallyChanged) {
      await this.rescheduleAlarm();
      return success(null);
    }
    this.broadcast(revision);
    await this.rescheduleAlarm();
    return success(this.buildView(metadata, systemViewer(), false, null));
  }

  async recordPullRequestRefreshFailure(taskId: string, generation: number, now: number): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ applied_generation: number; failure_count: number }>(
      "SELECT applied_generation, failure_count FROM pr_snapshots WHERE task_id = ?",
      taskId,
    ).toArray()[0];
    if (!row || generation <= row.applied_generation) return;
    const failureCount = Math.min(row.failure_count + 1, 6);
    this.ctx.storage.sql.exec(
      "UPDATE pr_snapshots SET failure_count = ?, next_reconcile_at = ?, reconcile_due = 0 WHERE task_id = ?",
      failureCount,
      now + RECONCILE_MS,
      taskId,
    );
    await this.rescheduleAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const viewerHeader = request.headers.get("x-board-viewer");
    const clientId = request.headers.get("x-board-client-id");
    const authorizedUntil = Number(request.headers.get("x-board-authorized-until"));
    const lastRevision = Number(new URL(request.url).searchParams.get("revision") ?? "0");
    if (!viewerHeader || !clientId || !Number.isFinite(authorizedUntil)) return new Response("Unauthorized", { status: 401 });
    const viewer = JSON.parse(viewerHeader) as Viewer;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { viewer, clientId, authorizedUntil, lastRevision };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    this.markClientSeen(clientId, Date.now());

    const metadata = this.getMetadata();
    if (metadata) {
      const revision = this.currentRevision();
      const message: BoardSocketMessage = {
        type: "snapshot",
        revision,
        board: this.buildView(metadata, viewer, false, clientId),
        events: this.eventsSince(lastRevision),
      };
      server.send(JSON.stringify(message));
      this.broadcast(revision, server);
    }
    await this.rescheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    void message;
    ws.close(1008, "Client messages are not supported");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) {
      attachment.authorizedUntil = 0;
      ws.serializeAttachment(attachment);
      this.markClientSeen(attachment.clientId, Date.now());
    }
    ws.close(code, reason);
    if (attachment) this.broadcast(this.currentRevision());
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const metadata = this.getMetadata();
    if (!metadata) return;
    const duePullRequests = this.ctx.storage.sql.exec<{ task_id: string }>(
      `SELECT pr.task_id FROM pr_snapshots pr JOIN tasks task ON task.id = pr.task_id
       WHERE task.archived_at IS NULL AND pr.next_reconcile_at <= ?`,
      now,
    ).toArray();

    let revision: number | null = null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE pr_snapshots SET reconcile_due = 1, next_reconcile_at = ?
         WHERE task_id IN (SELECT pr.task_id FROM pr_snapshots pr JOIN tasks task ON task.id = pr.task_id
         WHERE task.archived_at IS NULL AND pr.next_reconcile_at <= ?)`,
        now + RECONCILE_MS,
        now,
      );
      if (duePullRequests.length === 0) return;
      revision = this.currentRevision() + 1;
      this.ctx.storage.sql.exec("UPDATE board_metadata SET revision = ? WHERE id = ?", revision, metadata.id);
      for (const pullRequest of duePullRequests) {
        this.insertEvent(revision, "pull_request_reconciliation_due", pullRequest.task_id, "system", now, {});
      }
      this.compactStorage(now);
    });

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.authorizedUntil <= now) socket.close(4001, "Authorization expired");
    }

    if (revision !== null) this.broadcast(revision);
    await this.rescheduleAlarm();
  }

  private applyCommand(metadata: BoardMetadata, actor: Actor, client: ClientIdentity, command: InternalBoardCommand, now: number, revision: number): { type: string; taskId: string | null; data: Record<string, string | number | boolean | null> } {
    switch (command.type) {
      case "create_task": {
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NULL").one().count;
        if (count >= MAX_TASKS) throw new BoardError("task_limit", "Board already has the maximum number of active tasks", 409);
        const totalCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM tasks").one().count;
        if (totalCount >= MAX_TOTAL_TASKS) throw new BoardError("task_history_limit", "Board task history is full", 409);
        const taskId = crypto.randomUUID();
        const taskReference = this.allocateTaskReference(taskId);
        this.ctx.storage.sql.exec(
          `INSERT INTO tasks (id, task_reference, title, description, column_name, archived_at, created_by, created_at, updated_at, task_revision, latest_plan_revision, linked_pr_number)
           VALUES (?, ?, ?, ?, 'todo', NULL, ?, ?, ?, ?, 0, NULL)`,
          taskId,
          taskReference,
          command.title,
          command.description,
          actor.login,
          now,
          now,
          revision,
        );
        this.insertTaskRevision(taskId, revision, command.title, command.description, actor, now);
        return { type: "task_created", taskId, data: { title: command.title, reference: taskReference } };
      }
      case "edit_task": {
        const task = this.requireTask(command.taskId);
        if (task.column_name !== "todo" || task.archived_at !== null) throw new BoardError("task_not_editable", "Only active Todo tasks can be edited", 409);
        if (this.activeAssignment(task.id)) throw new BoardError("task_assigned", "Release the planning assignment before editing this task", 409);
        this.ctx.storage.sql.exec("UPDATE tasks SET title = ?, description = ?, updated_at = ?, task_revision = ? WHERE id = ?", command.title, command.description, now, revision, task.id);
        this.insertTaskRevision(task.id, revision, command.title, command.description, actor, now);
        return { type: "task_edited", taskId: task.id, data: { title: command.title } };
      }
      case "claim_task": {
        const task = this.requireTask(command.taskId);
        assertClaimAllowed(task.column_name, command.kind, task.archived_at);
        const focus = command.focus ?? (command.kind === "planning" ? "planning" : "implementation");
        if (command.kind === "planning" && focus !== "planning") throw new BoardError("invalid_assignment_focus", "Planning assignments require planning focus", 409);
        if (command.kind === "implementation" && focus === "planning") throw new BoardError("invalid_assignment_focus", "Implementation assignments cannot use planning focus", 409);
        if (task.column_name !== "in_pr" && command.kind === "implementation" && focus !== "implementation") {
          throw new BoardError("invalid_assignment_focus", "Specialized implementation focus is available only for In PR tasks", 409);
        }
        const active = this.activeAssignment(task.id);
        if (active) throw new BoardError(
          "assignment_conflict",
          `${active.agent_label} owned by @${active.user_login} has this task until it is released or explicitly taken over`,
          409,
          { ownerLogin: active.user_login, ownerAgentLabel: active.agent_label },
        );
        const currentClientAssignment = this.activeAssignmentForClient(actor.userId, client.id);
        if (currentClientAssignment) throw new BoardError("client_already_assigned", "This browser tab already owns another task. Release or complete it before claiming more work", 409);
        const assignmentId = crypto.randomUUID();
        const phase: AgentPhase = focus === "planning" ? "planning"
          : focus === "review_feedback" ? "reviewing"
            : focus === "fix_checks" || focus === "merge_preparation" ? "testing"
              : "investigating";
        this.ctx.storage.sql.exec(
          `INSERT INTO assignments (
             id, task_id, kind, focus, user_id, user_login, agent_label, status,
             claimed_at, last_activity_at, lease_expires_at, client_id, capability_hash, last_seen_at,
             phase, summary, stats_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, '', '{}')`,
          assignmentId,
          task.id,
          command.kind,
          focus,
          actor.userId,
          actor.login,
          command.agentLabel,
          now,
          now,
          client.id,
          client.capabilityHash,
          now,
          phase,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, task.id);
        return { type: "task_claimed", taskId: task.id, data: { assignmentId, kind: command.kind, focus, agentLabel: command.agentLabel } };
      }
      case "take_over_task": {
        const task = this.requireTask(command.taskId);
        const former = this.activeAssignment(task.id);
        if (!former || former.id !== command.assignmentId) throw new BoardError("assignment_changed", "The assignment changed before takeover was confirmed", 409);
        if (former.client_id === client.id && former.capability_hash === client.capabilityHash) {
          throw new BoardError("assignment_already_owned", "This browser tab already owns the assignment", 409);
        }
        const currentClientAssignment = this.activeAssignmentForClient(actor.userId, client.id);
        if (currentClientAssignment) throw new BoardError("client_already_assigned", "This browser tab already owns another task. Release or complete it before taking over more work", 409);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'superseded', last_activity_at = ? WHERE id = ?", now, former.id);
        const assignmentId = crypto.randomUUID();
        const phase: AgentPhase = former.focus === "planning" ? "planning"
          : former.focus === "review_feedback" ? "reviewing"
            : former.focus === "fix_checks" || former.focus === "merge_preparation" ? "testing"
              : "investigating";
        this.ctx.storage.sql.exec(
          `INSERT INTO assignments (
             id, task_id, kind, focus, user_id, user_login, agent_label, status,
             claimed_at, last_activity_at, lease_expires_at, client_id, capability_hash, last_seen_at,
             phase, summary, stats_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, '{}')`,
          assignmentId,
          task.id,
          former.kind,
          former.focus,
          actor.userId,
          actor.login,
          command.agentLabel,
          now,
          now,
          client.id,
          client.capabilityHash,
          now,
          phase,
          `Took over assignment: ${command.reason}`,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, task.id);
        return { type: "assignment_taken_over", taskId: task.id, data: { assignmentId, formerAssignmentId: former.id, reason: command.reason } };
      }
      case "report_progress": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client);
        this.updateAssignment(assignment.id, now, command.phase, command.summary, command.stats);
        this.ctx.storage.sql.exec(
          "INSERT INTO progress_reports (id, assignment_id, task_id, phase, summary, stats_json, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(), assignment.id, assignment.task_id, command.phase, command.summary, JSON.stringify(command.stats), now,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, assignment.task_id);
        return { type: "progress_reported", taskId: assignment.task_id, data: { phase: command.phase, summary: command.summary } };
      }
      case "set_plan": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client, "planning");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "todo") throw new BoardError("invalid_transition", "A plan can only be set on a Todo task", 409);
        const planRevision = task.latest_plan_revision + 1;
        this.insertPlan(task.id, planRevision, command.markdown, actor, now);
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'ready', latest_plan_revision = ?, updated_at = ?, task_revision = ? WHERE id = ?", planRevision, now, revision, task.id);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'completed', last_activity_at = ? WHERE id = ?", now, assignment.id);
        return { type: "plan_set", taskId: task.id, data: { planRevision, column: "ready" } };
      }
      case "set_plan_and_start_work": {
        const planningAssignment = this.requireAssignment(command.assignmentId, actor, client, "planning");
        const task = this.requireTask(planningAssignment.task_id);
        if (task.column_name !== "todo") throw new BoardError("invalid_transition", "A plan can only be set and started on a Todo task", 409);
        const planRevision = task.latest_plan_revision + 1;
        const implementationAssignmentId = crypto.randomUUID();
        this.insertPlan(task.id, planRevision, command.markdown, actor, now);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'completed', last_activity_at = ? WHERE id = ?", now, planningAssignment.id);
        this.ctx.storage.sql.exec(
          `INSERT INTO assignments (
             id, task_id, kind, focus, user_id, user_login, agent_label, status,
             claimed_at, last_activity_at, lease_expires_at, client_id, capability_hash, last_seen_at,
             phase, summary, stats_json
           ) VALUES (?, ?, 'implementation', 'implementation', ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, 'implementing', 'Implementation started', '{}')`,
          implementationAssignmentId,
          task.id,
          actor.userId,
          actor.login,
          planningAssignment.agent_label,
          now,
          now,
          planningAssignment.client_id,
          planningAssignment.capability_hash,
          now,
        );
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'in_progress', latest_plan_revision = ?, updated_at = ?, task_revision = ? WHERE id = ?", planRevision, now, revision, task.id);
        this.insertEvent(revision, "plan_set", task.id, actor.login, now, { planRevision, column: "ready" });
        return { type: "work_started", taskId: task.id, data: { assignmentId: implementationAssignmentId, planRevision, column: "in_progress" } };
      }
      case "update_plan": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "ready") throw new BoardError("invalid_transition", "An implementation agent can update a plan only while the task is Ready", 409);
        const planRevision = task.latest_plan_revision + 1;
        this.insertPlan(task.id, planRevision, command.markdown, actor, now);
        this.updateAssignment(assignment.id, now, "planning", "Updated the delegated plan", parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET latest_plan_revision = ?, updated_at = ?, task_revision = ? WHERE id = ?", planRevision, now, revision, task.id);
        return { type: "plan_updated", taskId: task.id, data: { planRevision } };
      }
      case "start_work": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "ready" || task.latest_plan_revision < 1) throw new BoardError("invalid_transition", "Only a Ready task with a plan can start work", 409);
        this.updateAssignment(assignment.id, now, "implementing", "Implementation started", parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'in_progress', updated_at = ?, task_revision = ? WHERE id = ?", now, revision, task.id);
        return { type: "work_started", taskId: task.id, data: { column: "in_progress" } };
      }
      case "release_task": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client);
        this.ctx.storage.sql.exec("UPDATE assignments SET status = 'released', last_activity_at = ? WHERE id = ?", now, assignment.id);
        this.ctx.storage.sql.exec("UPDATE tasks SET updated_at = ?, task_revision = ? WHERE id = ?", now, revision, assignment.task_id);
        return { type: "task_released", taskId: assignment.task_id, data: { assignmentId: assignment.id } };
      }
      case "link_pull_request_snapshot": {
        const assignment = this.requireAssignment(command.assignmentId, actor, client, "implementation");
        const task = this.requireTask(assignment.task_id);
        if (task.column_name !== "in_progress") throw new BoardError("invalid_transition", "A pull request can be linked only while work is in progress", 409);
        if (command.snapshot.state !== "open" || command.snapshot.merged) throw new BoardError("pull_request_not_open", "The linked pull request must be open", 409);
        this.updateAssignment(assignment.id, now, "waiting", `Linked PR #${command.snapshot.number}`, parseStats(assignment.stats_json));
        this.ctx.storage.sql.exec("UPDATE tasks SET column_name = 'in_pr', linked_pr_number = ?, updated_at = ?, task_revision = ? WHERE id = ?", command.snapshot.number, now, revision, task.id);
        this.ctx.storage.sql.exec(
          `INSERT INTO pr_snapshots (
             task_id, pr_number, snapshot_json, next_reconcile_at, reconcile_due,
             refresh_generation, applied_generation, failure_count
           ) VALUES (?, ?, ?, ?, 0, 0, 0, 0)`,
          task.id,
          command.snapshot.number,
          JSON.stringify(command.snapshot),
          now + RECONCILE_MS,
        );
        return { type: "pull_request_linked", taskId: task.id, data: { pullRequest: command.snapshot.number, column: "in_pr" } };
      }
      case "archive_task": {
        const task = this.requireTask(command.taskId);
        if (!canArchive(task.column_name, task.archived_at, task.resolution, task.resolved_at)) {
          throw new BoardError("task_not_archivable", "Only completed, unarchived Done tasks can be archived", 409);
        }
        this.ctx.storage.sql.exec("UPDATE tasks SET archived_at = ?, updated_at = ?, task_revision = ? WHERE id = ?", now, now, revision, task.id);
        return { type: "task_archived", taskId: task.id, data: { archived: true } };
      }
      case "cancel_task": {
        const task = this.requireTask(command.taskId);
        if (!canCancel(task.column_name, task.archived_at)) {
          const message = task.column_name === "in_pr"
            ? "Close the linked pull request before canceling this task"
            : "Only an active Todo, Ready, or In Progress task can be canceled";
          throw new BoardError("task_not_cancelable", message, 409);
        }
        this.ctx.storage.sql.exec(
          "UPDATE assignments SET status = 'canceled', last_activity_at = ? WHERE task_id = ? AND status = 'active'",
          now,
          task.id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE tasks SET resolution = 'canceled', resolution_reason = ?, resolved_at = ?, archived_at = ?,
           updated_at = ?, task_revision = ? WHERE id = ?`,
          command.reason,
          now,
          now,
          now,
          revision,
          task.id,
        );
        return { type: "task_canceled", taskId: task.id, data: { archived: true, reason: command.reason } };
      }
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS board_metadata (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, full_name TEXT NOT NULL,
        repository_id INTEGER NOT NULL, installation_id INTEGER NOT NULL,
        html_url TEXT NOT NULL, is_private INTEGER NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, task_reference TEXT NOT NULL UNIQUE CHECK(task_reference != ''),
        title TEXT NOT NULL, description TEXT NOT NULL, column_name TEXT NOT NULL,
        archived_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        task_revision INTEGER NOT NULL, latest_plan_revision INTEGER NOT NULL, linked_pr_number INTEGER,
        resolution TEXT, resolution_reason TEXT, resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_name, archived_at);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_linked_pr_idx ON tasks(linked_pr_number) WHERE linked_pr_number IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS tasks_reference_immutable BEFORE UPDATE OF task_reference ON tasks
      WHEN OLD.task_reference IS NOT NEW.task_reference
      BEGIN SELECT RAISE(ABORT, 'task_reference is immutable'); END;
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
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, focus TEXT NOT NULL,
        user_id TEXT NOT NULL, user_login TEXT NOT NULL,
        agent_label TEXT NOT NULL, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL, client_id TEXT NOT NULL DEFAULT '', capability_hash TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL, summary TEXT NOT NULL, stats_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assignments_active_idx ON assignments(task_id, status);
      CREATE TABLE IF NOT EXISTS progress_reports (
        id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, task_id TEXT NOT NULL, phase TEXT NOT NULL,
        summary TEXT NOT NULL, stats_json TEXT NOT NULL, reported_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pr_snapshots (
        task_id TEXT PRIMARY KEY, pr_number INTEGER NOT NULL UNIQUE, snapshot_json TEXT NOT NULL,
        next_reconcile_at INTEGER NOT NULL, reconcile_due INTEGER NOT NULL,
        refresh_generation INTEGER NOT NULL, applied_generation INTEGER NOT NULL, failure_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, event_type TEXT NOT NULL, task_id TEXT,
        actor_login TEXT, occurred_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_revision_idx ON events(revision);
      CREATE TABLE IF NOT EXISTS processed_actions (
        action_id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, revision INTEGER NOT NULL, processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        delivery_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL
      );
    `);
    const assignmentColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(assignments)").toArray().map((column) => column.name));
    if (!assignmentColumns.has("client_id")) this.ctx.storage.sql.exec("ALTER TABLE assignments ADD COLUMN client_id TEXT NOT NULL DEFAULT ''");
    if (!assignmentColumns.has("capability_hash")) this.ctx.storage.sql.exec("ALTER TABLE assignments ADD COLUMN capability_hash TEXT NOT NULL DEFAULT ''");
    if (!assignmentColumns.has("last_seen_at")) this.ctx.storage.sql.exec("ALTER TABLE assignments ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec("UPDATE assignments SET status = 'expired' WHERE status = 'active' AND lease_expires_at > 0 AND lease_expires_at <= ?", Date.now());
    this.ctx.storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS assignments_one_active_idx ON assignments(task_id) WHERE status = 'active'");
    this.ctx.storage.sql.exec("DROP INDEX IF EXISTS assignments_one_client_idx");
    this.ctx.storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS assignments_one_user_client_idx ON assignments(user_id, client_id) WHERE status = 'active' AND client_id != ''");
  }

  private getMetadata(): BoardMetadata | null {
    const row = this.ctx.storage.sql.exec<{ id: string; owner: string; repo: string; full_name: string; repository_id: number; installation_id: number; html_url: string; is_private: number }>("SELECT id, owner, repo, full_name, repository_id, installation_id, html_url, is_private FROM board_metadata LIMIT 1").toArray()[0];
    return row ? {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      fullName: row.full_name,
      repositoryId: row.repository_id,
      installationId: row.installation_id,
      htmlUrl: row.html_url,
      isPrivate: Boolean(row.is_private),
    } : null;
  }

  private currentRevision(): number {
    return this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM board_metadata LIMIT 1").toArray()[0]?.revision ?? 0;
  }

  private requireTask(taskId: string): TaskRow {
    const task = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId).toArray()[0];
    if (!task) throw new BoardError("task_not_found", "Task was not found", 404);
    return task;
  }

  private allocateTaskReference(taskId: string): string {
    for (let attempt = 0; attempt < TASK_REFERENCE_CAPACITY; attempt += 1) {
      const candidate = taskReferenceCandidate(taskId, attempt);
      const existing = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM tasks WHERE task_reference = ?", candidate).toArray()[0];
      if (!existing) return candidate;
    }
    throw new BoardError("task_reference_exhausted", "This board has no remaining task references", 409);
  }

  private activeAssignment(taskId: string): AssignmentRow | null {
    return this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE task_id = ? AND status = 'active' ORDER BY claimed_at DESC LIMIT 1", taskId).toArray()[0] ?? null;
  }

  private activeAssignmentForClient(userId: string, clientId: string): AssignmentRow | null {
    return this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE user_id = ? AND client_id = ? AND status = 'active' LIMIT 1", userId, clientId).toArray()[0] ?? null;
  }

  private requireAssignment(assignmentId: string, actor: Actor, client: ClientIdentity, kind?: AssignmentKind): AssignmentRow {
    const assignment = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE id = ?", assignmentId).toArray()[0];
    if (!assignment) throw new BoardError("assignment_not_found", "Assignment was not found", 404);
    if (assignment.user_id !== actor.userId) throw new BoardError("assignment_owner_mismatch", "Assignment belongs to another GitHub user", 403);
    if (assignment.status !== "active") throw new BoardError("assignment_inactive", "Assignment is no longer active", 409);
    if (assignment.client_id !== client.id || assignment.capability_hash !== client.capabilityHash) {
      throw new BoardError("assignment_client_mismatch", "Assignment belongs to another browser tab. Take it over explicitly to continue here", 409);
    }
    if (kind && assignment.kind !== kind) throw new BoardError("wrong_assignment_kind", `This command requires a ${kind} assignment`, 409);
    return assignment;
  }

  private updateAssignment(id: string, now: number, phase: AgentPhase, summary: string, stats: AgentStats): void {
    this.ctx.storage.sql.exec(
      "UPDATE assignments SET last_activity_at = ?, phase = ?, summary = ?, stats_json = ? WHERE id = ?",
      now,
      phase,
      summary,
      JSON.stringify(stats),
      id,
    );
  }

  private markClientSeen(clientId: string, now: number): void {
    this.ctx.storage.sql.exec("UPDATE assignments SET last_seen_at = ? WHERE client_id = ? AND status = 'active'", now, clientId);
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

  private compactStorage(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM processed_actions WHERE processed_at < ?", now - ACTION_RECEIPT_MS);
    this.ctx.storage.sql.exec("DELETE FROM processed_actions WHERE action_id NOT IN (SELECT action_id FROM processed_actions ORDER BY processed_at DESC LIMIT ?)", MAX_RECEIPTS);
    this.ctx.storage.sql.exec("DELETE FROM processed_webhooks WHERE processed_at < ?", now - WEBHOOK_RECEIPT_MS);
    this.ctx.storage.sql.exec("DELETE FROM processed_webhooks WHERE delivery_id NOT IN (SELECT delivery_id FROM processed_webhooks ORDER BY processed_at DESC LIMIT ?)", MAX_RECEIPTS);
    this.ctx.storage.sql.exec("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)", MAX_HISTORY_ROWS);
    this.ctx.storage.sql.exec("DELETE FROM progress_reports WHERE id NOT IN (SELECT id FROM progress_reports ORDER BY reported_at DESC LIMIT ?)", MAX_HISTORY_ROWS);
    this.ctx.storage.sql.exec("DELETE FROM assignments WHERE status != 'active' AND id NOT IN (SELECT id FROM assignments WHERE status != 'active' ORDER BY last_activity_at DESC LIMIT ?)", MAX_HISTORY_ROWS);
    this.ctx.storage.sql.exec("DELETE FROM task_revisions WHERE (task_id, revision) NOT IN (SELECT task_id, revision FROM task_revisions ORDER BY created_at DESC LIMIT ?)", MAX_HISTORY_ROWS);
    this.ctx.storage.sql.exec(
      `DELETE FROM plan_revisions WHERE (task_id, revision) NOT IN (
         SELECT task_id, revision FROM plan_revisions ORDER BY created_at DESC LIMIT ?
       ) AND (task_id, revision) NOT IN (
         SELECT id, latest_plan_revision FROM tasks WHERE latest_plan_revision > 0
       )`,
      MAX_HISTORY_ROWS,
    );
  }

  private buildView(metadata: BoardMetadata, viewer: Viewer, includeArchived: boolean, clientId: string | null): BoardView {
    const connectedClients = this.connectedClientIds();
    const tasks = this.ctx.storage.sql
      .exec<TaskRow>(`SELECT * FROM tasks ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at ASC LIMIT ?`, MAX_TASKS)
      .toArray()
      .map((task) => this.buildTaskView(task, viewer, clientId, connectedClients));
    const archivedTaskCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NOT NULL")
      .one().count;
    return {
      id: metadata.id,
      owner: metadata.owner,
      repo: metadata.repo,
      fullName: metadata.fullName,
      htmlUrl: metadata.htmlUrl,
      isPrivate: metadata.isPrivate,
      materialized: true,
      revision: this.currentRevision(),
      viewer,
      archivedTaskCount,
      tasks,
    };
  }

  private buildTaskView(task: TaskRow, viewer: Viewer, clientId: string | null, connectedClients: Set<string>): TaskView {
    const assignment = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE task_id = ? AND status = 'active' ORDER BY claimed_at DESC LIMIT 1", task.id).toArray()[0];
    const planRow = task.latest_plan_revision > 0
      ? this.ctx.storage.sql.exec<{ revision: number; markdown: string; author_user_id: string; author_login: string; created_at: number }>("SELECT revision, markdown, author_user_id, author_login, created_at FROM plan_revisions WHERE task_id = ? AND revision = ?", task.id, task.latest_plan_revision).toArray()[0]
      : undefined;
    const prRow = this.ctx.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM pr_snapshots WHERE task_id = ?", task.id).toArray()[0];
    return {
      id: task.id,
      reference: task.task_reference,
      title: task.title,
      description: task.description,
      column: task.column_name,
      archivedAt: task.archived_at,
      resolution: task.resolution,
      resolutionReason: task.resolution_reason,
      resolvedAt: task.resolved_at,
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
      assignment: assignment ? assignmentView(assignment, viewer.userId, clientId, connectedClients.has(assignment.client_id)) : null,
      pullRequest: prRow ? JSON.parse(prRow.snapshot_json) as PullRequestSnapshot : null,
      recentEvents: this.ctx.storage.sql.exec<{ id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }>("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 20", task.id).toArray().map(eventView),
    };
  }

  private eventsSince(revision: number): TaskEvent[] {
    return this.ctx.storage.sql.exec<{ id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }>("SELECT * FROM events WHERE revision > ? ORDER BY id ASC LIMIT 100", revision).toArray().map(eventView);
  }

  private broadcast(revision: number, excludedSocket?: WebSocket): void {
    const metadata = this.getMetadata();
    if (!metadata) return;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.authorizedUntil <= Date.now()) continue;
      const message: BoardSocketMessage = { type: "updated", revision, board: this.buildView(metadata, attachment.viewer, false, attachment.clientId), events: this.eventsSince(attachment.lastRevision) };
      attachment.lastRevision = revision;
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify(message));
    }
  }

  private async rescheduleAlarm(): Promise<void> {
    const now = Date.now();
    const reconcile = this.ctx.storage.sql.exec<{ due: number | null }>(
      `SELECT MIN(pr.next_reconcile_at) AS due FROM pr_snapshots pr
       JOIN tasks task ON task.id = pr.task_id WHERE task.archived_at IS NULL`,
    ).one().due;
    let socketDue: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment && (socketDue === null || attachment.authorizedUntil < socketDue)) socketDue = attachment.authorizedUntil;
    }
    const candidates = [reconcile, socketDue].filter((value): value is number => value !== null && value > now);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private connectedClientIds(): Set<string> {
    const now = Date.now();
    const clients = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment && attachment.authorizedUntil > now && socket.readyState === WebSocket.OPEN) clients.add(attachment.clientId);
    }
    return clients;
  }
}

export function boardIdentityMatches(
  current: Pick<BoardMetadata, "fullName" | "repositoryId" | "installationId">,
  next: Pick<BoardMetadata, "fullName" | "repositoryId" | "installationId">,
): boolean {
  return current.fullName.toLowerCase() === next.fullName.toLowerCase()
    && current.repositoryId === next.repositoryId
    && current.installationId === next.installationId;
}

class BoardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: { ownerLogin?: string; ownerAgentLabel?: string },
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
  details: { ownerLogin?: string; ownerAgentLabel?: string } = {},
): RpcResult<T> {
  return { ok: false, error: { code, message, status, ...(currentRevision === undefined ? {} : { currentRevision }), ...details } };
}

function parseStats(value: string): AgentStats {
  return JSON.parse(value) as AgentStats;
}

function assignmentView(row: AssignmentRow, viewerUserId: string | null, clientId: string | null, connected: boolean): AssignmentView {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    focus: row.focus,
    userId: row.user_id,
    userLogin: row.user_login,
    agentLabel: row.agent_label,
    claimedAt: row.claimed_at,
    lastActivityAt: row.last_activity_at,
    lastSeenAt: row.last_seen_at || null,
    connected,
    phase: row.phase,
    summary: row.summary,
    stats: parseStats(row.stats_json),
    isMine: row.user_id === viewerUserId,
    isCurrentClient: Boolean(clientId) && row.user_id === viewerUserId && row.client_id === clientId,
  };
}

function eventView(row: { id: number; revision: number; event_type: string; task_id: string | null; actor_login: string | null; occurred_at: number; data_json: string }): TaskEvent {
  return { id: row.id, revision: row.revision, type: row.event_type, taskId: row.task_id, actorLogin: row.actor_login, at: row.occurred_at, data: JSON.parse(row.data_json) as TaskEvent["data"] };
}

function systemViewer(): Viewer {
  return { userId: null, login: null, avatarUrl: null, roleName: null, canMutate: false };
}
