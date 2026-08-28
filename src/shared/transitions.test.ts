import { describe, expect, it } from "vitest";
import { TransitionError, assertClaimAllowed, canArchive, columnForPullRequest, requiredAssignmentKind } from "./transitions";
import type { PullRequestSnapshot, TaskColumn } from "./types";

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Ship it",
    state: "open",
    draft: false,
    merged: false,
    headSha: "abc123",
    approvals: 0,
    changesRequestedBy: [],
    reviewCommentCount: 0,
    conversationCommentCount: 0,
    checks: { passed: 0, failed: 0, pending: 0, failedNames: [], pendingNames: [] },
    recentReviews: [],
    syncedAt: 1,
    ...overrides,
  };
}

describe("task transitions", () => {
  it("requires planning only in Todo and implementation through In PR", () => {
    expect(requiredAssignmentKind("todo")).toBe("planning");
    for (const column of ["ready", "in_progress", "in_pr"] satisfies TaskColumn[]) {
      expect(requiredAssignmentKind(column)).toBe("implementation");
    }
    expect(requiredAssignmentKind("done")).toBeNull();
  });

  it("rejects the wrong assignment kind and completed work", () => {
    expect(() => assertClaimAllowed("todo", "implementation", null)).toThrowError(TransitionError);
    expect(() => assertClaimAllowed("ready", "planning", null)).toThrowError(/implementation assignment/);
    expect(() => assertClaimAllowed("done", "implementation", null)).toThrowError(/cannot be claimed/);
    expect(() => assertClaimAllowed("todo", "planning", 10)).toThrowError(/cannot be claimed/);
  });

  it("maps normalized pull request state to the only legal target column", () => {
    expect(columnForPullRequest(snapshot())).toBe("in_pr");
    expect(columnForPullRequest(snapshot({ state: "closed" }))).toBe("in_progress");
    expect(columnForPullRequest(snapshot({ state: "closed", merged: true }))).toBe("done");
  });

  it("archives only active Done tasks", () => {
    expect(canArchive("done", null)).toBe(true);
    expect(canArchive("done", 1)).toBe(false);
    expect(canArchive("in_pr", null)).toBe(false);
  });
});
