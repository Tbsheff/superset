# PR Review Surface — Design Document

**Date:** 2026-06-06
**Status:** Proposed
**Author:** Lead architect (synthesis)

## 1. Verdict / Approach

Build a "PR Review" surface inside the desktop app that copies DiffKit's review architecture and UI **but reuses Superset's existing stack instead of rebuilding it**. The three reuse decisions that define this:

- **Diff rendering:** Keep `@pierre/diffs` (already a dependency at `apps/desktop/package.json:80`, used by `LightDiffViewer.tsx`). DiffKit uses the same engine. No new diff library.
- **PR data:** Reuse the two PR backends that already exist. Live ad-hoc data (single PR, search, merge) comes from host-service tRPC (`github.*`, `pullRequests.*`). Canonical org-wide PR state already syncs via webhooks into `packages/db/src/schema/github.ts` → `githubPullRequests` (Postgres). We expose that table over an Electric shape and read it as a local TanStack DB collection — exactly the `tasks` pattern.
- **Team kanban:** The only genuinely new persistence. Three small org/team-scoped tables (`kanban_boards`, `kanban_columns`, `kanban_cards`), synced via Electric, following the `tasks` collection + txid write path verbatim.

DiffKit's edge cache + webhook-revalidation layer is **not** ported — Superset already has the equivalent (webhook → Postgres → Electric → local SQLite). We get DiffKit's "snappy, local-first review dashboard" feel for free because Electric + persisted TanStack collections already deliver it.

**Net new build surface:** 3 DB tables + 1 migration, 3 Electric proxy cases, 1 TanStack collection group, 1 tRPC router, 1 route tree (`/pr-review`), one sidebar entry, and the board + detail/diff React components. Everything else is reuse.

## 2. Architecture

### Data flow (prose)

**Synced canonical PR data (read-mostly, team-shared):**
```
GitHub webhook
  → apps/api/src/app/api/github/webhook/route.ts (verify + idempotent store)
  → webhooks.ts handlers (upsert githubPullRequests: state, reviewDecision, checks, draft, stats)
  → Postgres githubPullRequests (packages/db/src/schema/github.ts:109)
  → Electric shape (apps/electric-proxy: WHERE organization_id = $1)
  → TanStack DB collection `githubPullRequests-${orgId}` (persisted to Electron SQLite)
  → useLiveQuery in React (instant, cache-first)
```

**Team kanban state (read-write, team-shared):**
```
React drag/edit
  → optimistic collection.update() (instant)
  → onUpdate handler → apiClient.kanbanCard.move.mutate() (tRPC)
  → dbWs.transaction: UPDATE + getCurrentTxid()
  → returns { txid } → electricTxidMatch(txid)
  → Postgres kanban_cards → Electric shape → collection reconciles by txid
```

**Live on-demand PR detail / diff (not persisted, not synced):**
```
Open PR detail
  → host-service tRPC github.getPR / pullRequests.getContent (live Octokit / gh CLI)
  → React Query (in-memory cache) → @pierre/diffs CodeView
  → merge: github.mergePR (live mutation)
```

### Where each kind of state lives — explicit resolution

| Data | Source | Persistence | Sync model | Why |
|---|---|---|---|---|
| Kanban columns/cards (board layout) | New `kanban_*` tables | Postgres + Electron SQLite | **Electric-synced, team-shared** | Must be shared across the team and survive offline; this is the one stateful artifact. |
| Org-wide PR list + status (state, reviewDecision, checks, draft, stats) | `githubPullRequests` (already webhook-fed) | Postgres + Electron SQLite | **Electric-synced (read-mostly)** | Already maintained by webhooks; expose as a shape and it's free + snappy. |
| Single-PR diff content / file list | host-service `pullRequests.getContent`, `github.getPR` | None (React Query memory) | **Live-fetched** | Diffs are large and ephemeral; never worth persisting. Fetch on detail open. |
| PR search (creating/linking cards) | host-service `searchPullRequests` | None | **Live-fetched** | Already gh-CLI/Octokit backed; transient. |
| Merge / merge result | host-service `github.mergePR` | None | **Live mutation** | Write-through to GitHub; webhook reflects the result back into the synced table. |

**Resolution rule:** persist + sync only the kanban board and the already-synced PR snapshot. Everything diff-heavy or one-off stays live via host-service tRPC + React Query. Card↔PR linkage stores a stable `githubPullRequestId` FK (plus a denormalized `prUrl`), so the board renders instantly from synced data and only fetches the heavy diff when a card is opened.

