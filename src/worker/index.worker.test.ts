import { SELF, applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoardView } from "../shared";
import { createOAuthState, createSession, oauthReturnPath, safeOAuthReturnPath, sessionCookie, userFromRequest, verifyOAuthState } from "./auth";
import { webhookPullRequestNumbers } from "./index";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DIRECTORY, testEnv.TEST_MIGRATIONS);
});

async function seedBoard(repo: string, isPrivate: boolean): Promise<void> {
  const id = `acme/${repo}`;
  const now = Date.now();
  const repositoryId = Math.floor(Math.random() * -1_000_000) - 1;
  await env.DIRECTORY.prepare(
    `INSERT OR REPLACE INTO installations (installation_id, account_login, account_type, suspended_at, updated_at)
     VALUES (0, 'acme', 'organization', NULL, ?)`,
  ).bind(now).run();
  await env.DIRECTORY.prepare(
    `INSERT INTO boards (id, owner, repo, full_name, repository_id, installation_id, is_private, html_url, created_by, created_at, updated_at)
     VALUES (?, 'acme', ?, ?, ?, 0, ?, ?, 'seed', ?, ?)`,
  ).bind(id, repo, `acme/${repo}`, repositoryId, isPrivate ? 1 : 0, `https://github.com/acme/${repo}`, now, now).run();
  await env.REPO_BOARD.getByName(id).initialize({ id, owner: "acme", repo, fullName: `acme/${repo}`, repositoryId, installationId: 0, htmlUrl: `https://github.com/acme/${repo}`, isPrivate });
}

function authenticated(role: string, userId = "user-zac", login = "zac", init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-test-user-id": userId, "x-test-user-login": login, "x-test-role": role } };
}

