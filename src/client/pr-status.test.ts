import { describe, expect, it } from "vitest";
import type { PullRequestSnapshot } from "../shared";
import { pullRequestApprovalLabel, pullRequestReadiness } from "./App";

function pullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 12,
    url: "https://github.com/acme/widgets/pull/12",
    title: "Finish the work",
    state: "open",
    draft: false,
    merged: false,
    headSha: "abc123",
    baseRef: "main",
    approvals: 1,
    changesRequestedBy: [],
    reviewRequirement: { requiredApprovals: 2, decision: "review_required", codeOwnerReviewRequired: false, latestPushApprovalRequired: false },
    mergeState: "blocked",
    reviewCommentCount: 0,
    conversationCommentCount: 0,
    checks: { passed: 3, failed: 0, pending: 0, failedNames: [], pendingNames: [] },
    recentReviews: [],
    syncedAt: 1,
    ...overrides,
  };
}

describe("pull request readiness", () => {
  it("shows progress toward two required approvals", () => {
    const oneApproval = pullRequest();
    expect(pullRequestApprovalLabel(oneApproval)).toBe("1 of 2 approvals");
    expect(pullRequestReadiness(oneApproval)).toEqual({ label: "Review required", tone: "warning" });

    const twoApprovals = pullRequest({ approvals: 2, reviewRequirement: { ...oneApproval.reviewRequirement, decision: "approved" }, mergeState: "clean" });
    expect(pullRequestApprovalLabel(twoApprovals)).toBe("2 of 2 approvals");
    expect(pullRequestReadiness(twoApprovals)).toEqual({ label: "Ready to merge", tone: "success" });
  });

  it("keeps changes requested and failed checks ahead of approval counts", () => {
    expect(pullRequestReadiness(pullRequest({ approvals: 2, changesRequestedBy: ["reviewer"] }))).toEqual({ label: "Changes requested", tone: "danger" });
    expect(pullRequestReadiness(pullRequest({ approvals: 2, reviewRequirement: { ...pullRequest().reviewRequirement, decision: "approved" }, checks: { passed: 2, failed: 1, pending: 0, failedNames: ["unit"], pendingNames: [] } }))).toEqual({ label: "Checks failing", tone: "danger" });
  });
});
