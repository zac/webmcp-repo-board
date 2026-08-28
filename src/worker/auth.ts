import type { Viewer } from "../shared";

const SESSION_COOKIE = "repo_board_session";
const OAUTH_STATE_COOKIE = "repo_board_oauth_state";
const SESSION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AuthenticatedUser {
  userId: string;
  githubId: number;
  login: string;
  avatarUrl: string;
}

export interface GitHubUserIdentity {
  id: number;
  login: string;
  avatarUrl: string;
}

export async function userFromRequest(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  if (String(env.ENVIRONMENT) === "test") {
    const id = request.headers.get("x-test-user-id");
    const login = request.headers.get("x-test-user-login");
    if (id && login) return { userId: id, githubId: 1, login, avatarUrl: "" };
  }
  const token = parseCookies(request.headers.get("cookie") ?? "").get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DIRECTORY.prepare(
    `SELECT users.id, users.github_id, users.login, users.avatar_url
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, Date.now()).first<{ id: string; github_id: number; login: string; avatar_url: string }>();
  return row ? { userId: row.id, githubId: row.github_id, login: row.login, avatarUrl: row.avatar_url } : null;
}

export async function createSession(env: Env, identity: GitHubUserIdentity): Promise<{ token: string; user: AuthenticatedUser }> {
  const now = Date.now();
  const userId = `github_${identity.id}`;
  await env.DIRECTORY.prepare(
    `INSERT INTO users (id, github_id, login, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
  ).bind(userId, identity.id, identity.login, identity.avatarUrl, now, now).run();
  const token = randomToken();
  await env.DIRECTORY.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now + SESSION_MS).run();
  return { token, user: { userId, githubId: identity.id, login: identity.login, avatarUrl: identity.avatarUrl } };
}

export async function deleteSession(request: Request, env: Env): Promise<void> {
  const token = parseCookies(request.headers.get("cookie") ?? "").get(SESSION_COOKIE);
  if (token) await env.DIRECTORY.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export function sessionCookie(token: string, requestUrl: URL): string {
  return cookie(SESSION_COOKIE, token, requestUrl, SESSION_MS / 1_000, true);
}

export function clearSessionCookie(requestUrl: URL): string {
  return cookie(SESSION_COOKIE, "", requestUrl, 0, true);
}

export function createOAuthState(requestUrl: URL): { state: string; cookie: string } {
  const state = randomToken();
  return { state, cookie: cookie(OAUTH_STATE_COOKIE, state, requestUrl, 600, true) };
}

export function verifyOAuthState(request: Request, state: string): boolean {
  const expected = parseCookies(request.headers.get("cookie") ?? "").get(OAUTH_STATE_COOKIE);
  return Boolean(expected && state && timingSafeTextEqual(expected, state));
}

export function clearOAuthStateCookie(requestUrl: URL): string {
  return cookie(OAUTH_STATE_COOKIE, "", requestUrl, 0, true);
}

export function viewerFor(user: AuthenticatedUser | null, roleName: string | null, canMutate: boolean): Viewer {
  return {
    userId: user?.userId ?? null,
    login: user?.login ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    roleName,
    canMutate,
  };
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(bytes));
}

export function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return cookies;
}

function cookie(name: string, value: string, requestUrl: URL, maxAge: number, httpOnly: boolean): string {
  const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAge)}; SameSite=Lax${secure}${httpOnly ? "; HttpOnly" : ""}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}