describe("Worker authorization and directory routing", () => {
  it("uses the prelaunch D1 schema without the removed permission cache", async () => {
    const table = await env.DIRECTORY.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'permission_cache'").first<{ name: string }>();
    expect(table).toBeNull();
  });

  it("shows an unpersisted blank board for any public repository route", async () => {
    const response = await SELF.fetch("https://example.com/api/boards/acme/new-public", { headers: { "x-test-repository-visibility": "public" } });
    expect(response.status).toBe(200);
    expect(await response.json() as BoardView).toMatchObject({
      fullName: "acme/new-public",
      materialized: false,
      revision: 0,
      tasks: [],
      viewer: { canMutate: false },
    });
    expect((await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM boards").first<{ count: number }>())?.count).toBe(0);
  });

  it("materializes a direct-route board only for a signed-in mutating collaborator", async () => {
    const url = "https://example.com/api/boards/acme/lazy";
    const preview = await SELF.fetch(url, authenticated("read", "reader", "reader", { headers: { "x-test-repository-visibility": "public" } }));
    expect((await preview.json() as BoardView).materialized).toBe(false);
    expect((await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM boards").first<{ count: number }>())?.count).toBe(0);

    const initialized = await SELF.fetch(url, authenticated("triage", "author", "author", { headers: { "x-test-repository-visibility": "public" } }));
    expect(initialized.status).toBe(200);
    expect(await initialized.json() as BoardView).toMatchObject({ materialized: true, viewer: { roleName: "triage", canMutate: true } });
    expect((await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM boards").first<{ count: number }>())?.count).toBe(1);
  });

  it("keeps private and nonexistent direct routes indistinguishable before sign-in", async () => {
    const privateResponse = await SELF.fetch("https://example.com/api/boards/acme/private-route", { headers: { "x-test-repository-visibility": "private" } });
    const missingResponse = await SELF.fetch("https://example.com/api/boards/acme/missing-route");
    expect(privateResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await privateResponse.json()).toEqual(await missingResponse.json());
  });

  it("allows anonymous public reads and hides private boards", async () => {
    await seedBoard("public", false);
    await seedBoard("private", true);
    const publicResponse = await SELF.fetch("https://example.com/api/boards/acme/public");
    expect(publicResponse.status).toBe(200);
    expect((await publicResponse.json() as BoardView).viewer.canMutate).toBe(false);
    expect((await SELF.fetch("https://example.com/api/boards/acme/private")).status).toBe(404);
  });

  it("does not fan anonymous directory requests out into per-board authorization", async () => {
    await seedBoard("listed-public", false);
    const response = await SELF.fetch("https://example.com/api/boards");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boards: [] });
  });

  it.each([
    ["read", false],
    ["triage", true],
    ["write", true],
    ["maintain", true],
    ["admin", true],
  ])("honors the GitHub %s role", async (role, canMutate) => {
    await seedBoard(`role-${role}`, true);
    const url = `https://example.com/api/boards/acme/role-${role}`;
    const response = await SELF.fetch(url, authenticated(role));
    expect(response.status).toBe(200);
    const board = await response.json() as BoardView;
    expect(board.viewer).toMatchObject({ roleName: role, canMutate });
    const commandResponse = await SELF.fetch(`${url}/commands`, authenticated(role, "user-zac", "zac", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ actionId: crypto.randomUUID(), expectedRevision: 0, command: { type: "create_task", title: "Authorized", description: "Role check" } }),
    }));
    expect(commandResponse.status).toBe(canMutate ? 200 : 403);
  });

  it("fails closed when private access is revoked", async () => {
    await seedBoard("revoked", true);
    const response = await SELF.fetch("https://example.com/api/boards/acme/revoked", authenticated("none"));
    expect(response.status).toBe(404);
  });

  it("authorizes an existing private board before returning create metadata", async () => {
    await seedBoard("existing-private", true);
    const request = (role: string) => SELF.fetch("https://example.com/api/boards", authenticated(role, "user-zac", "zac", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ owner: "acme", repo: "existing-private" }),
    }));
    const hidden = await request("none");
    const missing = await SELF.fetch("https://example.com/api/boards/acme/missing");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect((await request("triage")).status).toBe(200);
  });

  it("keeps two assignments from the same session user independent across tabs", async () => {
    await seedBoard("tabs", false);
    const url = "https://example.com/api/boards/acme/tabs";
    const headers = authenticated("write", "one-user", "zac", { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" } });
    let revision = 0;
    const taskIds: string[] = [];
    for (const title of ["First tab", "Second tab"]) {
      const response = await SELF.fetch(`${url}/commands`, { ...headers, body: JSON.stringify({ actionId: crypto.randomUUID(), expectedRevision: revision, command: { type: "create_task", title, description: "Independent" } }) });
      const board = await response.json() as BoardView;
      revision = board.revision;
      taskIds.push(board.tasks.find((task) => task.title === title)!.id);
    }
    for (const [index, taskId] of taskIds.entries()) {
      const response = await SELF.fetch(`${url}/commands`, { ...headers, body: JSON.stringify({ actionId: crypto.randomUUID(), expectedRevision: revision, command: { type: "claim_task", taskId, kind: "planning", agentLabel: `Tab ${index + 1}` } }) });
      const board = await response.json() as BoardView;
      revision = board.revision;
    }
    const board = await (await SELF.fetch(url, authenticated("write", "one-user", "zac"))).json() as BoardView;
    expect(board.tasks.map((task) => task.assignment?.agentLabel)).toEqual(["Tab 1", "Tab 2"]);
    expect(board.tasks.every((task) => task.assignment?.userId === "one-user")).toBe(true);
  });

  it("preserves structured assignment conflicts through the HTTP boundary", async () => {
    await seedBoard("claim-conflict", false);
    const url = "https://example.com/api/boards/acme/claim-conflict";
    const headers = authenticated("write", "one-user", "zac", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
    });
    const createdResponse = await SELF.fetch(`${url}/commands`, {
      ...headers,
      body: JSON.stringify({
        actionId: crypto.randomUUID(),
        expectedRevision: 0,
        command: { type: "create_task", title: "Race", description: "Only one claim wins" },
      }),
    });
    const created = await createdResponse.json() as BoardView;
    const taskId = created.tasks[0].id;

    const responses = await Promise.all(["Primary", "Secondary"].map((agentLabel) => SELF.fetch(`${url}/commands`, {
      ...headers,
      body: JSON.stringify({
        actionId: crypto.randomUUID(),
        expectedRevision: 1,
        command: { type: "claim_task", taskId, kind: "planning", agentLabel },
      }),
    })));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflictResponse = responses.find((response) => response.status === 409)!;
    const conflict = await conflictResponse.json() as Record<string, unknown>;
    expect(conflict).toMatchObject({
      error: "assignment_conflict",
      ownerLogin: "zac",
      currentRevision: 2,
    });
    expect(Number(conflict.leaseExpiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("sessions and OAuth state", () => {
  it("hashes isolated sessions and resolves the matching identity", async () => {
    const first = await createSession(testEnv, { id: 10, login: "alice", avatarUrl: "" });
    const second = await createSession(testEnv, { id: 11, login: "bob", avatarUrl: "" });
    expect(first.token).not.toBe(second.token);
    const stored = await env.DIRECTORY.prepare("SELECT token_hash FROM sessions ORDER BY created_at").all<{ token_hash: string }>();
    expect(stored.results.map((row) => row.token_hash)).not.toContain(first.token);
    const aliceRequest = new Request("https://example.com", { headers: { cookie: sessionCookie(first.token, new URL("https://example.com")) } });
    const bobRequest = new Request("https://example.com", { headers: { cookie: sessionCookie(second.token, new URL("https://example.com")) } });
    expect((await userFromRequest(aliceRequest, testEnv))?.login).toBe("alice");
    expect((await userFromRequest(bobRequest, testEnv))?.login).toBe("bob");
  });

  it("accepts only the OAuth state bound to its HttpOnly cookie", () => {
    const url = new URL("https://example.com/auth/github");
    const { state, cookie, returnCookie } = createOAuthState(url, "/boards/zac/repo-board");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(verifyOAuthState(new Request(url, { headers: { cookie } }), state)).toBe(true);
    expect(verifyOAuthState(new Request(url, { headers: { cookie } }), `${state}x`)).toBe(false);
    expect(verifyOAuthState(new Request(url), state)).toBe(false);
    const request = new Request(url, { headers: { cookie: `${cookie.split(";")[0]}; ${returnCookie.split(";")[0]}` } });
    expect(oauthReturnPath(request)).toBe("/boards/zac/repo-board");
    expect(safeOAuthReturnPath("https://attacker.example/boards/zac/repo-board")).toBe("/");
    expect(safeOAuthReturnPath("/boards/zac/repo-board?next=https://attacker.example")).toBe("/");
  });
});

describe("GitHub webhook routing", () => {
  it("accepts only bounded pull-request-affecting event actions", () => {
    expect(webhookPullRequestNumbers("pull_request", { action: "synchronize", pull_request: { number: 7 } })).toEqual([7]);
    expect(webhookPullRequestNumbers("pull_request", { action: "labeled", pull_request: { number: 7 } })).toEqual([]);
    expect(webhookPullRequestNumbers("issue_comment", { action: "created", issue: { number: 8 } })).toEqual([]);
    expect(webhookPullRequestNumbers("issue_comment", { action: "created", issue: { number: 8, pull_request: {} } })).toEqual([8]);
    expect(webhookPullRequestNumbers("check_run", {
      action: "completed",
      check_run: { pull_requests: Array.from({ length: 30 }, (_, index) => ({ number: index + 1 })) },
    })).toHaveLength(20);
  });
});
