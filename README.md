# Repo Board

Repo Board is a real-time task board for one GitHub repository. Humans define and groom the work; browser-native WebMCP tools let Codex agents claim it, attach delegated plans, report progress, and follow a pull request through review and merge.

The workflow has exactly five columns:

`Todo → Ready → In Progress → In PR → Done`

Archiving is a terminal flag on Done tasks, not another column. Archived history remains available to repository collaborators.

## What is implemented

- Atomic 15-minute assignment leases in one SQLite-backed Durable Object per `owner/repo`
- Revision-checked, idempotent task mutations and structured claim conflicts
- Immutable ticket and delegated-plan revisions with an append-only activity log
- Hibernating WebSockets with full snapshots, missed-event replay, and automatic reconnects
- Dynamic `document.modelContext` tool profiles that are replaced as page context changes
- Per-tab assignment pinning in `sessionStorage` with session-user ownership enforced in the Durable Object
- Read-only GitHub App login, installation access, collaborator-role authorization, webhooks, and PR reconciliation
- D1 limited to users, hashed sessions, installations, permission cache, and the repository-to-board directory
- Normalized reviews, comments, checks, statuses, merge completion, and closed-unmerged rollback
- Human-confirmed archival from both the UI and WebMCP

The controlling product and technical specification lives at [plans/webmcp-repo-board.md](plans/webmcp-repo-board.md).

## Architecture

The Worker handles authentication, repository authorization, GitHub network calls, API routing, and static assets. D1 is the global directory. Each repository's Durable Object owns its task state and serializes all mutations before broadcasting the resulting revision.

```text
React + WebMCP tools
        │ HTTP / WebSocket
Cloudflare Worker ─── GitHub App API + webhooks
        │
        ├── D1: identities, hashed sessions, installations, board directory
        │
        └── RepoBoard Durable Object: tasks, plans, leases, PR snapshots, event log
```

GitHub calls finish in the Worker before a normalized snapshot is applied to the Durable Object. No serialized state path stays open across an external network request.

## Local development

Use Node 24 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm d1:migrate:local
pnpm dev:worker
```

Open `http://localhost:8787`. Local development offers a clearly labeled development session and can create public stand-in repository boards without GitHub credentials. Pull-request webhooks are optional locally; the scheduled reconciliation path is the correctness mechanism.

For the split Vite experience, run `pnpm dev:worker` and `pnpm dev` in separate terminals, then open the Vite URL.

## GitHub App setup

Create one GitHub App and configure:

- User authorization callback: `https://YOUR_WORKER/auth/callback`
- Webhook URL: `https://YOUR_WORKER/webhooks/github`
- Repository permissions, all read-only: Metadata, Pull requests, Checks, Commit statuses, Issues
- Events: installation, installation repositories, repository, pull request, pull request review, pull request review comment, issue comment, check run, check suite, status

The OAuth user token is used only to read the signed-in identity and is then discarded. Repository queries use short-lived installation tokens. The app's private key may be GitHub's PKCS#1 PEM or a PKCS#8 PEM.

Create D1 and put its returned ID in `wrangler.jsonc`:

```sh
pnpm wrangler d1 create repo-board-directory
pnpm d1:migrate:remote
```

Set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_SLUG` in `wrangler.jsonc`. Store the remaining values as Worker secrets:

```sh
pnpm wrangler secret put GITHUB_APP_ID
pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm wrangler secret put GITHUB_APP_CLIENT_SECRET
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
```

Then install the app on the repositories that may have boards and deploy:

```sh
pnpm deploy
```

Private repositories fail closed. Existing public boards remain anonymously readable. Only effective `triage`, `write`, `maintain`, or `admin` collaborators can mutate a board.

## WebMCP workflow

The page always exposes `list_tasks` and `inspect_task`. An authorized unassigned page also exposes `claim_task`. Once the current tab pins an assignment, the registry switches to the tools legal for that ticket state. General read tools are reused; there is intentionally no parallel `read_task` tool.

“Copy planning prompt” and “Copy implementation prompt” include the board URL and ticket ID, but do not reserve work. The first valid `claim_task` wins. Assigned tool calls renew the lease; an idle browser tab does not.

Ticket, plan, progress, review, and GitHub content is untrusted data. It is bounded in schemas and results and cannot select tools, authorize a mutation, choose a repository, or provide secrets.

## Verification

```sh
pnpm check
pnpm deploy:dry
```

`pnpm check` runs ESLint, both TypeScript projects, Node tests, Miniflare Worker/Durable Object tests, and the production build. The Worker suite covers D1 routing, role authorization, session isolation, concurrent claims, idempotency, lease expiry and takeover, SQLite persistence across eviction, WebSocket replay, webhook verification, PR normalization, and the full workflow.

The repeatable demo and browser acceptance script is in [evals/browser-acceptance.md](evals/browser-acceptance.md).

## Deliberate v1 boundaries

Repo Board owns its tasks. It does not synchronize GitHub Issues or Projects, launch agents, read native Codex telemetry, or support anonymous writes. A task links at most one pull request.

## License

MIT
