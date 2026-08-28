# Browser acceptance and demo

This run is designed to fit under three minutes after the local Worker is running.

## Setup

1. Run `pnpm d1:migrate:local` and `pnpm dev:worker`.
2. Open `http://localhost:8787` in two browser contexts that support `document.modelContext`.
3. Use the development session, create the same repository board, and create one Todo ticket.

## Acceptance sequence

1. In both contexts, verify `list_tasks`, `inspect_task`, and `claim_task` are registered.
2. Call `claim_task` for the same ticket from both contexts with the same visible board revision. Exactly one succeeds; the loser receives `assignment_conflict` with `ownerLogin`, `leaseExpiresAt`, and `currentRevision`.
3. In the winning planning context, verify the registry replaces `claim_task` with `report_progress`, `release_task`, and `set_plan`. Call `set_plan`; confirm the ticket appears in Ready and the planning assignment closes.
4. Claim the Ready ticket for implementation. Verify `read_plan`, `update_plan`, and `start_work` appear. Update the plan once, call `start_work`, and confirm In Progress appears live in the other context.
5. Call `report_progress` with a phase, bounded summary, and test/file counts. Confirm the card labels the values “Agent-reported status.”
6. Link an open PR from the same repository. Confirm the ticket moves to In PR and the registry exposes `read_pull_request`, `read_review`, and `check_status`.
7. Change a review or check on GitHub and call `check_status`. Confirm approvals, changes requested, comments, and failed or pending check names update.
8. Merge the PR and refresh. Confirm the ticket moves to Done and its assignment closes. A closed-unmerged PR should instead return to In Progress.
9. Select the Done task and call `archive_task`. Decline once and confirm nothing changes. Call again, approve in the page, and confirm it disappears from the default board while `?archived=1` still returns its history to an authorized collaborator.

## Resilience probes

- Reload during an assignment: the current tab restores its assignment ID from `sessionStorage`; another tab may pin a different assignment owned by the same user.
- Disconnect and reconnect after a mutation: the socket request supplies its last revision and receives missed events with the current snapshot.
- Let a lease expire without calling tools: the ticket stays in its column and becomes claimable by another agent.
- Replay an action with the same idempotency key: the stored result returns without a second mutation.
- Deliver an older PR snapshot after a newer one: it must not regress the cached state; scheduled reconciliation repairs webhook gaps.
