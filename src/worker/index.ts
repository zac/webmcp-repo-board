import {
  ValidationError,
  objectValue,
  parseCommandEnvelope,
  type Actor,
  type BoardSummary,
  type CommandEnvelope,
  type InternalBoardCommand,
  type RpcResult,
  type Viewer,
} from "../shared";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createOAuthState,
  createSession,
  deleteSession,
  sessionCookie,
  userFromRequest,
  verifyOAuthState,
  viewerFor,
  type AuthenticatedUser,
} from "./auth";
import {
  GitHubError,
  appInstallationForRepository,
  canMutateForRole,
  canReadForRole,
  collaboratorRole,
  exchangeOAuthCode,
  fetchGitHubIdentity,
  fetchPullRequestSnapshot,
  fetchRepository,
  installationToken,
  parsePullRequestUrl,
  readBoundedBody,
  verifyWebhookSignature,
} from "./github";
import { RepoBoard } from "./repo-board";

export { RepoBoard };

interface BoardRecord {
  id: string;
  owner: string;
  repo: string;
  full_name: string;
  repository_id: number;
  installation_id: number;
  is_private: number;
  html_url: string;
}

class RequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "RequestError";
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withSecurityHeaders(await route(request, env, ctx));
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const boards = await env.DIRECTORY.prepare("SELECT id, owner, repo, full_name, repository_id, installation_id, is_private, html_url FROM boards ORDER BY id LIMIT 100")
      .all<BoardRecord>();
    for (const board of boards.results) ctx.waitUntil(reconcileBoard(env, board, "scheduled"));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return Response.json({
      localDevelopment: isLocal(url),
      githubLoginUrl: "/auth/github",
      githubInstallUrl: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    });
  }
  if (url.pathname === "/api/session" && request.method === "GET") {
    const user = await userFromRequest(request, env);
    return Response.json({ user });
  }
  if (url.pathname === "/api/dev/session" && request.method === "POST") {
    assertSameOrigin(request, url);
    if (!isLocal(url)) throw new RequestError("not_found", "Development login is available only on localhost", 404);
    const created = await createSession(env, { id: 1, login: "local-dev", avatarUrl: "" });
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append("set-cookie", sessionCookie(created.token, url));
    return new Response(JSON.stringify({ user: created.user }), { status: 201, headers });
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    assertSameOrigin(request, url);
    await deleteSession(request, env);
    return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie(url) } });
  }
  if (url.pathname === "/auth/github" && request.method === "GET") return startOAuth(url, env);
  if (url.pathname === "/auth/callback" && request.method === "GET") return finishOAuth(request, url, env);
  if (url.pathname === "/webhooks/github" && request.method === "POST") return receiveWebhook(request, env, ctx);

  if (url.pathname === "/api/boards" && request.method === "GET") return listBoards(request, env);
  if (url.pathname === "/api/boards" && request.method === "POST") {
    assertSameOrigin(request, url);
    return createBoard(request, env, url);
  }

  const match = /^\/api\/boards\/([^/]+)\/([^/]+)(?:\/(socket|commands|refresh\/([^/]+)))?$/.exec(url.pathname);
  if (match) {
    const owner = decodeRepoPart(match[1]);
    const repo = decodeRepoPart(match[2]);
    const operation = match[3] ?? "view";
    const board = await boardRecord(env, owner, repo);
    if (!board) throw new RequestError("board_not_found", "Repository board was not found", 404);
    const authorization = await authorizeBoard(request, env, board);

    if (operation === "view" && request.method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "1";
      if (includeArchived && !authorization.viewer.canMutate) throw new RequestError("forbidden", "Archived tasks require repository triage access", 403);
      return Response.json(unwrap(await boardStub(env, board.id).getView(authorization.viewer, includeArchived)));
    }
    if (operation === "socket" && request.method === "GET") return connectSocket(request, env, board, authorization.viewer);
    if (operation === "commands" && request.method === "POST") {
      assertSameOrigin(request, url);
      if (!authorization.viewer.canMutate || !authorization.user) throw new RequestError("forbidden", "Repository triage access is required", 403);
      return executeCommand(request, env, board, authorization.user, authorization.viewer);
    }
    if (operation.startsWith("refresh/") && request.method === "POST") {
      assertSameOrigin(request, url);
      if (!authorization.viewer.canMutate || !authorization.user) throw new RequestError("forbidden", "Repository triage access is required", 403);
      return refreshTask(env, board, authorization.viewer, decodeIdentifier(match[4]));
    }
  }

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/webhooks/")) {
    throw new RequestError("not_found", "Route was not found", 404);
  }
  return env.ASSETS.fetch(request);
}

