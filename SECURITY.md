# Security

## Reporting

Please report a suspected vulnerability privately to the repository owner. Do not include live session tokens, GitHub App keys, webhook secrets, or private repository content in a public issue.

## Trust boundaries

- Ticket descriptions, plans, progress summaries, review bodies, comments, check names, and other GitHub text are untrusted content.
- Untrusted text is rendered as text, never injected as HTML, and cannot control WebMCP registration, authorization, network destinations, or secrets.
- Every board mutation requires an authenticated user with current repository mutation access, an idempotency key, and the expected board revision.
- Assignment-scoped commands are checked against the authenticated session user inside the repository Durable Object.
- Private repository access fails closed when GitHub authorization cannot be verified.
- Pull request URLs must use HTTPS on `github.com` and match the board's exact `owner/repo`.

## Credentials and sessions

Store `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_WEBHOOK_SECRET` with `wrangler secret put`. Never add their values to `wrangler.jsonc`, `.dev.vars.example`, logs, tickets, or plans.

The GitHub OAuth access token is discarded after identity lookup. Local sessions use random bearer tokens; D1 stores only SHA-256 hashes. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. Each browser tab stores only its active assignment ID in `sessionStorage`; that identifier is not accepted as proof of ownership.

## Webhooks and reconciliation

Webhook signatures are verified against the raw body with HMAC-SHA-256 and constant-time verification. Delivery IDs are deduplicated in the repository Durable Object. Webhooks reduce latency; scheduled live reconciliation remains the correctness path for missed or misordered delivery.

## Deployment checklist

- Replace the placeholder D1 database ID and GitHub App public configuration.
- Set all four Worker secrets.
- Apply D1 migrations before deploying the new Worker version.
- Keep GitHub App permissions read-only and limited to the documented list.
- Register the exact production callback and webhook URLs.
- Run `pnpm check` and `pnpm deploy:dry`.
