import type { AssignmentKind, PullRequestSnapshot, TaskColumn } from "./types";

export class TransitionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export function requiredAssignmentKind(column: TaskColumn): AssignmentKind | null {
  if (column === "todo") return "planning";
  if (column === "ready" || column === "in_progress" || column === "in_pr") return "implementation";
  return null;
}

export function assertClaimAllowed(column: TaskColumn, kind: AssignmentKind, archivedAt: number | null): void {
  if (archivedAt !== null || column === "done") throw new TransitionError("task_not_claimable", "Done or archived tasks cannot be claimed");
  const required = requiredAssignmentKind(column);
  if (required !== kind) throw new TransitionError("wrong_assignment_kind", `${column} tasks require a ${required} assignment`);
}

export function columnForPullRequest(snapshot: PullRequestSnapshot): Extract<TaskColumn, "in_progress" | "in_pr" | "done"> {
  if (snapshot.merged) return "done";
  if (snapshot.state === "closed") return "in_progress";
  return "in_pr";
}

export function canArchive(
  column: TaskColumn,
  archivedAt: number | null,
  resolution: "completed" | "canceled" | null,
  resolvedAt: number | null,
): boolean {
  return column === "done" && archivedAt === null && resolution === "completed" && resolvedAt !== null;
}

export function canCancel(column: TaskColumn, archivedAt: number | null): boolean {
  return archivedAt === null && (column === "todo" || column === "ready" || column === "in_progress");
}
