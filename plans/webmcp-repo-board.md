# Repo Board: real-time WebMCP task coordination

## Summary

Create a new sibling repository, `/Users/zac/Documents/ChatGPT/WebMCP Repo Board`, published as `webmcp-repo-board`. Preserve Card Table and its uncommitted work. Copy its proven React, Worker, Durable Object, WebSocket, session, and WebMCP patterns without extracting a shared package.

Repo Board is a five-column board for one GitHub repository:

`Todo → Ready → In Progress → In PR → Done`

Archived is not a sixth column. Archiving sets a terminal flag on a Done task that hides it from the default board view while keeping its history queryable, which is why `TaskColumn` below has exactly five values.

Board-owned tasks move through typed WebMCP operations. A repository-scoped Durable Object serializes claims, transitions, and broadcasts, preventing two agents from owning the same assignment. Cloudflare recommends Durable Objects for exactly this kind of strongly consistent, real-time coordination. [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) and [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Every GitHub repository has a stable entry route at `/boards/:owner/:repo`. A public repository with no stored board renders as an empty revision-0 preview without creating a Durable Object or D1 directory row. Signing in returns to the same route; if the GitHub App can verify that the user has a mutating collaborator role, that authenticated read atomically materializes the board. A private, nonexistent, or inaccessible route returns the same opaque response and the UI places a sign-in gate over an empty board shell, so signed-out requests cannot probe private repository existence.

## Product and workflow

- The UI is kanban-style, but arbitrary dragging is disabled. State changes must satisfy workflow rules.
- Humans can enter any `owner/repo` from the landing page or navigate directly to `/boards/:owner/:repo`; an explicit board-creation flow is not required.
- Humans create and edit Todo tickets in the UI. Each ticket has an immutable repository-local two-word reference, a title, Markdown description, revision history, activity log, and optional linked PR. UUIDs remain internal storage keys.
- “Plan with Codex” copies a prompt containing the board URL and ticket reference. “Implement with Codex” does the same for Ready or stale work.
- Copying does not reserve the ticket. The first authorized agent to call `claim_task` receives the assignment. A simultaneous caller gets a structured conflict with the current owner and lease expiry.
- Planning is delegated approval: the human’s choice to start a planning task authorizes its agent to call `set_plan`. Submission creates an immutable plan revision, moves Todo to Ready, and closes the planning assignment.
- A Ready assignment remains in Ready while the agent reads or updates the plan. `update_plan` creates another delegated-approved revision. `start_work` moves it to In Progress.
- Linking a valid open PR from the same repository moves the task to In PR. Merge moves it automatically to Done. Closing without merge returns it to In Progress.
- Done tickets can be archived through the UI or an `archive_task` tool that waits for explicit in-page confirmation.

Assignments use renewable 15-minute leases. Assignment tool calls renew the lease; an open browser tab alone does not. Expired work remains in its current column but becomes claimable for takeover. Every mutation includes an idempotency key and expected board revision, so a stale agent immediately learns that ownership or state changed.

## Technical architecture and interfaces

### Storage and real-time state

- One SQLite-backed `RepoBoard` Durable Object per `owner/repo`.
- Its SQLite database owns tasks and their unique two-word references, plan revisions, assignments, progress reports, PR snapshots, processed actions, processed webhook deliveries, and the append-only board event log.
- D1 stores only global data: GitHub identities, hashed web sessions, installations, and the `owner/repo → boardId` directory for materialized boards. Public previews are cached briefly at the edge and do not create database state.
- Accepted commands update Durable Object SQLite atomically, increment the board revision, and then broadcast a revisioned update through hibernating WebSockets.
- Reconnecting clients send their last revision and receive either missed events or a full snapshot.
- One Durable Object alarm tracks the earliest due item across lease expiries and the next PR reconciliation poll. Reconciliation polling is the correctness path — it repairs any missed, delayed, or misordered webhook — so webhooks only reduce latency. A useful consequence: local development works end to end with no public webhook endpoint.
- GitHub API calls happen in the Worker before applying a normalized snapshot to the Durable Object. The object never holds its serialized state path open across external network calls.

Core types:

```ts
type TaskColumn = "todo" | "ready" | "in_progress" | "in_pr" | "done";
type AssignmentKind = "planning" | "implementation";
type AgentPhase =
  | "investigating"
  | "planning"
  | "implementing"
  | "testing"
  | "waiting"
  | "blocked";

interface CommandEnvelope<T> {
  actionId: string;
  expectedRevision: number;
  command: T;
}
```

Self-reported agent telemetry includes phase, claimed time, last activity, lease expiry, latest bounded summary, and optional counts for files changed, commits, passing tests, and failing tests. The UI labels these values as agent-reported. Native Codex task IDs, token usage, message counts, and task APIs are explicitly excluded.

### Dynamic WebMCP profiles

Register tools through `document.modelContext`, with one `AbortController` per active profile. Abort and replace the profile whenever authentication, route, selection, assignment, or ticket state changes. Serialize registration and guard against stale React effects. Aborting the registration signal is the current standard mechanism for removing imperative tools. [WebMCP specification](https://github.com/webmachinelearning/webmcp/blob/main/index.bs).

| Context | Tools |
|---|---|
| Anonymous or read-only | `list_tasks`, `inspect_task` |
| Authorized, unassigned | read tools plus `claim_task` |
| Assigned Todo | read tools plus `report_progress`, `set_plan`, `release_task` |
| Assigned Ready | read tools plus `read_plan`, `update_plan`, `report_progress`, `start_work`, `release_task` |
| Assigned In Progress | read tools plus `read_plan`, `report_progress`, `link_pull_request`, `release_task` |
| Assigned In PR | read tools plus `read_pull_request`, `read_review`, `check_status`, `report_progress`, `release_task` |
| Selected Done task | read tools plus confirmed `archive_task` |

`list_tasks` and `inspect_task` are the only general read tools; assigned profiles reuse them rather than registering a parallel `read_task`. For an assigned agent, `inspect_task` additionally includes its own assignment, lease expiry, and latest progress report.

Ticket, plan, progress, and GitHub text is untrusted content. Tool descriptions and bounded results state this explicitly. User-authored text never selects tools, changes authorization, chooses network destinations, or supplies secrets.

### GitHub authentication and PR status

Use one read-only GitHub App for login, repository installation, API access, and webhooks:

- App permissions: Metadata, Pull requests, Checks, Commit statuses, and Issues, all read-only.
- Webhooks: installation changes, repository changes, pull requests, reviews, review comments, PR conversation comments, check runs, check suites, and commit statuses.
- Verify `X-Hub-Signature-256` against the raw request body with constant-time comparison and deduplicate `X-GitHub-Delivery`. [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- Exchange GitHub’s OAuth callback for user identity, create a hashed local session, and discard the short-lived user token. Use installation credentials for later repository queries. [GitHub App user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
- Resolve effective collaborator permission through GitHub's permission endpoint, which needs only Metadata read. Anonymous users and `read` users are read-only. `triage`, `write`, `maintain`, and `admin` users may mutate the board. Read the response's `role_name`, not the legacy `permission` field: `permission` collapses `triage` into `read` and `maintain` into `write`, which would wrongly deny every triage user. [Repository permission endpoint](https://docs.github.com/en/rest/collaborators/collaborators).
- Existing public-repository boards are anonymously readable. Public repositories without boards are also anonymously readable as empty virtual previews. Private, missing, and inaccessible routes share one opaque signed-out response; after sign-in, private repositories remain fail-closed unless the app is installed and GitHub verifies repository access.
- OAuth carries only a validated same-origin board return path, so direct repository URLs survive the GitHub sign-in round trip without introducing an open redirect.
- Cache authorization briefly, at most 60 seconds, and fail closed when GitHub cannot verify private access.
- Store the App ID, private key, webhook secret, and OAuth client secret as Worker secrets via `wrangler secret put`. Production registers the deployed callback and webhook URLs; local development leans on reconciliation polling instead of forwarded webhooks.

Session and assignment identity differ from Card Table on purpose. Card Table needed seat-scoped cookies because seats were anonymous bearer credentials; Repo Board has real authenticated users, so assignment ownership is a database fact, not a cookie. One `HttpOnly`, `Secure`, `SameSite` session cookie identifies the GitHub user across every tab in the browser. Each tab pins its active ticket and assignment ID in `sessionStorage`, every mutating command carries that assignment ID, and the Durable Object verifies the assignment belongs to the session's user before applying it. Two Codex threads sharing one cookie jar can therefore hold different assignments concurrently without clobbering each other's credentials.

A normalized PR snapshot contains PR number, URL, draft/open/closed/merged state, head SHA, approvals, current changes-requested reviewers, review-comment count, conversation-comment count, check totals, failed/pending check names, and last synchronization time. `read_review` returns bounded recent review details; `check_status` performs a live refresh and repairs missed webhook state.

## Verification and delivery

- Reducer tests cover every legal transition and reject skipped columns, wrong assignment kinds, stale revisions, cross-repository PRs, closed PR linking, and invalid archival.
- Concurrency tests issue simultaneous claims and prove exactly one succeeds. Cover duplicate actions, expiry, takeover, stale-agent mutations, release, and planner completion.
- Authorization tests cover anonymous public reads, stateless public previews, indistinguishable private/missing routes, lazy materialization, each GitHub role including `triage` via `role_name`, session isolation, revoked access, CSRF state, safe OAuth return paths, and two tabs of one session holding different assignments without interference.
- WebMCP tests assert the exact registry for every context, two-word reference lookup, profile cleanup, duplicate-name prevention, bounded schemas/results, cancellation, confirmation, and UI/tool parity.
- GitHub tests verify webhook signatures and deduplication, review/check normalization, delayed-event ordering, manual refresh, merge-to-Done, and closed-unmerged rollback.
- Worker tests cover Durable Object eviction, persistence, WebSocket replay/resynchronization, alarm-driven lease expiry, and D1 board lookup.
- Browser acceptance demonstrates two agents racing for one task, a planning handoff, dynamic tool replacement, Ready-to-work transition, live progress, PR linkage, review changes, checks, merge, and archival.

Build in five focused slices: scaffold and state model; board UI plus real-time claims; dynamic WebMCP and copied prompts; GitHub App and PR synchronization; adversarial tests, polish, deployment, and the under-three-minute demo.

Assumptions: one materialized board per repository, one linked PR per task, board-owned tasks rather than GitHub Issues, no GitHub Projects synchronization, no agent launching, no native Codex telemetry, no anonymous writes, and no shared-package monorepo in v1.
