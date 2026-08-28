import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canMutateForRole,
  canReadForRole,
  fetchPublicRepository,
  fetchPullRequestSnapshot,
  parsePullRequestUrl,
  verifyWebhookSignature,
} from "./github";

describe("GitHub boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps collaborator roles to read and mutation authorization", () => {
    expect(canReadForRole(null)).toBe(false);
    expect(canReadForRole("none")).toBe(false);
    expect(canReadForRole("read")).toBe(true);
    expect(canMutateForRole("read")).toBe(false);
    for (const role of ["triage", "write", "maintain", "admin"]) expect(canMutateForRole(role)).toBe(true);
  });

  it("accepts only same-repository GitHub pull request URLs", () => {
    expect(parsePullRequestUrl("https://github.com/Acme/Widgets/pull/42", "acme", "widgets")).toBe(42);
    expect(() => parsePullRequestUrl("https://github.com/acme/other/pull/42", "acme", "widgets")).toThrowError(/must belong/);
    expect(() => parsePullRequestUrl("https://evil.example/acme/widgets/pull/42", "acme", "widgets")).toThrowError(/must belong/);
  });

  it("fails closed when an anonymous repository lookup is rate limited", async () => {
    const upstreamMessage = "API rate limit exceeded for 104.22.20.4";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: upstreamMessage }, { status: 403 })));

    await expect(fetchPublicRepository("acme", "private-or-missing")).resolves.toBeNull();
  });

  it("returns public repository metadata when the anonymous lookup succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: 42,
      name: "widgets",
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
      private: false,
      owner: { login: "acme" },
    })));

    await expect(fetchPublicRepository("acme", "widgets")).resolves.toMatchObject({
      id: 42,
      fullName: "acme/widgets",
      isPrivate: false,
    });
  });

  it("verifies webhook HMACs and rejects malformed signatures", async () => {
    const body = new TextEncoder().encode('{"action":"opened"}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const buffer = body.buffer as ArrayBuffer;
    expect(await verifyWebhookSignature(buffer, `sha256=${hex}`, "test-secret")).toBe(true);
    expect(await verifyWebhookSignature(buffer, `sha256=${"0".repeat(64)}`, "test-secret")).toBe(false);
    expect(await verifyWebhookSignature(buffer, "invalid", "test-secret")).toBe(false);
  });

  it("normalizes latest reviews, comments, check runs, and commit statuses", async () => {
    const responses = new Map<string, unknown>();
    responses.set("/repos/acme/widgets/pulls/9", {
      html_url: "https://github.com/acme/widgets/pull/9",
      title: "Coordinate agents",
      state: "open",
      draft: false,
      merged: false,
      head: { sha: "sha-9" },
    });
    responses.set("/repos/acme/widgets/pulls/9/reviews?per_page=100", [
      { id: 1, user: { login: "alice" }, state: "APPROVED", body: "Earlier", submitted_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/review/1" },
      { id: 2, user: { login: "alice" }, state: "CHANGES_REQUESTED", body: "Please fix", submitted_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/review/2" },
      { id: 3, user: { login: "bob" }, state: "APPROVED", body: "Looks good", submitted_at: "2026-01-03T00:00:00Z", html_url: "https://github.com/review/3" },
    ]);
    responses.set("/repos/acme/widgets/pulls/9/comments?per_page=100", [{ id: 1 }, { id: 2 }]);
    responses.set("/repos/acme/widgets/issues/9/comments?per_page=100", [{ id: 1 }]);
    responses.set("/repos/acme/widgets/commits/sha-9/check-runs?per_page=100", {
      check_runs: [
        { name: "unit", status: "completed", conclusion: "success" },
        { name: "integration", status: "completed", conclusion: "failure" },
        { name: "browser", status: "in_progress", conclusion: null },
      ],
    });
    responses.set("/repos/acme/widgets/commits/sha-9/statuses?per_page=100", [
      { context: "deploy", state: "success" },
      { context: "security", state: "error" },
      { context: "preview", state: "pending" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!responses.has(`${url.pathname}${url.search}`)) return Response.json({ message: "Unexpected request" }, { status: 500 });
      return Response.json(responses.get(`${url.pathname}${url.search}`));
    }));

    const result = await fetchPullRequestSnapshot("acme", "widgets", 9, "installation-token");
    expect(result).toMatchObject({
      approvals: 1,
      changesRequestedBy: ["alice"],
      reviewCommentCount: 2,
      conversationCommentCount: 1,
      checks: {
        passed: 2,
        failed: 2,
        pending: 2,
        failedNames: ["integration", "security"],
        pendingNames: ["browser", "preview"],
      },
    });
    expect(result.recentReviews.map((review) => review.id)).toEqual([3, 2, 1]);
  });
});
