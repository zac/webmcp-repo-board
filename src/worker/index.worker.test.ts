import { SELF, applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoardView } from "../shared";
import { createOAuthState, createSession, sessionCookie, userFromRequest, verifyOAuthState } from "./auth";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DIRECTORY, testEnv.TEST_MIGRATIONS);
});

async function seedBoard(repo: string, isPrivate: boolean): Promise<void> {
  const id = `acme/${repo}`;
  const now = Date.now();
  await env.DIRECTORY.prepare(
    `INSERT OR REPLACE INTO installations (installation_id, account_login, account_type, suspended_at, updated_at)
     VALUES (0, 'acme', 'organization', NULL, ?)`,
  ).bind(now).run();
  await env.DIRECTORY.prepare(
    `INSERT INTO boards (id, owner, repo, full_name, repository_id, installation_id, is_private, html_url, created_by, created_at, updated_at)
     VALUES (?, 'acme', ?, ?, ?, 0, ?, ?, 'seed', ?, ?)`,
  ).bind(id, repo, `acme/${repo}`, Math.floor(Math.random() * -1_000_000) - 1, isPrivate ? 1 : 0, `https://github.com/acme/${repo}`, now, now).run();
  await env.REPO_BOARD.getByName(id).initialize({ id, owner: "acme", repo, fullName: `acme/${repo}`, htmlUrl: `https://github.com/acme/${repo}`, isPrivate });
}

function authenticated(role: string, userId = "user-zac", login = "zac", init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-test-user-id": userId, "x-test-user-login": login, "x-test-role": role } };
}

describe("Worker authorization and directory routing", () => {
  it("allows anonymous public reads and hides private boards", async () => {
    await seedBoard("public", false);
    await seedBoard("private", true);
    const publicResponse = await SELF.fetch("https://example.com/api/boards/acme/public");
    expect(publicResponse.status).toBe(200);
    expect((await publicResponse.json() as BoardView).viewer.canMutate).toBe(false);
    expect((await SELF.fetch("https://example.com/api/boards/acme/private")).status).toBe(404);
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
    const { state, cookie } = createOAuthState(url);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(verifyOAuthState(new Request(url, { headers: { cookie } }), state)).toBe(true);
    expect(verifyOAuthState(new Request(url, { headers: { cookie } }), `${state}x`)).toBe(false);
    expect(verifyOAuthState(new Request(url), state)).toBe(false);
  });
});