function startOAuth(url: URL, env: Env): Response {
  if (!env.GITHUB_APP_CLIENT_ID || env.GITHUB_APP_CLIENT_ID.startsWith("replace-")) throw new RequestError("github_app_not_configured", "GitHub App client ID is not configured", 503);
  const { state, cookie } = createOAuthState(url);
  const callback = `${url.origin}/auth/callback`;
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: target.toString(), "set-cookie": cookie } });
}

async function finishOAuth(request: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !verifyOAuthState(request, state)) throw new RequestError("invalid_oauth_state", "GitHub sign-in state is invalid or expired", 400);
  const token = await exchangeOAuthCode(env, code, `${url.origin}/auth/callback`);
  const identity = await fetchGitHubIdentity(token);
  const created = await createSession(env, identity);
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", sessionCookie(created.token, url));
  headers.append("set-cookie", clearOAuthStateCookie(url));
  return new Response(null, { status: 302, headers });
}

async function listBoards(request: Request, env: Env): Promise<Response> {
  const rows = await env.DIRECTORY.prepare("SELECT id, owner, repo, full_name, repository_id, installation_id, is_private, html_url FROM boards ORDER BY full_name LIMIT 100")
    .all<BoardRecord>();
  const visible: BoardSummary[] = [];
  for (const board of rows.results) {
    try {
      await authorizeBoard(request, env, board);
      visible.push(boardSummary(board));
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error;
    }
  }
  return Response.json({ boards: visible });
}

