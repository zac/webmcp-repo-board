import { describe, expect, it } from "vitest";
import type { PullRequestSnapshot, Viewer } from "../shared";
import { pullRequestApprovalLabel, pullRequestReadiness, pullRequestViewerRelationship } from "./App";

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
    authorLogin: "builder",
    changesRequestedBy: [],
    requestedReviewers: [],
    latestReviews: [],
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

const viewer: Viewer = { userId: "u1", login: "zac", avatarUrl: null, roleName: "write", canMutate: true };

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

describe("viewer pull request relationships", () => {
  it("offers the author a locked feedback workflow", () => {
    const relationship = pullRequestViewerRelationship(pullRequest({
      authorLogin: "zac",
      changesRequestedBy: ["maya"],
      latestReviews: [{ reviewer: "maya", state: "CHANGES_REQUESTED", submittedAt: "2026-08-28T17:00:00Z", commitSha: "abc123" }],
    }), viewer);
    expect(relationship).toMatchObject({ label: "Feedback for you", tone: "danger", promptIntent: "review_feedback" });
  });

  it("recognizes a new head after the viewer requested changes", () => {
    const relationship = pullRequestViewerRelationship(pullRequest({
      authorLogin: "maya",
      headSha: "new-head",
      changesRequestedBy: ["zac"],
      requestedReviewers: ["zac"],
      latestReviews: [{ reviewer: "zac", state: "CHANGES_REQUESTED", submittedAt: "2026-08-28T17:00:00Z", commitSha: "old-head" }],
    }), viewer);
    expect(relationship).toMatchObject({ label: "Updates ready for your review", tone: "warning", promptIntent: "review_updates" });
  });

  it("does not claim that feedback was addressed when the head is unchanged", () => {
    const relationship = pullRequestViewerRelationship(pullRequest({
      authorLogin: "maya",
      headSha: "same-head",
      changesRequestedBy: ["zac"],
      latestReviews: [{ reviewer: "zac", state: "CHANGES_REQUESTED", submittedAt: "2026-08-28T17:00:00Z", commitSha: "same-head" }],
    }), viewer);
    expect(relationship).toMatchObject({ label: "You requested changes", promptIntent: "review_updates" });
  });

  it("labels the author's approved clean PR as theirs to merge", () => {
    const relationship = pullRequestViewerRelationship(pullRequest({
      authorLogin: "zac",
      approvals: 2,
      reviewRequirement: { ...pullRequest().reviewRequirement, decision: "approved" },
      mergeState: "clean",
    }), viewer);
    expect(relationship).toMatchObject({ label: "Your PR is ready to merge", tone: "success", promptIntent: "merge_preparation" });
  });
});
