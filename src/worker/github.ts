import type { PullRequestSnapshot, ReviewDetail } from "../shared";
import type { GitHubUserIdentity } from "./auth";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_GITHUB_RESPONSE = 2 * 1024 * 1024;

export interface GitHubRepository {
  id: number;
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
}

export async function exchangeOAuthCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const body = await readBoundedJson(response);
  const token = stringField(body, "access_token");
  if (!response.ok || !token) throw new GitHubError("oauth_exchange_failed", "GitHub did not accept the authorization code", 502);
  return token;
}

export async function fetchGitHubIdentity(token: string): Promise<GitHubUserIdentity> {
  const body = recordValue(await githubJson("/user", token));
  return { id: numberField(body, "id"), login: stringField(body, "login"), avatarUrl: optionalString(body, "avatar_url") ?? "" };
}

export async function appInstallationForRepository(env: Env, owner: string, repo: string): Promise<number> {
  const jwt = await createAppJwt(env);
  const body = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, jwt);
  return numberField(body, "id");
}

export async function installationToken(env: Env, installationId: number): Promise<string | null> {
  if (installationId === 0) return null;
  const jwt = await createAppJwt(env);
  const body = await githubJson(`/app/installations/${installationId}/access_tokens`, jwt, { method: "POST", body: "{}" });
  return stringField(body, "token");
}

export async function fetchRepository(owner: string, repo: string, token: string | null): Promise<GitHubRepository> {
  const body = recordValue(await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token));
  const ownerObject = recordField(body, "owner");
  return {
    id: numberField(body, "id"),
    owner: stringField(ownerObject, "login"),
    repo: stringField(body, "name"),
    fullName: stringField(body, "full_name"),
    htmlUrl: stringField(body, "html_url"),
    isPrivate: booleanField(body, "private"),
  };
}

export async function fetchPublicRepository(owner: string, repo: string): Promise<GitHubRepository | null> {
  try {
    return await fetchRepository(owner, repo, null);
  } catch (error) {
    if (error instanceof GitHubError || error instanceof TypeError) return null;
    throw error;
  }
}

