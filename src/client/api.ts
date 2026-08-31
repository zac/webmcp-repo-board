import type { BoardCommand, BoardSummary, BoardView, CommandEnvelope } from "../shared";

export interface AppConfig {
  localDevelopment: boolean;
  githubLoginUrl: string;
  githubInstallUrl: string;
}

export interface SessionUser {
  userId: string;
  githubId: number;
  login: string;
  avatarUrl: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: { currentRevision?: number; ownerLogin?: string; ownerAgentLabel?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getConfig(signal?: AbortSignal): Promise<AppConfig> {
  return request<AppConfig>("/api/config", { signal });
}

export async function getSession(signal?: AbortSignal): Promise<SessionUser | null> {
  return (await request<{ user: SessionUser | null }>("/api/session", { signal })).user;
}

export async function createDevelopmentSession(signal?: AbortSignal): Promise<SessionUser> {
  return (await request<{ user: SessionUser }>("/api/dev/session", { method: "POST", signal })).user;
}

export async function logout(signal?: AbortSignal): Promise<void> {
  await request<void>("/api/logout", { method: "POST", signal });
}

export async function listBoards(signal?: AbortSignal): Promise<BoardSummary[]> {
  return (await request<{ boards: BoardSummary[] }>("/api/boards", { signal })).boards;
}

export async function createBoard(owner: string, repo: string, signal?: AbortSignal): Promise<BoardSummary> {
  return request<BoardSummary>("/api/boards", { method: "POST", body: JSON.stringify({ owner, repo }), signal });
}

export async function getBoard(owner: string, repo: string, includeArchived = false, signal?: AbortSignal): Promise<BoardView> {
  return request<BoardView>(`/api/boards/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${includeArchived ? "?archived=1" : ""}`, { signal });
}

export async function executeCommand(board: BoardView, command: BoardCommand, signal?: AbortSignal): Promise<BoardView> {
  const envelope: CommandEnvelope = { actionId: crypto.randomUUID(), expectedRevision: board.revision, command };
  return request<BoardView>(`/api/boards/${encodeURIComponent(board.owner)}/${encodeURIComponent(board.repo)}/commands`, {
    method: "POST",
    body: JSON.stringify(envelope),
    signal,
  });
}

export async function refreshPullRequest(board: BoardView, taskId: string, signal?: AbortSignal): Promise<BoardView> {
  return request<BoardView>(`/api/boards/${encodeURIComponent(board.owner)}/${encodeURIComponent(board.repo)}/refresh/${encodeURIComponent(taskId)}`, {
    method: "POST",
    signal,
  });
}

export function boardSocketUrl(board: BoardView): string {
  const url = new URL(`/api/boards/${encodeURIComponent(board.owner)}/${encodeURIComponent(board.repo)}/socket`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("revision", String(board.revision));
  url.searchParams.set("client", boardClientIdentity().id);
  return url.toString();
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  const client = boardClientIdentity();
  headers.set("x-repo-board-client-id", client.id);
  headers.set("x-repo-board-client-capability", client.capability);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await safeJson(response);
    throw new ApiError(
      typeof body.error === "string" ? body.error : "request_failed",
      typeof body.message === "string" ? body.message : `Request failed with ${response.status}`,
      response.status,
      {
        ...(Number.isSafeInteger(body.currentRevision) ? { currentRevision: Number(body.currentRevision) } : {}),
        ...(typeof body.ownerLogin === "string" ? { ownerLogin: body.ownerLogin } : {}),
        ...(typeof body.ownerAgentLabel === "string" ? { ownerAgentLabel: body.ownerAgentLabel } : {}),
      },
    );
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const CLIENT_ID_KEY = "repo-board:client-id";
const CLIENT_CAPABILITY_KEY = "repo-board:client-capability";

export function boardClientIdentity(): { id: string; capability: string } {
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  let capability = sessionStorage.getItem(CLIENT_CAPABILITY_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  if (!capability) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    capability = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(CLIENT_CAPABILITY_KEY, capability);
  }
  return { id, capability };
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}
