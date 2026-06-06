# PR Review Surface — Deploy Readiness

## VERDICT: GO-after-blockers

The feature code is build- and typecheck-clean; the blockers are a missing DB migration, an unmerged/uncommitted tree, and a pre-existing CI typecheck error that gates the PR.

## Blockers (must clear before deploy)

1. **No Drizzle migration for the new tables/column.** Schema TS adds `kanban_boards`, `kanban_columns`, `kanban_cards` (`packages/db/src/schema/kanban.ts`) plus a `requested_reviewers` jsonb column (`packages/db/src/schema/github.ts`). `grep -rli "kanban|requested_reviewers|review_request" packages/db/drizzle/` returns no matches; latest committed migration is 0057. Without a committed `.sql`, `bun drizzle-kit migrate` (deploy-production.yml:41) changes nothing and the router/webhook writes will hit missing tables.
   - Action: `bunx drizzle-kit generate --name="add_kanban_pr_review_tables"`, apply on a fresh Neon branch with `DATABASE_URL_UNPOOLED`, commit the generated files (never hand-edit `packages/db/drizzle/`).

2. **Work is uncommitted, no PR, branch misnamed.** The entire surface (reviews/, kanban router, schema, webhook, electric-proxy where-clauses) sits in the working tree on `feat/pr-review-surface` (HEAD 8bf778318), layered on 27 unrelated Daytona commits. No PR exists.
   - Action: stage only the reviews/kanban files, commit, push, open PR. Exclude the unrelated uncommitted dev hacks (`apps/api/next.config.ts`, `apps/desktop/src/main/index.ts`).

3. **CI typecheck gate is RED (pre-existing, but blocks the PR).** `bun run typecheck` fails with exactly 1 error: `packages/host-service/src/terminal/DaemonClient/DaemonClient.ts:86 error TS2345` (`'string | NonSharedBuffer'` not assignable to `Buffer<ArrayBufferLike>`). File is byte-identical to main; not caused by this feature. ci.yml runs `bun run typecheck` as a required job on every PR, so it will block merge regardless of origin.
   - Action: fix the `socket.on("data", ...)` Buffer typing in DaemonClient.ts (cast/narrow chunk to Buffer), or get a separate fix merged to main first so the gate is green.

4. **Lint gate is RED (1 error, auto-fixable).** `bun run lint` reports 1 error in `apps/api/next.config.ts` (single-line rewrite object must be multi-line). This is uncommitted, unrelated work, but the lint job treats warnings/errors as failures.
   - Action: `bun run lint:fix`, then keep next.config.ts out of the feature PR (or commit the formatting fix separately).

## Warnings (should-do)

- **Zero tests on all new code (45 reviews/ files + kanban).** Untested pure logic with real edge cases: `deriveReviewBucket`/`prIconState` (reviewStatus.ts), `isNeedsMyReview` (useReviewsData.ts), `computeDropPosition`/`endPosition` (KanbanBoardView.tsx, the position math most likely to collide), `extractRequestedReviewers` (webhooks.ts), `getPRDiff`/`getPRFiles` (host-service github.ts). Add dependency-free unit tests for these four before merge. `apps/api` and `packages/db` have no `test` script.
- **Pre-existing trpc test failure is unrelated.** `v2-project.test.ts` fails on a bun module-resolution quirk (`verifyOrgOwner` not found, though it IS exported). Not caused by this change; kanban adds only 2 lines to `root.ts`.
- **GitHub App event subscription: NO change needed.** The new `pull_request.review_requested` / `review_request_removed` handlers are actions of the already-subscribed `pull_request` event; `pull_request_review.submitted` (feeds reviewDecision) is already handled in prod. App installation per-repo still gates board coverage.
- **host-service ships only via a desktop release.** `getPRDiff`/`getPRFiles` are bundled into the Electron app — no standalone service deploy. A desktop release carrying them inherits the rollout-readiness P0s (clean-tree release cut, `NODE_ENV=production`).
- **API build needs prod secrets at build time.** `next build` failed locally only on missing `DATABASE_URL`, `SECRETS_ENCRYPTION_KEY`, `DURABLE_STREAMS_URL`, `DURABLE_STREAMS_SECRET`, `RELAY_URL` during page-data collection (pre-existing route). Compile succeeded ("Compiled successfully in 6.8s"). Ensure CI/deploy env has these set.

## What's verified green

- New feature packages typecheck clean (fresh, cache-miss): `@superset/desktop` (reviews/), `@superset/trpc` (kanban), `@superset/db`, `@superset/api` compile, electric-proxy. Zero `error TS` lines from new code.
- `@superset/api` Next.js compile succeeds; `@superset/host-service` build PASS (dist emitted).
- The feared CodeEditor/CodeMirror duplicate typecheck failure did NOT occur.
- Existing tests for changed packages pass: host-service github units 55/0; api scoped-token 15/0; trpc task 8/8. No existing test broke from this change.
- No new env var introduced by the feature (only existing `NEXT_PUBLIC_API_URL`, already baked).

## Deploy order (once blockers cleared)

1. Fix DaemonClient.ts Buffer type (blocker 3) + `bun run lint:fix` (blocker 4); confirm `bun run typecheck` and `bun run lint` exit 0.
2. Generate migration (`drizzle-kit generate --name="add_kanban_pr_review_tables"`); commit generated `.sql` + meta.
3. Commit feature files, push branch, open PR; CI must be green.
4. Apply migration to **production** Neon via the deploy pipeline (`bun drizzle-kit migrate`, `DATABASE_URL_UNPOOLED`) — tables/column must exist BEFORE the API webhook writes go live.
5. Deploy API (webhook `requested_reviewers` write) — depends on step 4.
6. Cut desktop release (clean tree, `NODE_ENV=production`) to ship reviews/ UI + host-service `getPRDiff`/`getPRFiles`.