async function createBoard(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await userFromRequest(request, env);
  if (!user) throw new RequestError("unauthorized", "Sign in with GitHub before creating a board", 401);
  const body = objectValue(await readJson(request));
  const owner = repoPart(body.owner, "owner");
  const repo = repoPart(body.repo, "repo");
  const fullName = `${owner}/${repo}`;
  const existing = await boardRecord(env, owner, repo);
  if (existing) return Response.json(boardSummary(existing));

  let installationId: number;
  let repository: { id: number; owner: string; repo: string; fullName: string; htmlUrl: string; isPrivate: boolean };
  let roleName: string | null;
  if (isLocal(url)) {
    installationId = 0;
    repository = { id: -Date.now(), owner, repo, fullName, htmlUrl: `https://github.com/${fullName}`, isPrivate: false };
    roleName = "admin";
  } else {
    installationId = await appInstallationForRepository(env, owner, repo);
    const token = await installationToken(env, installationId);
    if (!token) throw new RequestError("github_installation_missing", "Install the GitHub App on this repository first", 409);
    repository = await fetchRepository(owner, repo, token);
    roleName = await collaboratorRole(owner, repo, user.login, token);
  }
  if (!canMutateForRole(roleName)) throw new RequestError("forbidden", "Repository triage access is required to create its board", 403);

  const now = Date.now();
  const id = repository.fullName.toLowerCase();
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `INSERT INTO installations (installation_id, account_login, account_type, suspended_at, updated_at)
       VALUES (?, ?, 'repository', NULL, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, suspended_at = NULL, updated_at = excluded.updated_at`,
    ).bind(installationId, repository.owner, now),
    env.DIRECTORY.prepare(
      `INSERT INTO boards (id, owner, repo, full_name, repository_id, installation_id, is_private, html_url, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, repository.owner, repository.repo, repository.fullName, repository.id, installationId, repository.isPrivate ? 1 : 0, repository.htmlUrl, user.userId, now, now),
  ]);
  await boardStub(env, id).initialize({ id, owner: repository.owner, repo: repository.repo, fullName: repository.fullName, htmlUrl: repository.htmlUrl, isPrivate: repository.isPrivate });
  return Response.json({ ...boardSummary({ id, owner: repository.owner, repo: repository.repo, full_name: repository.fullName, repository_id: repository.id, installation_id: installationId, is_private: repository.isPrivate ? 1 : 0, html_url: repository.htmlUrl }), roleName }, { status: 201 });
}

async function executeCommand(request: Request, env: Env, board: BoardRecord, user: AuthenticatedUser, viewer: Viewer): Promise<Response> {
  const envelope = parseCommandEnvelope(await readJson(request));
  let internal: CommandEnvelope<InternalBoardCommand>;
  if (envelope.command.type === "link_pull_request") {
    const number = parsePullRequestUrl(envelope.command.url, board.owner, board.repo);
    const token = await installationToken(env, board.installation_id);
    const snapshot = await fetchPullRequestSnapshot(board.owner, board.repo, number, token);
    internal = { actionId: envelope.actionId, expectedRevision: envelope.expectedRevision, command: { type: "link_pull_request_snapshot", assignmentId: envelope.command.assignmentId, snapshot } };
  } else {
    internal = envelope as CommandEnvelope<InternalBoardCommand>;
  }
  const actor: Actor = { userId: user.userId, login: user.login };
  return Response.json(unwrap(await boardStub(env, board.id).execute(actor, viewer, internal, Date.now())));
}

async function refreshTask(env: Env, board: BoardRecord, viewer: Viewer, taskId: string): Promise<Response> {
  const stub = boardStub(env, board.id);
  const linked = unwrap(await stub.getLinkedPullRequest(taskId));
  const token = await installationToken(env, board.installation_id);
  const snapshot = await fetchPullRequestSnapshot(board.owner, board.repo, linked.number, token);
  unwrap(await stub.applyPullRequest(snapshot, "manual", Date.now()));
  return Response.json(unwrap(await stub.getView(viewer, false)));
}

async function connectSocket(request: Request, env: Env, board: BoardRecord, viewer: Viewer): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new RequestError("upgrade_required", "WebSocket upgrade is required", 426);
  const sourceUrl = new URL(request.url);
  const internalUrl = new URL("https://board.internal/socket");
  internalUrl.searchParams.set("revision", sourceUrl.searchParams.get("revision") ?? "0");
  const internal = new Request(internalUrl, {
    headers: {
      upgrade: "websocket",
      "x-board-viewer": JSON.stringify(viewer),
      "x-board-authorized-until": String(Date.now() + 60_000),
    },
  });
  return boardStub(env, board.id).fetch(internal);
}

async function authorizeBoard(request: Request, env: Env, board: BoardRecord): Promise<{ user: AuthenticatedUser | null; viewer: Viewer }> {
  const user = await userFromRequest(request, env);
  if (!user) {
    if (board.is_private) throw new RequestError("board_not_found", "Repository board was not found", 404);
    return { user: null, viewer: viewerFor(null, null, false) };
  }

  if (String(env.ENVIRONMENT) === "test") {
    const roleName = request.headers.get("x-test-role") ?? "read";
    if (board.is_private && !canReadForRole(roleName)) throw new RequestError("board_not_found", "Repository board was not found", 404);
    return { user, viewer: viewerFor(user, roleName, canMutateForRole(roleName)) };
  }
  if (board.installation_id === 0) return { user, viewer: viewerFor(user, "admin", true) };

  const now = Date.now();
  const cached = await env.DIRECTORY.prepare("SELECT role_name, checked_at FROM permission_cache WHERE user_id = ? AND board_id = ?")
    .bind(user.userId, board.id).first<{ role_name: string; checked_at: number }>();
  let roleName: string | null;
  if (cached && cached.checked_at > now - 60_000) {
    roleName = cached.role_name === "none" ? null : cached.role_name;
  } else {
    try {
      const token = await installationToken(env, board.installation_id);
      if (!token) throw new GitHubError("installation_missing", "GitHub installation is unavailable", 404);
      roleName = await collaboratorRole(board.owner, board.repo, user.login, token);
      await env.DIRECTORY.prepare(
        `INSERT INTO permission_cache (user_id, board_id, role_name, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, board_id) DO UPDATE SET role_name = excluded.role_name, checked_at = excluded.checked_at`,
      ).bind(user.userId, board.id, roleName ?? "none", now).run();
    } catch (error) {
      if (board.is_private) throw new RequestError("board_not_found", "Repository board was not found", 404);
      console.error(JSON.stringify({ event: "permission_check_failed", board: board.full_name, error: error instanceof Error ? error.message : "unknown" }));
      roleName = null;
    }
  }
  if (board.is_private && !canReadForRole(roleName)) throw new RequestError("board_not_found", "Repository board was not found", 404);
  return { user, viewer: viewerFor(user, roleName, canMutateForRole(roleName)) };
}

async function receiveWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readBoundedBody(request);
  if (!await verifyWebhookSignature(body, request.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET)) {
    throw new RequestError("invalid_webhook_signature", "Webhook signature is invalid", 401);
  }
  const eventName = request.headers.get("x-github-event") ?? "unknown";
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) throw new RequestError("missing_delivery_id", "Webhook delivery ID is required", 400);
  const payload = objectValue(JSON.parse(new TextDecoder().decode(body)) as unknown);
  const now = Date.now();
  await updateInstallationFromWebhook(env, payload, now);

  const repository = optionalRecord(payload.repository);
  if (!repository) return Response.json({ accepted: true }, { status: 202 });
  const fullName = optionalText(repository.full_name);
  if (!fullName) return Response.json({ accepted: true }, { status: 202 });
  const board = await env.DIRECTORY.prepare("SELECT id, owner, repo, full_name, repository_id, installation_id, is_private, html_url FROM boards WHERE lower(full_name) = lower(?)")
    .bind(fullName).first<BoardRecord>();
  if (!board) return Response.json({ accepted: true }, { status: 202 });

  const isPrivate = Boolean(repository.private);
  const htmlUrl = optionalText(repository.html_url) ?? board.html_url;
  await env.DIRECTORY.prepare("UPDATE boards SET is_private = ?, html_url = ?, updated_at = ? WHERE id = ?").bind(isPrivate ? 1 : 0, htmlUrl, now, board.id).run();
  await boardStub(env, board.id).initialize({ id: board.id, owner: board.owner, repo: board.repo, fullName: board.full_name, htmlUrl, isPrivate });
  if (!await boardStub(env, board.id).beginWebhook(deliveryId, now)) return Response.json({ accepted: true, duplicate: true }, { status: 202 });

  const numbers = pullRequestNumbers(payload);
  ctx.waitUntil(reconcileBoard(env, { ...board, is_private: isPrivate ? 1 : 0, html_url: htmlUrl }, `webhook:${eventName}`, numbers));
  return Response.json({ accepted: true }, { status: 202 });
}

async function updateInstallationFromWebhook(env: Env, payload: Record<string, unknown>, now: number): Promise<void> {
  const installation = optionalRecord(payload.installation);
  if (!installation || typeof installation.id !== "number") return;
  const account = optionalRecord(installation.account);
  const login = optionalText(account?.login) ?? "unknown";
  const type = optionalText(account?.type) ?? "unknown";
  const suspendedAt = installation.suspended_at ? now : null;
  await env.DIRECTORY.prepare(
    `INSERT INTO installations (installation_id, account_login, account_type, suspended_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
     suspended_at = excluded.suspended_at, updated_at = excluded.updated_at`,
  ).bind(installation.id, login, type, suspendedAt, now).run();
}

async function reconcileBoard(env: Env, board: BoardRecord, source: string, requestedNumbers?: number[]): Promise<void> {
  try {
    const stub = boardStub(env, board.id);
    const linked = requestedNumbers?.length
      ? requestedNumbers.map((number) => ({ taskId: "", number, nextReconcileAt: 0 }))
      : source === "scheduled"
        ? await stub.listPullRequestsDue(Date.now(), 25)
        : await stub.listLinkedPullRequests(100);
    if (linked.length === 0) return;
    const token = await installationToken(env, board.installation_id);
    for (const item of linked) {
      const snapshot = await fetchPullRequestSnapshot(board.owner, board.repo, item.number, token);
      unwrap(await stub.applyPullRequest(snapshot, source, Date.now()));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "pull_request_reconciliation_failed", board: board.full_name, source, error: error instanceof Error ? error.message : "unknown" }));
  }
}

function pullRequestNumbers(payload: Record<string, unknown>): number[] | undefined {
  const direct = optionalRecord(payload.pull_request);
  if (typeof direct?.number === "number") return [direct.number];
  const issue = optionalRecord(payload.issue);
  if (issue && optionalRecord(issue.pull_request) && typeof issue.number === "number") return [issue.number];
  for (const key of ["check_run", "check_suite"] as const) {
    const object = optionalRecord(payload[key]);
    if (!object || !Array.isArray(object.pull_requests)) continue;
    const numbers = object.pull_requests.map(optionalRecord).map((pull) => pull?.number).filter((value): value is number => typeof value === "number");
    if (numbers.length > 0) return [...new Set(numbers)];
  }
  return undefined;
}

async function boardRecord(env: Env, owner: string, repo: string): Promise<BoardRecord | null> {
  return env.DIRECTORY.prepare("SELECT id, owner, repo, full_name, repository_id, installation_id, is_private, html_url FROM boards WHERE lower(owner) = lower(?) AND lower(repo) = lower(?)")
    .bind(owner, repo).first<BoardRecord>();
}

function boardStub(env: Env, id: string): DurableObjectStub<RepoBoard> {
  return env.REPO_BOARD.getByName(id);
}

function boardSummary(board: BoardRecord): BoardSummary {
  return { id: board.id, owner: board.owner, repo: board.repo, fullName: board.full_name, htmlUrl: board.html_url, isPrivate: Boolean(board.is_private) };
}

async function readJson(request: Request): Promise<unknown> {
  const body = await readBoundedBody(request, 64 * 1024);
  if (body.byteLength === 0) throw new ValidationError("missing_body", "JSON body is required");
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new ValidationError("invalid_json", "Request body is not valid JSON");
  }
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw new RequestError(result.error.code, result.error.message, result.error.status);
}

function decodeRepoPart(value: string): string {
  return repoPart(decodeURIComponent(value), "repository path");
}

function decodeIdentifier(value: string | undefined): string {
  if (!value) throw new RequestError("invalid_identifier", "Identifier is missing", 400);
  const result = decodeURIComponent(value);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result)) throw new RequestError("invalid_identifier", "Identifier is invalid", 400);
  return result;
}

function repoPart(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new RequestError("invalid_repository", `${name} is invalid`, 400);
  return value;
}

function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new RequestError("cross_origin", "Cross-origin requests are not allowed", 403);
}

function isLocal(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestError || error instanceof ValidationError || error instanceof GitHubError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.message : "unknown" }));
  return Response.json({ error: "internal_error", message: "The request could not be completed" }, { status: 500 });
}

function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; connect-src 'self' wss: https://api.github.com; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