## 3. Diff Rendering Decision

**Use `@pierre/diffs` (Pierre's own engine) — already installed, no change.** This is the genuine Pierre diff renderer (Apache-2.0), the same library DiffKit patches in. The desktop app already ships it at `1.2.2`; bump to `1.2.7` opportunistically.

Integration:
- **Multi-file review surface:** use `CodeView` from `@pierre/diffs/react` for the PR diff page — it owns virtualization, sticky headers, scroll anchoring, and the paged-scroll scaffold for diffs taller than the browser's ~33M px limit. This is the key perf primitive; DiffKit's hand-rolled IntersectionObserver chunking is unnecessary because `CodeView` virtualizes natively.
- **Single file / smaller diffs:** reuse the existing `MultiFileDiff` wrapper pattern from `LightDiffViewer.tsx`.
- **Theme:** reuse `getDiffsTheme(activeTheme)` from `WorkspaceView/utils/code-theme/diff-viewer-style.ts` and `useResolvedTheme()` for light/dark.
- **Perf strategy:** (1) `CodeView` virtualization + worker-pool Shiki highlighting (`disableWorkerPool={false}` — off-main-thread by default); (2) word-level inline diff only for small patches, matching DiffKit's `< 400 changes / < 24KB` gate; (3) lazy-load the diff page route so Shiki/worker assets aren't in the board bundle.
- **Inline comments:** `lineAnnotations` + `renderAnnotation` + `enableLineSelection` + `selectedLines`/`onSelectedLinesChange` give us DiffKit's gutter-click → inline comment form for free.

No fallback library needed. (`@git-diff-view/react` is the only viable alternative if a license constraint ever forced it; not relevant here.)

## 4. Data Model

### Drizzle schema — add to `packages/db/src/schema/schema.ts`

Three tables, org+team scoped, denormalized `organizationId` on every row for Electric filtering. `position` uses `real()` for fractional reordering (move-between-two-cards without renumbering).

```typescript
export const kanbanBoards = pgTable("kanban_boards", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  name: text().notNull(),
  slug: text().notNull(),
  description: text(),
  createdByUserId: uuid("created_by_user_id").notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("kanban_boards_organization_id_idx").on(t.organizationId),
  index("kanban_boards_team_id_idx").on(t.teamId),
  uniqueIndex("kanban_boards_team_slug_unique").on(t.teamId, t.slug),
  index("kanban_boards_deleted_at_idx").on(t.deletedAt),
]);

export const kanbanColumns = pgTable("kanban_columns", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  boardId: uuid("board_id").notNull()
    .references(() => kanbanBoards.id, { onDelete: "cascade" }),
  name: text().notNull(),
  position: real().notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("kanban_columns_organization_id_idx").on(t.organizationId),
  index("kanban_columns_board_id_idx").on(t.boardId),
  index("kanban_columns_deleted_at_idx").on(t.deletedAt),
]);

export const kanbanCards = pgTable("kanban_cards", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  columnId: uuid("column_id").notNull()
    .references(() => kanbanColumns.id, { onDelete: "cascade" }),
  // Link to canonical synced PR row; prUrl denormalized for instant render
  githubPullRequestId: uuid("github_pull_request_id")
    .references(() => githubPullRequests.id, { onDelete: "set null" }),
  prUrl: text("pr_url"),
  title: text().notNull(),
  position: real().notNull(),
  assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("kanban_cards_organization_id_idx").on(t.organizationId),
  index("kanban_cards_column_id_idx").on(t.columnId),
  index("kanban_cards_github_pull_request_id_idx").on(t.githubPullRequestId),
  index("kanban_cards_assignee_id_idx").on(t.assigneeId),
  index("kanban_cards_deleted_at_idx").on(t.deletedAt),
]);
```

**Migration command (never hand-edit `packages/db/drizzle/`):**
```bash
bunx drizzle-kit generate --name="add_kanban_pr_review_tables"
```
Run on a fresh Neon branch; deploy DDL with `DATABASE_URL_UNPOOLED`.

### Electric proxy — add to `apps/electric-proxy/src/where.ts`

```typescript
case "kanban_boards":  return build(kanbanBoards, kanbanBoards.organizationId, organizationId);
case "kanban_columns": return build(kanbanColumns, kanbanColumns.organizationId, organizationId);
case "kanban_cards":   return build(kanbanCards, kanbanCards.organizationId, organizationId);
case "github_pull_requests": return build(githubPullRequests, githubPullRequests.organizationId, organizationId);
```
(Team filtering is client-side after the org-scoped sync, per repo convention.) **Forgetting any case leaks rows across orgs.**

### TanStack collection — add to `CollectionsProvider/collections.ts`

Follow the `tasks` pattern (`collections.ts:272`). `githubPullRequests` is read-mostly (no write handlers). `kanbanCards` gets `onInsert/onUpdate/onDelete` returning `electricTxidMatch(result.txid)`.

```typescript
const githubPullRequests = createPersistedElectricCollection(
  electricCollectionOptions<SelectGithubPullRequest>({
    id: `github_pull_requests-${organizationId}`,
    shapeOptions: { url: electricUrl, params: { table: "github_pull_requests", organizationId },
      headers: electricHeaders, columnMapper, onError: handleElectricSyncError },
    getKey: (item) => item.id,
  }),
);

const kanbanCards = createPersistedElectricCollection(
  electricCollectionOptions<SelectKanbanCard>({
    id: `kanban_cards-${organizationId}`,
    shapeOptions: { url: electricUrl, params: { table: "kanban_cards", organizationId },
      headers: electricHeaders, columnMapper, onError: handleElectricSyncError },
    getKey: (item) => item.id,
    onInsert: async ({ transaction }) =>
      electricTxidMatch((await apiClient.kanbanCard.create.mutate(transaction.mutations[0].modified)).txid),
    onUpdate: async ({ transaction }) => {
      const { original, changes } = transaction.mutations[0];
      return electricTxidMatch((await apiClient.kanbanCard.update.mutate({ id: original.id, ...changes })).txid);
    },
    onDelete: async ({ transaction }) =>
      electricTxidMatch((await apiClient.kanbanCard.delete.mutate(transaction.mutations[0].original.id)).txid),
  }),
);
```
Add `kanbanBoards`/`kanbanColumns` the same way; register all in `OrgCollections` + the return statement + `preloadCollections`.

## 5. Feature List (prioritized)

**P0 — one-stop board, ships first**
- "Needs my review" view (filter synced PRs where I'm a requested reviewer / `reviewDecision = REVIEW_REQUIRED`).
- "My open PRs" view (filter by `authorLogin === me`).
- Kanban board, team-shared: default columns **Backlog / Reviewing / Changes Requested / Approved / Merged**.
- Drag-to-move cards across columns (`@dnd-kit`, copy `TasksBoardView`), optimistic + txid-synced.
- Per-card status surfaces from synced data: state badge (open/draft/merged/closed), `reviewDecision`, `checksStatus` (CI pass/fail/pending), diff stats (+/−, changed files).
- PR detail/diff view: file tree + `CodeView` diff (unified/split toggle), opened from a card.
- Create/link card from a PR (host-service `searchPullRequests`).

**P1 — review depth**
- Inline diff comments (gutter-click → `renderAnnotation` form) + review submit (approve / request changes / comment).
- Merge from detail view (`github.mergePR`, with method choice).
- Filters + search across the board (author, repo, status, checks; URL-encoded via query params).
- Keyboard navigation: command-palette-style jump, j/k card nav, vim-style sequences (mirror DiffKit `shortcuts.ts`).
- Mergeability / conflict indicator (**requires schema additions** — see Open Questions).
- Per-reviewer status (not just aggregate `reviewDecision`) — needs webhook to extract `requested_reviewers` (**schema gap**).
- Manual refresh of a PR (`pullRequests.refreshByWorkspaces` / `refreshByWorkspaces` equivalent).

**P2 — polish / breadth**
- Multiple boards per team; configurable columns; saved filters.
- Labels / milestones on cards (**webhook does not extract these today**).
- Activity timeline on PR detail (conversation view, DiffKit `pull-detail-page` style).
- CI checks drill-down (per-check list with `detailsUrl`).
- Auto-place cards by rule (e.g., new requested-review → Backlog; approved → Approved column).
- Resolve/unresolve review threads; code suggestions.

## 6. UI Structure

**Routes (TanStack file-based, under `_authenticated/_dashboard/`):**
- `pr-review/layout.tsx` — `createFileRoute("/_authenticated/_dashboard/pr-review")`, renders `<Outlet/>`.
- `pr-review/page.tsx` — board (default view).
- `pr-review/$prId/page.tsx` (or right-sidebar panel) — PR detail + diff.
- Run `bun run generate:routes` after adding files.

**Sidebar entry:** add to `DashboardSidebarHeader.tsx` (expanded + collapsed states + route matcher + `handlePRReviewClick → navigate({ to: "/pr-review" })`), icon `LuGitPullRequest`.

**Board view components (new, under `pr-review/components/`):**
- `PRReviewBoard` — `DndContext` + columns (copy `TasksBoardView` sensor/drag setup).
- `PRReviewColumn` — `useDroppable` + `SortableContext`.
- `PRReviewCard` — synced-PR card: title, state/review/CI badges, author avatar, diff stats. Reuse `Card`, `Badge`, `Tooltip` from `@superset/ui`.
- `PRReviewFilters` — author/repo/status/checks filters.
- `NeedsMyReviewRail` / `MyOpenPRsRail` — derived `useLiveQuery` views.

**Detail/diff components:**
- `PRDetailPanel` — header, metadata, merge controls; mount in existing `#workspace-right-sidebar-slot` or full route.
- `PRDiffView` — `@pierre/diffs` `CodeView` + `PRFileTree` (changed-file navigator) + `ReviewSubmitPopover`.

**Reuse:** `@dnd-kit` (installed), `@pierre/diffs` (installed), `LightDiffViewer`/theme utils, `Card/Button/Badge/Tooltip/ScrollArea/Empty/DropdownMenu` from `packages/ui`, `cn()`, `framer-motion`, `useLiveQuery`.

## 7. Build Plan (independently shippable slices)

1. **Schema + sync foundation** — add 3 kanban tables to schema.ts; `drizzle-kit generate`; add 4 `where.ts` cases (incl. `github_pull_requests`); add `kanbanCardRouter` (create/update/delete + move, txid); register collections (kanban + `githubPullRequests`). Ships invisibly (no UI yet); verify rows sync.
2. **Read-only board** — route + sidebar entry + `PRReviewBoard` rendering synced `githubPullRequests` into fixed columns derived from PR status. No drag, no kanban tables read yet. Ships a usable "PR dashboard."
3. **Team kanban (drag + persist)** — wire `kanban_*` collections, drag-to-move with optimistic + txid, default board/column seeding (idempotent). Ships the shared board.
4. **"Needs my review" + "My open PRs" + filters** — derived live queries + filter bar. Ships the triage views.
5. **PR detail + diff** — `PRDetailPanel` + `CodeView` diff via host-service `getPR`/`getContent`, file tree, unified/split. Ships review reading.
6. **Inline comments + review submit + merge** — annotations, submit popover, `mergePR`. Ships full review actions.
7. **Keyboard nav + command palette** — j/k, sequences, jump. Polish slice.
8. **(Optional) schema extensions** — mergeability, per-reviewer status, labels (webhook + schema work). Gated on Open Questions.

Each slice is a stacked PR; 1–4 deliver the core "one-stop shop," 5–6 deliver review depth.

## 8. Open Questions / Decisions for the User

1. **Board scope: team or org?** Schema supports `teamId`, but Electric shapes are org-scoped (team filtered client-side). One board per team, or one org board everyone shares? (Default proposal: one team board, client-filtered.)
2. **Schema extensions for P1 fidelity.** Mergeability/conflict status, per-reviewer status, requested reviewers, and labels are **not captured** by the current webhook handler (`webhooks.ts`) or `githubPullRequests` schema. Add columns + webhook extraction now (bigger slice 1) or defer to slice 8? Affects how "ready for review" is computed.
3. **Card auto-placement.** Should cards move columns automatically on GitHub events (approved → Approved), or is the board purely manual/team-curated? Auto-placement needs a reconciliation job reacting to synced PR state changes.
4. **PR data source for the board.** Confirm we rely on the webhook-fed `githubPullRequests` (org-wide, requires the GitHub App installed for those repos) rather than host-service's workspace-scoped polling. The synced table is the better fit but only covers repos where the App is installed.
5. **Diff fetch path.** host-service `pullRequests.getContent` returns workspace-linked diffs; for an arbitrary org PR not tied to a local workspace, confirm we can fetch the diff (likely `github.getPR` + a files/patch fetch). May need a new `github.getPRFiles` procedure.
6. **`@pierre/diffs` bump.** OK to upgrade `1.2.2 → 1.2.7` to get the latest `CodeView` virtualization fixes, or pin to current?
