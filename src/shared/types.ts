export const TASK_COLUMNS = ["todo", "ready", "in_progress", "in_pr", "done"] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

export const TASK_RESOLUTIONS = ["completed", "canceled"] as const;
export type TaskResolution = (typeof TASK_RESOLUTIONS)[number];

export const ASSIGNMENT_KINDS = ["planning", "implementation"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const ASSIGNMENT_FOCUSES = ["planning", "implementation", "review_feedback", "fix_checks", "merge_preparation"] as const;
export type AssignmentFocus = (typeof ASSIGNMENT_FOCUSES)[number];

export const AGENT_PHASES = ["investigating", "planning", "reviewing", "implementing", "testing", "waiting", "blocked"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export interface AgentStats {
  filesChanged?: number;
  commits?: number;
  testsPassed?: number;
  testsFailed?: number;
}

export interface Viewer {
  userId: string | null;
  login: string | null;
  avatarUrl: string | null;
  roleName: string | null;
  canMutate: boolean;
}

export interface AssignmentView {
  id: string;
  taskId: string;
  kind: AssignmentKind;
  focus: AssignmentFocus;
  userId: string;
  userLogin: string;
  agentLabel: string;
  claimedAt: number;
  lastActivityAt: number;
  leaseExpiresAt: number;
  phase: AgentPhase;
  summary: string;
  stats: AgentStats;
  isMine: boolean;
}

export interface PlanRevision {
  revision: number;
  markdown: string;
  authorUserId: string;
  authorLogin: string;
  createdAt: number;
  delegatedApproval: true;
}

export interface TaskRevision {
  revision: number;
  title: string;
  description: string;
  authorUserId: string;
  authorLogin: string;
  createdAt: number;
}

export interface ReviewDetail {
  id: number;
  reviewer: string;
  state: string;
  body: string;
  submittedAt: string | null;
  commitSha: string | null;
  url: string;
}

export interface LatestReview {
  reviewer: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
  submittedAt: string | null;
  commitSha: string | null;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  title: string;
  authorLogin: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headSha: string;
  baseRef: string;
  approvals: number;
  changesRequestedBy: string[];
  requestedReviewers: string[];
  latestReviews: LatestReview[];
  reviewRequirement: {
    requiredApprovals: number | null;
    decision: "approved" | "changes_requested" | "review_required" | null;
    codeOwnerReviewRequired: boolean | null;
    latestPushApprovalRequired: boolean | null;
  };
  mergeState: string | null;
  reviewCommentCount: number;
  conversationCommentCount: number;
  checks: {
    passed: number;
    failed: number;
    pending: number;
    failedNames: string[];
    pendingNames: string[];
  };
  recentReviews: ReviewDetail[];
  syncedAt: number;
}

export interface TaskEvent {
  id: number;
  revision: number;
  type: string;
  taskId: string | null;
  actorLogin: string | null;
  at: number;
  data: Record<string, string | number | boolean | null>;
}

export interface TaskView {
  id: string;
  reference: string;
  title: string;
  description: string;
  column: TaskColumn;
  archivedAt: number | null;
  resolution: TaskResolution | null;
  resolutionReason: string | null;
  resolvedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  revisions: TaskRevision[];
  plan: PlanRevision | null;
  assignment: AssignmentView | null;
  pullRequest: PullRequestSnapshot | null;
  recentEvents: TaskEvent[];
}

export interface BoardView {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  materialized: boolean;
  revision: number;
  viewer: Viewer;
  archivedTaskCount: number;
  tasks: TaskView[];
}

export interface BoardSummary {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
}

export interface CommandEnvelope<T = BoardCommand> {
  actionId: string;
  expectedRevision: number;
  command: T;
}

export type BoardCommand =
  | { type: "create_task"; title: string; description: string }
  | { type: "edit_task"; taskId: string; title: string; description: string }
  | { type: "claim_task"; taskId: string; kind: AssignmentKind; focus?: AssignmentFocus; agentLabel: string }
  | { type: "renew_assignment"; assignmentId: string }
  | { type: "report_progress"; assignmentId: string; phase: AgentPhase; summary: string; stats: AgentStats }
  | { type: "set_plan"; assignmentId: string; markdown: string }
  | { type: "set_plan_and_start_work"; assignmentId: string; markdown: string }
  | { type: "update_plan"; assignmentId: string; markdown: string }
  | { type: "start_work"; assignmentId: string }
  | { type: "release_task"; assignmentId: string }
  | { type: "link_pull_request"; assignmentId: string; url: string }
  | { type: "cancel_task"; taskId: string; reason: string }
  | { type: "archive_task"; taskId: string };

export type InternalBoardCommand = Exclude<BoardCommand, { type: "link_pull_request" }> |
  { type: "link_pull_request_snapshot"; assignmentId: string; snapshot: PullRequestSnapshot };

export interface Actor {
  userId: string;
  login: string;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: {
  code: string;
  message: string;
  status: number;
  currentRevision?: number;
  ownerLogin?: string;
  leaseExpiresAt?: number;
} };

export interface BoardSocketMessage {
  type: "snapshot" | "updated";
  revision: number;
  board: BoardView;
  events: TaskEvent[];
}