export async function collaboratorRole(owner: string, repo: string, login: string, token: string): Promise<string | null> {
  try {
    const body = recordValue(await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`, token));
    return optionalString(body, "role_name") ?? optionalString(body, "permission");
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

export function canMutateForRole(roleName: string | null): boolean {
  return roleName !== null && ["triage", "write", "maintain", "admin"].includes(roleName);
}

export function canReadForRole(roleName: string | null): boolean {
  return roleName !== null && roleName !== "none";
}

export function parsePullRequestUrl(urlValue: string, owner: string, repo: string): number {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new GitHubError("invalid_pull_request_url", "Pull request URL is invalid", 400);
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !match || match[1].toLowerCase() !== owner.toLowerCase() || match[2].toLowerCase() !== repo.toLowerCase()) {
    throw new GitHubError("cross_repository_pull_request", `Pull request must belong to ${owner}/${repo}`, 409);
  }
  return Number(match[3]);
}

export async function fetchPullRequestSnapshot(owner: string, repo: string, number: number, token: string | null): Promise<PullRequestSnapshot> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const pull = recordValue(await githubJson(`${base}/pulls/${number}`, token));
  const head = recordField(pull, "head");
  const headSha = stringField(head, "sha");
  const [reviewsValue, reviewCommentsValue, conversationCommentsValue, checksValue, statusesValue] = await Promise.all([
    githubJson(`${base}/pulls/${number}/reviews?per_page=100`, token),
    githubJson(`${base}/pulls/${number}/comments?per_page=100`, token),
    githubJson(`${base}/issues/${number}/comments?per_page=100`, token),
    githubJson(`${base}/commits/${headSha}/check-runs?per_page=100`, token),
    githubJson(`${base}/commits/${headSha}/statuses?per_page=100`, token),
  ]);

  const reviews = arrayValue(reviewsValue).map((value) => recordValue(value));
  const latestByReviewer = new Map<string, Record<string, unknown>>();
  for (const review of reviews) {
    const user = recordField(review, "user");
    const login = stringField(user, "login");
    latestByReviewer.set(login, review);
  }
  const latest = [...latestByReviewer.entries()];
  const approvals = latest.filter(([, review]) => optionalString(review, "state") === "APPROVED").length;
  const changesRequestedBy = latest.filter(([, review]) => optionalString(review, "state") === "CHANGES_REQUESTED").map(([login]) => login).sort();
  const recentReviews: ReviewDetail[] = reviews.slice(-20).reverse().map((review) => {
    const user = recordField(review, "user");
    return {
      id: numberField(review, "id"),
      reviewer: stringField(user, "login"),
      state: optionalString(review, "state") ?? "COMMENTED",
      body: truncate(optionalString(review, "body") ?? "", 1_000),
      submittedAt: optionalString(review, "submitted_at"),
      url: optionalString(review, "html_url") ?? stringField(pull, "html_url"),
    };
  });

  const checksObject = recordValue(checksValue);
  const checkRuns = arrayField(checksObject, "check_runs").map(recordValue);
  const statuses = arrayValue(statusesValue).map(recordValue);
  const passedNames: string[] = [];
  const failedNames: string[] = [];
  const pendingNames: string[] = [];
  for (const check of checkRuns) classifyCheck(optionalString(check, "name") ?? "check", optionalString(check, "status"), optionalString(check, "conclusion"), passedNames, failedNames, pendingNames);
  for (const status of statuses) classifyStatus(optionalString(status, "context") ?? "status", optionalString(status, "state"), passedNames, failedNames, pendingNames);

  return {
    number,
    url: stringField(pull, "html_url"),
    title: truncate(stringField(pull, "title"), 200),
    state: stringField(pull, "state") === "closed" ? "closed" : "open",
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged),
    headSha,
    approvals,
    changesRequestedBy,
    reviewCommentCount: arrayValue(reviewCommentsValue).length,
    conversationCommentCount: arrayValue(conversationCommentsValue).length,
    checks: { passed: passedNames.length, failed: failedNames.length, pending: pendingNames.length, failedNames: failedNames.slice(0, 20), pendingNames: pendingNames.slice(0, 20) },
    recentReviews,
    syncedAt: Date.now(),
  };
}

export async function verifyWebhookSignature(body: ArrayBuffer, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = hexBytes(signatureHeader.slice(7));
  if (!provided) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, provided, body);
}

export async function readBoundedBody(request: Request, maximum = MAX_GITHUB_RESPONSE): Promise<ArrayBuffer> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maximum) throw new GitHubError("payload_too_large", "Payload is too large", 413);
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel("Payload too large");
      throw new GitHubError("payload_too_large", "Payload is too large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export class GitHubError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

async function createAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function githubJson(path: string, token: string | null, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", "webmcp-repo-board");
  headers.set("x-github-api-version", API_VERSION);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const body = await readBoundedJson(response);
  if (!response.ok) throw new GitHubError("github_api_error", githubMessage(body) ?? `GitHub returned ${response.status}`, response.status === 404 ? 404 : 502);
  return body;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const request = new Request("https://bounded.internal", { method: "POST", body: response.body, headers: response.headers });
  const buffer = await readBoundedBody(request);
  const text = new TextDecoder().decode(buffer);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubError("invalid_github_response", "GitHub returned invalid JSON", 502);
  }
}

function classifyCheck(name: string, status: string | null, conclusion: string | null, passed: string[], failed: string[], pending: string[]): void {
  if (status !== "completed" || conclusion === null) pending.push(name);
  else if (["success", "neutral", "skipped"].includes(conclusion)) passed.push(name);
  else failed.push(name);
}

function classifyStatus(name: string, state: string | null, passed: string[], failed: string[], pending: string[]): void {
  if (state === "success") passed.push(name);
  else if (state === "failure" || state === "error") failed.push(name);
  else pending.push(name);
}

function encodeJson(value: Record<string, string | number>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(pem: string): ArrayBuffer {
  const isPkcs1 = pem.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return (isPkcs1 ? wrapPkcs1AsPkcs8(bytes) : bytes).slice().buffer as ArrayBuffer;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const privateKey = derValue(0x04, pkcs1);
  return derValue(0x30, concatBytes(version, rsaAlgorithm, privateKey));
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(value.byteLength), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubError("invalid_github_response", "GitHub returned an unexpected object", 502);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitHubError("invalid_github_response", "GitHub returned an unexpected list", 502);
  return value;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return recordValue(value[key]);
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  return arrayValue(value[key]);
}

function stringField(value: unknown, key: string): string {
  const result = recordValue(value)[key];
  if (typeof result !== "string" || !result) throw new GitHubError("invalid_github_response", `GitHub response omitted ${key}`, 502);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
  const result = value[key];
  return typeof result === "string" ? result : null;
}

function numberField(value: unknown, key: string): number {
  const result = recordValue(value)[key];
  if (typeof result !== "number" || !Number.isFinite(result)) throw new GitHubError("invalid_github_response", `GitHub response omitted ${key}`, 502);
  return result;
}

function booleanField(value: unknown, key: string): boolean {
  const result = recordValue(value)[key];
  if (typeof result !== "boolean") throw new GitHubError("invalid_github_response", `GitHub response omitted ${key}`, 502);
  return result;
}

function githubMessage(value: unknown): string | null {
  try {
    return optionalString(recordValue(value), "message");
  } catch {
    return null;
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
