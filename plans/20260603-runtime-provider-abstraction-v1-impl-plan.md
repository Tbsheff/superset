# Runtime Provider Abstraction — v1 Implementation Plan (Daytona)

**Goal.** Extract today's local worktree behind a thin `RuntimeAdapter` seam, prove the seam with fakes and a descriptor-driven contract suite (including a non-PTY fake that drives the real renderer terminal), then ship exactly ONE remote provider — Daytona — end-to-end (create → clone → PTY shell → diff → preview → activity lease → cleanup). The second provider, not the spec, decides which abstractions become real.

**Locked decisions (do not relitigate):**
- **Scope = LEAN v1, end-to-end, Phases 0,A,B,C,D,E,F only.** No deferred providers (Vercel/Modal/Cloudflare), no deferred tables (`runtime_routes`, `runtime_snapshots`, `runtime_processes`, etc.), no 5-axis enum taxonomy beyond what local + Daytona exercise.
- **First remote provider = Daytona.** Only provider whose shape is a near-superset of today's local workspace (first-class PTY, provider git, full FS, preview URL, clean `refreshActivity` heartbeat) — no terminal-UI rewrite, no out-of-repo bridge.
- **Target DB = host-service SQLite** (`packages/host-service`, better-sqlite3, drizzle-kit `dialect:'sqlite'`, migrations in `packages/host-service/drizzle/`). Neon-branch workflow applies ONLY if cloud Postgres is touched (it is not, in v1).
- **Tests run on `bun:test`, not vitest.** Every `*.test.ts` in `packages/host-service` imports `{ describe, expect, test }` from `bun:test`; package script is `bun test --pass-with-no-tests`. The original brief said vitest; the repo wins.
- **Naming is fixed:** adapters in `runtime/adapters/{localWorktree,daytona}/`, descriptors in `runtime/descriptors/`, contracts in `runtime/contract/`. Never `runtime/providers/`, never `src/providers/` (already holds auth/git/host-auth/model-providers).
- **Two existing abstractions, reconciled in Phase 0:** desktop `WorkspaceRuntime` + registry (`apps/desktop/src/main/lib/workspace-runtime/`, terminal-centric, Electron main) and host-service `HostServiceRuntime` (`packages/host-service/src/types.ts`, per-capability managers assembled in `app.ts`). The `RuntimeAdapter` is the per-workspace execution backend BELOW the host-service capability managers — not a third registry, not a replacement for those managers.
- **Security is a Phase F gate, not later hardening:** short-lived single-repo-scoped GitHub App token (preferably host-side push so no broad token enters the sandbox), deny-all egress default, branded `Secret` type forbidden in `metadataJson`.

**How to use this plan.** Build phase-by-phase in dependency order; one mergeable PR per phase (Phase C = 2 PRs). Each phase has an AC that is also its merge gate. The hard gates are: A before any implementation, B's non-PTY fake before any remote work, and Phase 0's decision doc before everything. The refined design doc at `/Users/tylersheffield/code/superset/plans/20260603-runtime-provider-abstraction-refined.md` is the source of truth for type shapes, corrected provider facts, and AC text — this connective tissue wires the phases together; it does not restate their bodies.

---

## Dependency graph & ordering

## Dependency DAG

The gates that actually matter: **0** is a precondition decision for all; **A** blocks everything implementation-y; **B**'s non-PTY fake is a hard gate before **F**; **C** (schema) blocks **E** and **F**; **D** (diff collector) blocks **F**; **E** (local extraction proves the seam) blocks **F**.

```
        ┌─────────────────────────────────────────────┐
        │ 0  Reconciliation gate (decision doc)        │
        │    precondition for ALL phases               │
        └───────┬───────────────────────┬─────────────┘
                │                        │
                ▼                        ▼
        ┌───────────────┐         ┌──────────────────────────┐
        │ A  Type seam  │────────▶│ C  Schema migration       │
        │  + contracts  │  (also  │   PR1 columns → PR2 table │
        │  (no impl)    │   ◀0)   └──────────┬───────────────┘
        └───┬───────┬───┘                    │
            │       │                        │
            ▼       └──────────┐             │
     ┌─────────────┐          ▼             │
     │ B  Contract │   ┌──────────────┐     │
     │ suite+fakes │   │ D  Diff       │     │
     │ (non-PTY    │   │   collector   │     │
     │  HARD GATE) │   └──────┬───────┘     │
     └──────┬──────┘          │             │
            │                 │             │
            │     ┌───────────┴─────────────┘
            │     │      │
            │     ▼      ▼
            │  ┌────────────────────────────────┐
            │  │ E  Extract LocalWorktimeRuntime │
            │  │    (needs A,B,C,D)              │
            │  └──────────────┬─────────────────┘
            │                 │
            └────────┐        │
                     ▼        ▼
            ┌────────────────────────────────────┐
            │ F  Daytona adapter, end-to-end       │
            │    (needs A,B,C,D,E)                 │
            └────────────────────────────────────┘
```

| Phase | Depends on | Is a gate that blocks |
|---|---|---|
| 0 | — | A, B, C, D, E, F (precondition decision) |
| A | 0 | B, C, D, E, F (all impl) |
| B | A | F (non-PTY fake = hard gate) |
| C | 0, A | E, F (schema columns + table) |
| D | A | F (diff collector reused by Daytona) |
| E | A, B, C, D | F (local extraction proves the seam first) |
| F | A, B, C, D, E | — (terminal node) |

Notes on the non-obvious edges:
- **B → F (not B → E):** the non-PTY fake gate exists to de-risk the remote provider's terminal path. E (local extraction) can proceed in parallel with B once A lands, but F must not start until B is green.
- **C → E:** E routes `workspaces.create` through the adapter and writes `runtimeKind`/`currentRuntimeId`; those columns must exist (C/PR1) before E. The `runtime_instances` FK (C/PR2) is what E/F write rows into.
- **C and D both depend only on A** (plus 0), so they can be built in parallel after A.

---

## Phases

### Phase 0 — Reconciliation gate

Phase 0 is a committed decision document plus two minimal, non-behavioral code touchpoints. It exists because the refined plan's premise — "the registry is the one desktop already has" — is only half right. Grounding the repo surfaced **two pre-existing abstractions that are not the same thing**, and the four in-flight host-service plans are extending one of them, not the other:

| Abstraction | Location | Shape | Who extends it |
|---|---|---|---|
| Desktop `WorkspaceRuntime` + `WorkspaceRuntimeRegistry` | `apps/desktop/src/main/lib/workspace-runtime/{types.ts,registry.ts,local.ts,index.ts}` | Terminal-centric (`terminal: TerminalRuntime`, `capabilities.terminal`), Electron **main** process, `getForWorkspaceId`/`getDefault`, single `LocalWorkspaceRuntime` (`id="local"`) | Nobody yet — the docstring at `types.ts:189-202` promises future `changes/files/agentEvents` |
| Host-service `HostServiceRuntime` | `packages/host-service/src/types.ts:16-21`, assembled `app.ts:120-125` | Per-capability managers: `auth: ChatService`, `chat: ChatRuntimeManager`, `filesystem: WorkspaceFilesystemManager`, `pullRequests: PullRequestRuntimeManager`; lives on `ctx.runtime` | `host-service-diff-plan.md` (adds `runtime.diff`), `host-service-chat-architecture.md` (adds `runtime.chat`), filesystem-transport plan (a `WorkspaceFsHostRegistry`) |

The `RuntimeAdapter`/`ProviderDescriptor` layer from Phase A lands in **`packages/host-service`**, so its real peer is `HostServiceRuntime`, **not** the desktop `WorkspaceRuntime`. The decision doc must say this explicitly so Phases A–F do not introduce a third competing model.

**Acceptance for the whole phase:** a one-page decision doc committed at `plans/runtime-provider-phase0-reconciliation.md`; the two code touchpoints (steps 5–6) land green with zero behavior change; no second registry is introduced; `bun run typecheck` and `bun test` pass for `packages/host-service` and `apps/desktop`.

---

1. **Create the decision doc skeleton.**
   - **CREATE** `plans/runtime-provider-phase0-reconciliation.md`.
   - It is a *committed decision record* (ADR-style), one page, with exactly the six decisions in steps 2–4 below plus a "Touchpoints" section pointing at steps 5–6. Lead each decision with the verdict, then one or two sentences of rationale citing the real symbols found.
   - **Acceptance:** file exists; each decision section starts with **Decision:** followed by **Why:**; no decision is left as an open question (open questions go to a final "Deferred to user" list, not inline).

2. **Decision 1 — vocabulary; Decision 2 — one registry per layer.**
   - In the doc, record:
     - **Decision 1 (adopt, don't reinvent):** The runtime-adapter layer adopts the existing host-service capability vocabulary. `RuntimeAdapter` is the *per-workspace execution backend* that sits **below** the existing capability managers (`chat`, `filesystem`, `pullRequests`, future `diff`), not a sibling of them and not a replacement. Concretely: a `RuntimeHandleFor<"workspace">` (the role-discriminated handle from Phase A) is what a future per-workspace selector hands to those managers so a remote workspace's `filesystem`/`chat`/`git` resolve against the remote instance instead of a local worktree. We **reuse the noun `runtime`** already on `ctx.runtime` (`HostServiceContext.runtime`, `types.ts:29`) and the per-capability manager pattern; we do **not** import the desktop `WorkspaceRuntime` interface into host-service (it is terminal-shaped and Electron-coupled — see `no-electron-coupling.test.ts`).
     - **Decision 2 (one registry per layer, two layers):** There are legitimately two process boundaries (Electron main vs host-service), so there are two registries, but **exactly one per boundary**, and they share vocabulary:
       - Host-service: the selector that maps `workspaceId → RuntimeAdapter` lives next to `HostServiceRuntime` (recommended: a `runtimeRegistry` field added to `HostServiceRuntime` in a *later* phase, not Phase 0). The capability managers (`chat`/`filesystem`/`pullRequests`/`diff`) keep their current `workspaceId → worktreePath` resolution for v1 and gain a `workspaceId → RuntimeAdapter` path only in Phase E/F.
       - Desktop: the existing `WorkspaceRuntimeRegistry` (`registry.ts`) stays the single desktop-side terminal registry; it is **not** duplicated. When a remote workspace exists, the desktop registry's `getForWorkspaceId` will route terminal ops over the host-service transport (future work; out of scope for v1 but the seam is named here).
   - **Mermaid (paste into the doc) to make the "below, not beside" relationship unambiguous:**
     ```
     HostServiceContext.runtime (existing)
       ├─ auth / chat / filesystem / pullRequests  (capability managers — unchanged in v1)
       └─ [Phase E/F] runtimeRegistry: workspaceId -> RuntimeAdapter
                                              │
                                              ├─ localWorktree adapter  (Phase E)
                                              └─ daytona adapter        (Phase F)
     ```
   - **Acceptance:** the doc names `HostServiceRuntime` (`types.ts:16`), `ctx.runtime` (`types.ts:29`), `app.ts:120`, the desktop `WorkspaceRuntimeRegistry`, and states "no third registry" as a checkable invariant.

3. **Decision 3 — runtime_instances vs dormant cloud config; unify status vocabulary.**
   - In the doc, record the mapping from the **dormant** cloud model to the new host model and the canonical status set. The cloud model is real but unwired: `cloudWorkspaceConfigSchema` (`packages/db/src/schema/zod.ts:10`) carries `modalSandboxId, modalObjectId, snapshotImageId, status, lastSpawnedAt, lastActivityAt, lastSpawnError, lastSpawnErrorAt, spawnFailureCount`; `status` is `sandboxStatusEnum` (`packages/db/src/schema/enums.ts:51-65`, 11 members); `workspaceTypeEnum = ["local","cloud"]` (`enums.ts:67`).
     - **Decision 3a (source of truth):** host `runtime_instances` (Phase C) is the source of truth for **local execution metadata**; the cloud `config` JSON stays the **cloud projection** and is NOT unified in v1. State this so Phase C does not try to FK across the Postgres/SQLite boundary.
     - **Decision 3b (field mapping table)** — put this table in the doc verbatim:
       | cloud `cloudWorkspaceConfigSchema` field | host `runtime_instances` field | note |
       |---|---|---|
       | `modalSandboxId` / `modalObjectId` | `externalId` | provider-opaque reconnect id; provider-specific extras → `metadataJson` |
       | `status` (`sandboxStatusEnum`) | `status` (`NormalizedRuntimeStatus`) | see 3c |
       | `lastActivityAt` | `lastActivityAt` | epoch ms in host SQLite vs ISO string in cloud config — record the type difference |
       | `snapshotImageId` | (deferred) | no snapshot column in v1; lands with first snapshot-reuse provider |
       | `lastSpawnError` / `spawnFailureCount` | `failureReason` (+ counts → `metadataJson`) | v1 keeps one failure string column |
     - **Decision 3c (canonical status):** define `NormalizedRuntimeStatus` as a **named subset** of `sandboxStatusValues` so the two never drift. Recommended v1 set: `"pending" | "starting" | "ready" | "running" | "stopped" | "failed"`, with a documented projection table mapping the 11 cloud members onto it (`spawning|connecting|warming|syncing → starting`; `stale|snapshotting → running`/`stopped` per provider; `ready/running/stopped/failed/pending` map 1:1). Phase A freezes the type; Phase 0 only records the chosen set + projection so Phase A and Phase C agree.
   - **Acceptance:** doc contains the field-mapping table, the canonical status set, the 11→6 projection table, and the explicit statement "host runtime_instances = local execution truth; cloud config = cloud projection; not unified in v1." `electric sync` note included: `runtime_*` is server/host-managed and is NOT synced to local-db/desktop (matches refined plan §Data model).

4. **Decision 4 — preview/routes reconciliation with v2-remote-ports; Decision 5 — interface-alignment scope.**
   - In the doc:
     - **Decision 4 (no `runtime_routes` in v1; defer to v2-remote-ports):** v2-remote-ports (`plans/20260422-v2-remote-ports.md`) already owns listening-port surfacing keyed by **`terminalId`**, workspace-grouped, host-scoped, with **no schema** (it explicitly says "No schema changes," §6, reusing `terminalSessions`'s `terminalId/workspaceId/pid`). Therefore: per-terminal listening ports remain entirely in the v2-remote-ports model. `runtime_instances.previewUrl` is reserved for a **single runtime-level ingress origin** (the workspace's one preview URL from a remote provider, e.g. Daytona `getPreviewLink()`), not per-port routes. **No `runtime_routes` table ships in v1**; if/when it does, it must be folded into v2-remote-ports' `terminalId`-keyed model first (record this as the build-trigger, matching refined plan's Deferred table).
     - **Decision 5 (interface-alignment touchpoints — minimal):** the only Phase-0 code is steps 5 and 6. Everything structural (extracting `LocalWorktreeRuntime`, adding `runtimeRegistry` to `HostServiceRuntime`, wiring managers to adapters) is **Phase C/E**, not Phase 0. State this boundary so Phase 0 stays a doc.
   - **Acceptance:** doc states "no runtime_routes in v1; preview = one runtime-level origin column; per-terminal ports stay in v2-remote-ports" and lists exactly the two Phase-0 code touchpoints.

5. **Touchpoint 1 (code) — make startup migration failures fatal.**
   - **MODIFY** `packages/host-service/src/db/db.ts`. Today `createDb` (lines 23–27) wraps `migrate(db, { migrationsFolder })` in a `try/catch` that only `console.error`s, so a bad migration leaves the app running on an un-migrated DB. This is a hard blocker the refined plan calls out (§Data model "Fix first") and it must be fixed *before* Phase C adds migrations, so it belongs to the reconciliation gate.
   - Change to re-throw after logging:
     ```ts
     try {
       migrate(db, { migrationsFolder });
     } catch (error) {
       console.error("[host-service:db] Migration failed:", error);
       throw error; // fail fast: a silently un-migrated SQLite file is worse than a crash
     }
     ```
   - **CREATE** `packages/host-service/src/db/db.test.ts` (co-located, vitest). Assert:
     - `createDb(<tmp .db>, <valid migrations folder>)` returns a working db (e.g. a trivial `select` against `terminalSessions` succeeds) — proves the happy path still works.
     - `createDb(<tmp .db>, <nonexistent/garbage migrations folder>)` **throws** (use `expect(() => createDb(...)).toThrow()` or an `await expect(...).rejects` shape depending on sync/async) — proves the swallow is gone.
     - Use `os.tmpdir()` + a unique subdir per test; clean up in `afterEach`. Mirror the existing test pattern that already calls `migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })` directly (`src/trpc/router/config/config.test.ts:41`, `agent-configs.test.ts:26`) for how the test resolves `MIGRATIONS_FOLDER` (the `drizzle/` dir).
   - **Commands:**
     ```bash
     cd /Users/tylersheffield/code/superset/packages/host-service && bun test src/db/db.test.ts
     bun run --filter @superset/host-service typecheck
     ```
   - **Acceptance:** new test passes; existing host-service tests still pass; a deliberately-broken migrations folder crashes startup instead of running un-migrated.

6. **Touchpoint 2 (code, optional-but-recommended) — align the desktop runtime docstring and reserve the shared status type name.**
   - This is a **type/naming alignment only**, zero runtime behavior. Two small edits keep the two layers from drifting before Phase A:
     - **MODIFY** `apps/desktop/src/main/lib/workspace-runtime/types.ts` — update the `WorkspaceRuntime` JSDoc (lines 184–203) to point at the host-service reconciliation: replace the vague "future work will add changes/files/agentEvents" line with one sentence: *"Remote backends are selected per workspace via the host-service `RuntimeAdapter` layer (see `plans/runtime-provider-phase0-reconciliation.md`); this desktop boundary stays terminal-only and routes remote terminal ops over the host-service transport."* No interface members change. (Purpose: a future reader of the desktop registry finds the host-service decision instead of re-deriving it.)
     - **CREATE** `packages/host-service/src/runtime/status.ts` exporting only the agreed names so Phase A and Phase C import one source:
       ```ts
       import { sandboxStatusValues } from "@superset/db/schema/enums";

       export const normalizedRuntimeStatusValues = [
         "pending", "starting", "ready", "running", "stopped", "failed",
       ] as const;
       export type NormalizedRuntimeStatus =
         (typeof normalizedRuntimeStatusValues)[number];

       // Compile-time guarantee the normalized set is a subset of the cloud enum,
       // so the two status vocabularies cannot silently diverge.
       type _AssertSubset =
         NormalizedRuntimeStatus extends (typeof sandboxStatusValues)[number]
           ? true
           : never;
       const _subsetOk: _AssertSubset = true;
       ```
       (If `@superset/db/schema/enums` is not importable from host-service without adding a dep, fall back to re-declaring the projection as a const map and assert via a `satisfies` against a literal union — but prefer the real import so the subset check is enforced by the compiler. Verify importability with the typecheck command below before committing.)
   - **CREATE** `packages/host-service/src/runtime/status.test.ts` asserting `normalizedRuntimeStatusValues` length is 6 and every member is included in `sandboxStatusValues` (runtime mirror of the compile-time check, so a future edit that breaks the subset is caught by tests too).
   - **Commands:**
     ```bash
     cd /Users/tylersheffield/code/superset/packages/host-service && bun test src/runtime/status.test.ts && bun run --filter @superset/host-service typecheck
     cd /Users/tylersheffield/code/superset && bun run lint:fix
     ```
   - **Acceptance:** `status.ts` compiles (subset assertion holds); `status.test.ts` passes; desktop typecheck unaffected (docstring-only). If the cross-package import is not viable, the doc records that and Phase A owns the canonical status type instead — but the chosen set and projection from Decision 3c stand either way.

---

**Phase exit checklist (all must hold before Phase A starts):**
- [ ] `plans/runtime-provider-phase0-reconciliation.md` committed with Decisions 1–5, the cloud→host field-mapping table, the 11→6 status projection, and the "no third registry / no runtime_routes in v1" invariants.
- [ ] `packages/host-service/src/db/db.ts` migration failure is fatal; `db.test.ts` proves it.
- [ ] `packages/host-service/src/runtime/status.ts` (+ test) pins `NormalizedRuntimeStatus` as a verified subset of `sandboxStatusEnum`, OR the doc records that Phase A owns it.
- [ ] `bun run typecheck` + targeted `bun test` green for both `packages/host-service` and `apps/desktop`; `bun run lint:fix` clean.
- [ ] No new registry, no new `runtime/providers/` dir, no `runtime_routes` table, no terminal/manager code moved (those are Phases C/E/F).


---

### Phase A — Type seam + contract interfaces (no impl)

**Goal:** land the runtime type seam and descriptor-driven contract specs as compile-only + runnable-as-pure-functions artifacts, with zero adapters. After this phase `bun run typecheck` (in `packages/host-service`) passes, the new types are exported from a barrel, the new lint exists and passes, and no `RuntimeAdapter` implementation exists anywhere.

**Where everything goes (resolves the naming collision):** a new `packages/host-service/src/runtime/seam/` directory holds the types; `packages/host-service/src/runtime/descriptors/` holds the descriptor *type* (no descriptor values yet — those land with each adapter); `packages/host-service/src/runtime/contract/` holds the pure contract specs. NEVER `runtime/providers/`, NEVER `src/providers/`.

**Conventions locked from grounding:** host-service is `bun:test` (see `src/runtime/git/refs.test.ts:1` `import { describe, expect, mock, test } from "bun:test"`), tsconfig is `module: "Preserve"` + `moduleResolution: "Bundler"` + `allowImportingTsExtensions: true` + `isolatedModules: true` + `strict` + `noUncheckedIndexedAccess`. So: relative imports use `.ts`, all type re-exports use `export type`, and discriminated unions are mandatory (mirror `ResolvedRef` in `src/runtime/git/refs.ts`).

---

#### Step 1 — Create the facet types (variant-carrying, no boolean bags)

**CREATE** `packages/host-service/src/runtime/seam/facets.ts`

Mirror the refined plan's "Variant-carrying facets" verbatim. Each capability mode is a discriminated member carrying its own constraints; predicates are derived, never stored.

```ts
// runtime/seam/facets.ts
export type ExecutionSurface =
	| { kind: "pty"; stderrMultiplexedIntoStdout?: boolean }
	| { kind: "streaming-command" };

export type IngressMode =
	| {
			kind: "runtime-preview-url";
			tokenScheme: "standard" | "signed";
			defaultTtlSec?: number;
			maxTtlSec?: number;
	  }
	| { kind: "declared-port-domain"; portsAtCreate: true; maxPorts: number };

export type EgressMode =
	| { kind: "allow-all" }
	| { kind: "deny-all" }
	| { kind: "allow-cidrs"; maxEntries: number; ipv4Only: true };

export type OnStop =
	| { kind: "discard" }
	| { kind: "keep-disk" }
	| { kind: "keep-disk-and-memory" };

export type DurableStore =
	| { kind: "none" }
	| {
			kind: "snapshot";
			persistentByDefault?: boolean;
			autoSnapshotOnStop?: boolean;
	  }
	| { kind: "volume"; syncSemantics: "on-terminate" | "manual" | "immediate" };

export type ActivityStrategy =
	| { kind: "refresh-activity"; idleStopMs: number }          // Daytona
	| { kind: "extend-timeout"; defaultMs: number; maxMs: number } // Vercel (deferred)
	| { kind: "hard-cap"; maxMs: number }                       // Modal (deferred)
	| { kind: "keep-alive-or-destroy" };                        // Cloudflare SDK (deferred)

export type FilesystemFacet =
	| { kind: "none" }
	| { kind: "read-write-list" };
```

**AC:** no boolean capability flags; every facet is a discriminated union with a `kind` discriminant; only `refresh-activity` / `allow-all|deny-all|allow-cidrs` / `pty|streaming-command` are exercised by v1 (Daytona + local), the rest are present-but-deferred members.

---

#### Step 2 — Create RuntimeRole, the role-discriminated handle, and the reconciled WorkspaceRuntime

**CREATE** `packages/host-service/src/runtime/seam/roles.ts`

```ts
import type { ActivityLease } from "./activity-lease.ts";
import type { CleanupMode } from "./cleanup.ts";
import type { NormalizedRuntimeStatus } from "./status.ts";

export type RuntimeRole = "workspace"; // single-member union for v1; grows additively

/**
 * Reconciled WorkspaceRuntime — the host-service runtime *handle* returned by
 * createInstance({ role: "workspace" }). This is the EXECUTION boundary
 * (shell + diff + preview + lifecycle), distinct from the desktop terminal
 * boundary in apps/desktop/src/main/lib/workspace-runtime/types.ts.
 *
 * Phase 0 decides whether these two names converge. Until then this lives in
 * host-service and is the one the adapters implement.
 */
export interface WorkspaceRuntime {
	readonly role: "workspace";
	readonly externalId: string; // provider id/name for reconnect; "" for not-yet-created
	startShell(opts: StartShellOptions): Promise<ShellHandle>;
	getDiff(opts?: GetDiffOptions): Promise<RuntimeDiff>;
	exposePreview(port: number): Promise<PreviewBinding>;
	activityLease(): ActivityLease;
	getStatus(): Promise<NormalizedRuntimeStatus>;
	stop(mode: CleanupMode): Promise<void>;
}

export type RuntimeHandleFor<R extends RuntimeRole> = R extends "workspace"
	? WorkspaceRuntime
	: never;

// Minimal supporting shapes — bodies/wiring land in B/E/F, only the seam here.
export interface StartShellOptions {
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
}
export interface ShellHandle {
	readonly surface: import("./facets.ts").ExecutionSurface;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	onData(cb: (chunk: string) => void): { dispose(): void };
	onExit(cb: (info: { exitCode: number; signal?: number }) => void): {
		dispose(): void;
	};
	kill(signal?: string): Promise<void>;
}
export interface GetDiffOptions {
	staged?: boolean;
}
export interface RuntimeDiff {
	statusPorcelain: string;
	unifiedPatch: string;
}
export interface PreviewBinding {
	url: string;
	tokenScheme: "standard" | "signed" | "none";
}
```

**Rationale (cite):** matches the refined plan's "Role-discriminated handle (not a fat grab-bag)" — role is a discriminant on the OUTPUT type so a `role: "workspace"` caller can never be handed a handle missing `startShell`/`getDiff`/`exposePreview`. The desktop `WorkspaceRuntime` (`apps/desktop/.../workspace-runtime/types.ts:191`) stays untouched; this is a different boundary (terminal admin vs execution).

**AC:** `RuntimeRole` is `"workspace"` only; `RuntimeHandleFor<"job">` would be `never` (illegal to construct).

---

#### Step 3 — Create the lifecycle/status/cleanup value types

**CREATE** `packages/host-service/src/runtime/seam/status.ts`

```ts
/** Normalized lifecycle state across providers; provider strings map INTO this. */
export type NormalizedRuntimeStatus =
	| { kind: "creating" }
	| { kind: "running" }
	| { kind: "stopped"; resumable: boolean }
	| { kind: "destroyed" }
	| { kind: "failed"; reason: string };
```

**CREATE** `packages/host-service/src/runtime/seam/cleanup.ts`

```ts
/**
 * How destroy()/stop() should treat the runtime's disk + durable store.
 * Maps to provider verbs (Daytona stop vs archive vs delete) in the adapter.
 */
export type CleanupMode =
	| { kind: "stop"; keepDisk: boolean }
	| { kind: "delete" };
```

**CREATE** `packages/host-service/src/runtime/seam/activity-lease.ts`

```ts
export type HeartbeatResult =
	| { ok: true }
	| { ok: false; reason: "must-rehydrate" | "expired" };

/**
 * One normalized verb. Adapter maps heartbeat() to refreshActivity /
 * extendTimeout / renewActivityTimeout / keepAlive internally. Modal's hard
 * cap returns { ok: false, reason: "must-rehydrate" } instead of faking a
 * heartbeat. (Refined plan: "Activity lease: one normalized method".)
 */
export interface ActivityLease {
	heartbeat(): Promise<HeartbeatResult>;
	release(): Promise<void>;
}
```

**AC:** `NormalizedRuntimeStatus` is a discriminated union (no free-form string status leaks past the adapter boundary); `HeartbeatResult` carries `must-rehydrate` so Modal's deferred path already fits the interface.

---

#### Step 4 — Create RuntimeBinding (the workspace→runtime column-group seam)

**CREATE** `packages/host-service/src/runtime/seam/binding.ts`

```ts
/**
 * Where a workspace runs. Discriminant + boundary refinement, NOT three loose
 * fields. In Drizzle (Phase C) this becomes runtimeKind (discriminant) +
 * worktreePath (NOT NULL for v1) + nullable currentRuntimeId, with a zod/CHECK
 * refinement — same discipline as ResolvedRef (runtime/git/refs.ts).
 */
export type RuntimeBinding =
	| { kind: "local"; worktreePath: string }
	| { kind: "remote"; runtimeId: string };
```

**AC:** illegal states unrepresentable — a `local` binding cannot carry a `runtimeId`, a `remote` binding cannot carry a `worktreePath`. (Refined plan: "Workspace runtime binding: discriminated column-group".)

---

#### Step 5 — Create ProviderDescriptor + the single capability-question helper

**CREATE** `packages/host-service/src/runtime/descriptors/types.ts`

```ts
import type {
	ActivityStrategy,
	DurableStore,
	EgressMode,
	ExecutionSurface,
	FilesystemFacet,
	IngressMode,
	OnStop,
} from "../seam/facets.ts";
import type { RuntimeRole } from "../seam/roles.ts";

/**
 * Static, doc-derived-then-integration-corrected capability shape of one
 * provider. Advertise ONLY what the provider actually does. Populated
 * member-by-member from real integrations — never authored speculatively
 * (that's how the original baked in the Modal/Vercel/Daytona errors).
 */
export interface ProviderDescriptor {
	readonly provider: string; // 'local-worktree' | 'daytona' | ...
	readonly roles: readonly RuntimeRole[];
	readonly execution: readonly ExecutionSurface[];
	readonly filesystem: readonly FilesystemFacet[];
	readonly ingress: readonly IngressMode[];
	readonly egress: readonly EgressMode[];
	readonly onStop: readonly OnStop[];
	readonly durableStore: readonly DurableStore[];
	readonly activity: readonly ActivityStrategy[];
}

/** The ONE way to ask a capability question. No call site re-derives from booleans. */
export const descriptorSupportsExecution = (
	d: ProviderDescriptor,
	kind: ExecutionSurface["kind"],
): boolean => d.execution.some((e) => e.kind === kind);

export const descriptorSupportsEgress = (
	d: ProviderDescriptor,
	kind: EgressMode["kind"],
): boolean => d.egress.some((e) => e.kind === kind);

export const descriptorSupportsRole = (
	d: ProviderDescriptor,
	role: RuntimeRole,
): boolean => d.roles.includes(role);
```

**Note:** do NOT create any descriptor *values* here (no `localWorktreeDescriptor`, no `daytonaDescriptor`). Values land in Phases E/F next to their adapters. This phase ships the type + the predicate helpers only.

**AC:** `ProviderDescriptor` has no boolean capability fields; the only sanctioned capability predicates live here; later phases import these helpers rather than inlining `.some(...)`.

---

#### Step 6 — Create RuntimePlan + the RuntimeAdapter interface

**CREATE** `packages/host-service/src/runtime/seam/plan.ts`

```ts
import type { EgressMode } from "./facets.ts";
import type { RuntimeRole } from "./roles.ts";

/**
 * Inputs to createInstance, role-parameterized. v1 plan is intentionally thin;
 * RuntimePlanner validation rules are deferred (refined plan: "RuntimePlanner
 * validation rules ... Grow per real provider"). v1 validation = "provider
 * exists and supports role workspace", checked against the descriptor.
 */
export interface RuntimePlan<R extends RuntimeRole = RuntimeRole> {
	readonly role: R;
	readonly workspaceId: string;
	readonly repo: { cloneUrl: string; ref: string };
	readonly egress?: EgressMode; // default deny-all enforced by adapter for untrusted code
	readonly env?: Record<string, string>;
}
```

**CREATE** `packages/host-service/src/runtime/seam/adapter.ts`

```ts
import type { CleanupMode } from "./cleanup.ts";
import type { ProviderDescriptor } from "../descriptors/types.ts";
import type { RuntimePlan } from "./plan.ts";
import type { RuntimeHandleFor, RuntimeRole } from "./roles.ts";
import type { NormalizedRuntimeStatus } from "./status.ts";

export interface RuntimeAdapter {
	readonly descriptor: ProviderDescriptor;
	createInstance<R extends RuntimeRole>(
		plan: RuntimePlan<R>,
	): Promise<RuntimeHandleFor<R>>;
	reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>>;
	getStatus(externalId: string): Promise<NormalizedRuntimeStatus>;
	destroy(externalId: string, mode: CleanupMode): Promise<void>;
}
```

**Rationale (cite):** signatures are copied from the refined plan's "Role-discriminated handle" block; `descriptor` lives on the adapter (so the planner can validate before any provider call); `destroy` takes `CleanupMode` so Daytona stop/archive/delete map cleanly.

**AC:** `RuntimeAdapter` is an interface only — no class implements it in this phase; `createInstance` returns the role-discriminated handle, not a grab-bag.

---

#### Step 7 — Create the seam + descriptors barrels

**CREATE** `packages/host-service/src/runtime/seam/index.ts`

```ts
export type { RuntimeAdapter } from "./adapter.ts";
export type { ActivityLease, HeartbeatResult } from "./activity-lease.ts";
export type { RuntimeBinding } from "./binding.ts";
export type { CleanupMode } from "./cleanup.ts";
export type {
	ActivityStrategy,
	DurableStore,
	EgressMode,
	ExecutionSurface,
	FilesystemFacet,
	IngressMode,
	OnStop,
} from "./facets.ts";
export type { RuntimePlan } from "./plan.ts";
export type {
	GetDiffOptions,
	PreviewBinding,
	RuntimeDiff,
	RuntimeHandleFor,
	RuntimeRole,
	ShellHandle,
	StartShellOptions,
	WorkspaceRuntime,
} from "./roles.ts";
export type { NormalizedRuntimeStatus } from "./status.ts";
```

**CREATE** `packages/host-service/src/runtime/descriptors/index.ts`

```ts
export type { ProviderDescriptor } from "./types.ts";
export {
	descriptorSupportsEgress,
	descriptorSupportsExecution,
	descriptorSupportsRole,
} from "./types.ts";
```

**AC:** all type exports use `export type` (verbatim ESM under `isolatedModules`); helper functions use plain `export`.

---

#### Step 8 — Create the pure, descriptor-driven contract specs (NO adapters)

These are exported functions that take a `makeAdapter` factory and register `describe`/`test` blocks. They are NOT invoked at import time in this phase (Phase B wires fakes; Phase E/F wire real adapters). Because nothing calls them yet, `bun test` collects zero tests from these files — that's the "no adapters" AC.

**CREATE** `packages/host-service/src/runtime/contract/types.ts`

```ts
import type { RuntimeAdapter } from "../seam/index.ts";

/** A contract runs against a freshly-built adapter; the descriptor drives assertions. */
export interface ContractContext {
	makeAdapter(): Promise<RuntimeAdapter> | RuntimeAdapter;
}
```

**CREATE** `packages/host-service/src/runtime/contract/describePtyContract.ts`

```ts
import { describe, expect, test } from "bun:test";
import { descriptorSupportsExecution } from "../descriptors/index.ts";
import type { ContractContext } from "./types.ts";

/**
 * Pure spec. Skips itself if the descriptor does not advertise a pty surface,
 * so non-PTY providers (Phase B fake-command-workspace) are not failed for a
 * capability they correctly don't claim. Descriptor-driven: fails when reality
 * contradicts the descriptor.
 */
export function describePtyContract(ctx: ContractContext): void {
	describe("pty contract", () => {
		test("startShell yields a shell whose surface matches the descriptor", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "pty")) return; // not claimed → skip
			const handle = await adapter.createInstance({
				role: "workspace",
				workspaceId: "c-pty",
				repo: { cloneUrl: "x", ref: "main" },
			});
			const shell = await handle.startShell({ cols: 80, rows: 24 });
			expect(shell.surface.kind).toBe("pty");
		});
	});
}
```

**CREATE** `packages/host-service/src/runtime/contract/describeFilesystemContract.ts` — asserts `getDiff()` returns `{ statusPorcelain, unifiedPatch }` shape (string fields), gated on `descriptor.filesystem` advertising `read-write-list`.

**CREATE** `packages/host-service/src/runtime/contract/describePersistenceContract.ts` — round-trip: `createInstance` → `stop({kind:"stop",keepDisk:true})` → `reconnect(externalId)` → `getStatus()`. Asserts that when `descriptor.onStop` includes `keep-disk`, status after reconnect is `running` or `stopped{resumable:true}`; when `onStop` is `discard`-only, asserts a fresh FS. (Refined plan AC: "stop+reconnect preserves/loses FS per descriptor".)

**CREATE** `packages/host-service/src/runtime/contract/describeActivityLeaseContract.ts` — drives `activityLease().heartbeat()`. For `refresh-activity` descriptors asserts `{ok:true}`; for `hard-cap` descriptors asserts the lease can return `{ok:false, reason:"must-rehydrate"}` (covers Modal's deferred path). (Refined plan AC: "activity-lease hard-cap path".)

**CREATE** `packages/host-service/src/runtime/contract/describeDiffContract.ts` — asserts `getDiff()` and `getDiff({staged:true})` both return the `RuntimeDiff` shape; this is the contract Phase D's `diff-collector` must satisfy.

**CREATE** `packages/host-service/src/runtime/contract/describeRuntimeProviderContract.ts` — the aggregator:

```ts
import { describePtyContract } from "./describePtyContract.ts";
import { describeFilesystemContract } from "./describeFilesystemContract.ts";
import { describePersistenceContract } from "./describePersistenceContract.ts";
import { describeActivityLeaseContract } from "./describeActivityLeaseContract.ts";
import { describeDiffContract } from "./describeDiffContract.ts";
import type { ContractContext } from "./types.ts";

export function describeRuntimeProviderContract(ctx: ContractContext): void {
	describePtyContract(ctx);
	describeFilesystemContract(ctx);
	describePersistenceContract(ctx);
	describeActivityLeaseContract(ctx);
	describeDiffContract(ctx);
}
```

**CREATE** `packages/host-service/src/runtime/contract/index.ts` — barrel re-exporting all six `describe*Contract` functions + `ContractContext`.

**AC:** every contract file imports from `bun:test` (matching `refs.test.ts:1`), is a pure exported function, and is NOT self-invoked. Running `bun test` in `packages/host-service` collects 0 tests from `runtime/contract/**` (proves zero adapters), while `bun run typecheck` type-checks the spec bodies against the seam types.

---

#### Step 9 — Add the check-runtime-capability.sh lint (mirror check-git-ref-strings.sh)

**CREATE** `/Users/tylersheffield/code/superset/scripts/check-runtime-capability.sh` (repo root `scripts/`, where `check-git-ref-strings.sh` and `check-simple-git-usage.sh` actually live — NOT `packages/host-service/scripts/`).

Mirror the structure of `scripts/check-git-ref-strings.sh` (same `report_violation` helper, same rg exit-code handling). Ban ad-hoc capability booleans / re-derived capability checks outside the sanctioned helpers in `runtime/descriptors/types.ts`:

```bash
#!/bin/bash
# Forbids ad-hoc runtime capability booleans / inline capability re-derivation.
# The ONLY sanctioned way to ask "does this provider support X" is the helpers
# in packages/host-service/src/runtime/descriptors/types.ts
# (descriptorSupportsExecution / descriptorSupportsEgress / descriptorSupportsRole).
# Mirrors scripts/check-git-ref-strings.sh.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
failures=0
report_violation() { : # copy verbatim from scripts/check-git-ref-strings.sh
}

# 1) Ban boolean capability fields like `supportsPty:` / `hasPty:` / `canSnapshot:`
report_violation \
	"[runtime-capability] boolean capability fields are forbidden — use discriminated facets in runtime/seam/facets.ts and the descriptorSupports* helpers." \
	"\\b(supports|has|can|is)[A-Z][A-Za-z]*\\s*:\\s*(true|false|boolean)\\b" \
	--type ts \
	--glob 'packages/host-service/src/runtime/**' \
	--glob '!**/*.test.ts' \
	--glob '!packages/host-service/src/runtime/descriptors/types.ts'

# 2) Ban inline `.execution.some(` / `.egress.some(` outside descriptors/types.ts
report_violation \
	"[runtime-capability] inline descriptor.some(...) capability checks are forbidden — call descriptorSupports* from runtime/descriptors." \
	"\\.(execution|egress|roles|ingress|onStop|durableStore|activity)\\.(some|includes)\\(" \
	--type ts \
	--glob 'packages/host-service/src/runtime/**' \
	--glob '!**/*.test.ts' \
	--glob '!packages/host-service/src/runtime/descriptors/types.ts'

if [[ "$failures" -ne 0 ]]; then exit 1; fi
```

**MODIFY** `/Users/tylersheffield/code/superset/scripts/lint.sh` — add the new check next to the existing two (after line 16 `bash ./scripts/check-simple-git-usage.sh`):

```bash
bash ./scripts/check-runtime-capability.sh
```

**Commands:** `chmod +x scripts/check-runtime-capability.sh`.

**AC:** `bash scripts/check-runtime-capability.sh` exits 0 against the Phase A tree (the helpers themselves live in the excluded `descriptors/types.ts`); `scripts/lint.sh` invokes it; deliberately adding `supportsPty: true` to a runtime file makes it exit 1.

---

#### Step 10 — Verify (single end-of-phase quality gate)

Run, from repo root:

```bash
cd packages/host-service && bunx tsc --noEmit --emitDeclarationOnly false
cd /Users/tylersheffield/code/superset && bash scripts/lint.sh
cd packages/host-service && bun test --pass-with-no-tests src/runtime/contract
chmod +x scripts/check-runtime-capability.sh && bash scripts/check-runtime-capability.sh
```

**Phase acceptance criteria (all must hold):**
1. `tsc` passes for `packages/host-service` (the type seam compiles, including the contract spec bodies type-checked against the seam).
2. All new types are exported from `runtime/seam/index.ts` and `runtime/descriptors/index.ts`; helper predicates exported from `descriptors`.
3. Zero adapters: no file implements `RuntimeAdapter`; `bun test src/runtime/contract` collects 0 tests (specs are pure functions, never self-invoked); `rg "implements RuntimeAdapter" packages/host-service/src` returns nothing.
4. `descriptorSupports*` are the only capability predicates; `bash scripts/check-runtime-capability.sh` passes and is wired into `scripts/lint.sh`.
5. No descriptor *values* exist yet (grep `Descriptor = {` / `: ProviderDescriptor =` in `runtime/descriptors` returns nothing) — values are deferred to E/F per the refined plan.
6. `RuntimeRole` is `"workspace"` only; `HeartbeatResult` carries `must-rehydrate`; `RuntimeBinding`, `NormalizedRuntimeStatus`, `CleanupMode`, `ExecutionSurface`, `IngressMode`, `EgressMode`, `OnStop`, `DurableStore`, `ActivityStrategy`, `ActivityLease`, `RuntimePlan`, `RuntimeAdapter` all exist as discriminated/interface types.


---

### Phase B — Contract suite + fakes (non-PTY hard gate)

**Goal.** Prove the Phase-A `RuntimeAdapter` seam is real before any provider exists: a single descriptor-driven contract harness plus five sub-contracts, exercised by two fakes — `fake-pty-workspace` and `fake-command-workspace` (non-PTY) — that BOTH pass. The hard gate: the non-PTY fake must drive the **real renderer terminal UI** in a new read-only/log mode. No remote-provider work (Phase F) starts until this phase is green.

**Repo reality that overrides the brief.** host-service tests run on **`bun:test`, not vitest**. Verified: every `*.test.ts` under `packages/host-service` imports `{ describe, expect, test }` (or `it`/`mock`) from `"bun:test"` (e.g. `src/runtime/git/refs.test.ts:1`, `src/runtime/setup/config.test.ts:1`, `src/runtime/teardown/teardown.test.ts:1`); `package.json` script is `"test": "bun test --pass-with-no-tests"`; there is no vitest config anywhere in the tree. All files below use `bun:test`. Tests are co-located `*.test.ts` next to source (AGENTS structure rule). There is NO existing `describe*Contract` pattern in the repo — this phase introduces it.

**Naming guardrails (from the refined plan, lines 17, 323).** Contract code lives under `packages/host-service/src/runtime/contract/`; fakes under `packages/host-service/src/runtime/adapters/fakePtyWorkspace/` and `.../fakeCommandWorkspace/`; descriptors under `runtime/descriptors/`. NEVER `runtime/providers/`, NEVER `src/providers/`. One folder per unit + `index.ts` barrel.

---

#### Step 1 — Create the contract harness folder + shared fixture types

**Create** `packages/host-service/src/runtime/contract/index.ts` (barrel) and `packages/host-service/src/runtime/contract/types.ts`.

`types.ts` defines the test-only fixture seam each contract consumes. It imports the Phase-A symbols (`RuntimeAdapter`, `ProviderDescriptor`, `RuntimePlan`, `WorkspaceRuntime`, `ActivityLease`, `HeartbeatResult`, `CleanupMode`, `NormalizedRuntimeStatus`) from `runtime/types` (the Phase-A module).

```ts
import type { ProviderDescriptor, RuntimeAdapter, RuntimePlan } from "../types";

/** What a contract harness needs to construct + tear down one adapter under test. */
export interface ContractFixture {
  /** Human label used in describe() titles. */
  readonly name: string;
  /** Build a fresh adapter instance; called once per contract describe block. */
  createAdapter(): Promise<RuntimeAdapter> | RuntimeAdapter;
  /** A valid workspace-role plan the adapter accepts (clone target, repo path, etc.). */
  workspacePlan(): RuntimePlan<"workspace">;
  /** Dispose any instances/temp dirs the adapter created. */
  cleanup(): Promise<void>;
}
```

**Acceptance:** `types.ts` compiles against Phase-A `runtime/types`; `index.ts` re-exports `describeRuntimeProviderContract` and the five sub-contracts (added in later steps).

---

#### Step 2 — Write the top-level descriptor-driven harness `describeRuntimeProviderContract`

**Create** `packages/host-service/src/runtime/contract/describeRuntimeProviderContract.ts`.

This is the single entry point. It reads `adapter.descriptor` and DISPATCHES to the sub-contracts based on descriptor facets, so the suite "fails when reality contradicts the descriptor" (refined plan line 361). It is the mechanism that makes a PTY-only abstraction impossible to pass off as general.

```ts
import { describe } from "bun:test";
import type { ContractFixture } from "./types";
import { describePtyContract } from "./describePtyContract";
import { describeFilesystemContract } from "./describeFilesystemContract";
import { describePersistenceContract } from "./describePersistenceContract";
import { describeActivityLeaseContract } from "./describeActivityLeaseContract";
import { describeDiffContract } from "./describeDiffContract";

export function describeRuntimeProviderContract(fixture: ContractFixture): void {
  describe(`RuntimeAdapter contract: ${fixture.name}`, () => {
    // Sub-contracts are gated on what the descriptor CLAIMS. Each sub-contract
    // additionally cross-checks that the handle's behavior matches the claim.
    describePtyContract(fixture);            // both pty AND streaming-command branches
    describeFilesystemContract(fixture);
    describePersistenceContract(fixture);
    describeActivityLeaseContract(fixture);
    describeDiffContract(fixture);
  });
}
```

**Assertions in this file (a top-level `describe` block of structural invariants every adapter must hold):**
- `adapter.descriptor.roles` includes `"workspace"` (v1 single-member union per refined plan lines 146, 133).
- `createInstance({role:"workspace"})` resolves to a handle exposing `startShell`/`getDiff`/`exposePreview` (the role-discriminated `WorkspaceRuntime` from refined plan lines 156-160) — a handle missing any of these FAILS, proving the role discriminant is load-bearing.
- `getStatus(externalId)` returns a `NormalizedRuntimeStatus` value (one of the frozen union members), never a raw provider string.
- `destroy(externalId, "delete")` is idempotent: a second call does not throw.

**Acceptance:** importing `describeRuntimeProviderContract` with a fixture produces runnable `describe`/`test` blocks; with NO adapters it compiles and the file itself contains no `test()` that executes (it only defines the harness).

---

#### Step 3 — `describePtyContract` (covers BOTH execution surfaces — the anti-PTY-bias core)

**Create** `packages/host-service/src/runtime/contract/describePtyContract.ts`.

This is the most important sub-contract: it must pass for a `{kind:"pty"}` descriptor AND for a `{kind:"streaming-command"}` descriptor, asserting the OPPOSITE behavior in each branch. This is what the non-PTY fake stresses.

```ts
import { describe, expect, test } from "bun:test";
import type { ContractFixture } from "./types";

export function describePtyContract(fixture: ContractFixture): void {
  describe("execution surface", () => {
    test("descriptor advertises exactly one execution surface", async () => { /* adapter.descriptor.execution has length 1 */ });
    // pty branch:
    test("pty: handle exposes startShell that streams data events", async () => { /* descriptor.execution[0].kind==="pty" ⇒ startShell() yields >=1 {type:"data"} event */ });
    test("pty: writeStdin echoes / is accepted", async () => { /* writing input is accepted without throwing */ });
    test("pty: resize is accepted", async () => { /* resize(cols,rows) does not throw */ });
    // streaming-command branch (the gate that proves the seam is not PTY-shaped):
    test("non-pty: handle exposes runCommand returning a log stream, NOT a tty", async () => { /* descriptor.execution[0].kind==="streaming-command" ⇒ runCommand() yields {type:"data"} chunks then a {type:"exit"} */ });
    test("non-pty: writeStdin is unsupported and rejects with a typed error", async () => { /* asserting illegal-state: a streaming-command handle MUST NOT accept interactive stdin */ });
    test("non-pty: resize is a no-op or rejects, never silently pretends to be a tty", async () => {});
  });
}
```

**Key assertions:**
- Exactly one execution facet (`descriptor.execution.length === 1`) — facet is variant-carrying, not a boolean bag (refined plan lines 167-170).
- pty path: `startShell()` produces at least one `{type:"data"}` event; `writeStdin` accepted; `resize` accepted.
- non-pty path: `runCommand()` produces `{type:"data"}` chunks terminated by `{type:"exit", exitCode}`; `writeStdin` REJECTS (typed error, e.g. `UnsupportedExecutionError`); a streaming-command handle that silently accepts stdin is a FAILURE.
- For the `pty` facet with `stderrMultiplexedIntoStdout?: boolean` (refined plan line 168), assert the field is reflected in the stream when true.

**Acceptance:** the file compiles; when later run with `fake-pty-workspace` the pty branch executes and the non-pty branch is skipped, and vice versa for `fake-command-workspace`.

---

#### Step 4 — `describeFilesystemContract`, `describePersistenceContract`, `describeActivityLeaseContract`, `describeDiffContract`

**Create** four files under `packages/host-service/src/runtime/contract/`:

`describeFilesystemContract.ts` — asserts the handle's FS ops match `descriptor.filesystem` (read/write/list). Tests: write a file via the handle, read it back, list shows it; if the descriptor claims read-only, a write REJECTS. Reuses the in-memory FS the fakes carry.

`describePersistenceContract.ts` — the stop+reconnect round-trip keyed off `descriptor.persistence` (`OnStop` + `DurableStore`, refined plan lines 184-189):
- `onStop:"discard"` ⇒ after `destroy(id,"stop")` then `reconnect(externalId)`, a previously-written file is GONE.
- `onStop:"keep-disk"` / `"keep-disk-and-memory"` ⇒ after stop+reconnect the file PERSISTS.
- The assertion is descriptor-driven: the test branches on `descriptor.persistence.onStop.kind` and asserts the matching FS outcome, so an adapter that lies about persistence FAILS.

`describeActivityLeaseContract.ts` — exercises `ActivityLease.heartbeat()`/`release()` and the `HeartbeatResult` union (refined plan lines 210-218), INCLUDING the hard-cap path:
- `activity.kind==="refresh-activity"` ⇒ `heartbeat()` returns `{ok:true}` and pushes out `lastActivityAt`.
- `activity.kind==="hard-cap"` ⇒ after the simulated cap, `heartbeat()` returns `{ok:false, reason:"must-rehydrate"}` (never pretends to succeed — refined plan line 218). The fake simulates the cap via an injectable clock.
- `release()` is idempotent.

`describeDiffContract.ts` — asserts `handle.getDiff()` returns a structured diff (status entries + per-file patch) consistent with files the test mutates through the handle. v1 collector shape from refined plan line 109 (`status --porcelain`, `diff --binary`, `diff --cached --binary`, `log`). For fakes the diff is computed from the in-memory FS delta. This sub-contract is the one the Phase-D collector and Phase-F adapter must later satisfy unchanged.

**Acceptance:** all four compile against Phase-A types; each branches on a descriptor facet and asserts the corresponding behavior (not just happy-path).

---

#### Step 5 — Build `fake-pty-workspace` adapter

**Create** `packages/host-service/src/runtime/adapters/fakePtyWorkspace/fakePtyWorkspace.ts` + `index.ts` barrel + `descriptor.ts`.

`descriptor.ts` exports a `ProviderDescriptor` with: `roles:["workspace"]`, `execution:[{kind:"pty"}]`, `filesystem:{read:true,write:true,list:true}`, `ingress:[{kind:"runtime-preview-url",tokenScheme:"standard"}]`, `persistence:{onStop:{kind:"keep-disk"},durableStore:{kind:"none"}}`, `activity:{kind:"refresh-activity",idleStopMs:900_000}` — mirrors the local-worktree descriptor the refined plan assigns to Phase E (lines 352-353) so the contract that passes here is the same one local extraction must pass.

`fakePtyWorkspace.ts` implements `RuntimeAdapter` entirely in memory:
- In-memory FS map backs `getDiff` and the filesystem contract.
- `startShell()` returns an async iterable of `TerminalStreamEvent` (`{type:"data"}` … `{type:"exit"}`), echoing `writeStdin` input back as data (so the renderer-drive test in Step 7 has visible output).
- `ActivityLease` backed by an injectable `now()` clock (default `Date.now`) so `describeActivityLeaseContract` can advance time.
- `reconnect` returns a handle over the same in-memory FS (persistence = keep-disk).

```ts
export function createFakePtyWorkspaceAdapter(opts?: { now?: () => number }): RuntimeAdapter
```

**Test — `packages/host-service/src/runtime/adapters/fakePtyWorkspace/fakePtyWorkspace.test.ts`:**
```ts
import { describe } from "bun:test";
import { describeRuntimeProviderContract } from "../../contract";
import { createFakePtyWorkspaceAdapter } from "./fakePtyWorkspace";

describeRuntimeProviderContract({
  name: "fake-pty-workspace",
  createAdapter: () => createFakePtyWorkspaceAdapter(),
  workspacePlan: () => ({ role: "workspace", /* ... */ }),
  cleanup: async () => {},
});
```
Asserts: the FULL harness passes — pty branch of `describePtyContract`, filesystem, `keep-disk` persistence round-trip, `refresh-activity` lease, diff.

---

#### Step 6 — Build `fake-command-workspace` adapter (non-PTY)

**Create** `packages/host-service/src/runtime/adapters/fakeCommandWorkspace/fakeCommandWorkspace.ts` + `index.ts` + `descriptor.ts`.

`descriptor.ts`: identical to the PTY fake EXCEPT `execution:[{kind:"streaming-command"}]` and `activity:{kind:"hard-cap",maxMs:60_000}` (so it also exercises the `must-rehydrate` path), `persistence:{onStop:{kind:"discard"},durableStore:{kind:"none"}}` (so it exercises the discard branch of the persistence contract). This MAXIMIZES divergence from the PTY fake — the whole point of the gate.

`fakeCommandWorkspace.ts`:
- Exposes `runCommand(cmd)` → async iterable emitting `{type:"data"}` log chunks then `{type:"exit", exitCode}`. NO `startShell`, NO interactive stdin.
- `writeStdin` REJECTS with the typed `UnsupportedExecutionError` (proves the non-pty branch of `describePtyContract`).
- `heartbeat()` returns `{ok:false, reason:"must-rehydrate"}` after the injected clock passes `maxMs`.
- `reconnect` after stop returns a FRESH empty FS (discard).

**Test — `packages/host-service/src/runtime/adapters/fakeCommandWorkspace/fakeCommandWorkspace.test.ts`:** same `describeRuntimeProviderContract` invocation. Asserts: non-pty branch passes, `writeStdin` rejection asserted, `discard` persistence round-trip (file gone after reconnect), hard-cap lease returns `must-rehydrate`, diff from log-stream-mutated FS.

**Acceptance (partial gate):** `cd packages/host-service && bun test src/runtime/adapters/fakePtyWorkspace src/runtime/adapters/fakeCommandWorkspace src/runtime/contract` is green for BOTH fakes against the SAME harness.

---

#### Step 7 — Renderer change: drive the non-PTY fake in the real terminal UI (read-only/log mode)

This is the hard gate (refined plan lines 336-338, 107). The non-PTY fake's `{type:"data"}`/`{type:"exit"}` events already match what `useTerminalStream.handleStreamData` consumes (verified: `apps/desktop/.../Terminal/hooks/useTerminalStream.ts:149-186` switches on `event.type` and only the `"data"` case calls `xterm.write`). The renderer is therefore PTY-coupled in exactly TWO places — input wiring and the create/attach mutation — both of which we gate. CONCRETE changes:

1. **`apps/desktop/.../Terminal/types.ts`** — add `readOnly?: boolean` to `TerminalProps` (line 1-5):
```ts
export interface TerminalProps { paneId: string; tabId: string; workspaceId: string; readOnly?: boolean; }
```

2. **`apps/desktop/.../Terminal/Terminal.tsx`** — destructure `readOnly` (line 39-43), create `const isReadOnlyRef = useRef(readOnly); isReadOnlyRef.current = readOnly;` next to the existing `isRestoredModeRef` (line 245-246), and pass `isReadOnlyRef` into `useTerminalLifecycle` (the big options object at line 308-355). Render a `ReadOnlyModeOverlay` banner when `readOnly` is set (alongside the existing `SessionKilledOverlay` at line 466-471).

3. **`apps/desktop/.../Terminal/hooks/useTerminalLifecycle.ts`** — add `isReadOnlyRef: MutableRefObject<boolean>` to the options interface (next to `isRestoredModeRef` at line ~120), and gate input by adding ONE guard at the TOP of each handler, exactly mirroring the existing `isRestoredModeRef.current` early-returns:
   - `handleTerminalInput` (line 464-484): first line becomes `if (isReadOnlyRef.current) return;`
   - `handleKeyPress` (line 486-529): first line becomes `if (isReadOnlyRef.current) return;`
   This makes the terminal write-only-from-stream: data flows from the runtime to xterm; user keystrokes are dropped. Set xterm `disableStdin: true` / `cursorBlink: false` when read-only at construction.

4. **Create** `apps/desktop/.../Terminal/components/ReadOnlyModeOverlay/ReadOnlyModeOverlay.tsx` + `index.ts`, modeled on the existing `RestoredModeOverlay.tsx` (same `Card`/icon pattern) — a small non-blocking badge reading "Read-only (log) — this runtime does not support an interactive shell". Export it from `Terminal/components/index.ts`.

**Test — `apps/desktop/.../Terminal/Terminal.test.tsx`** (this app uses `bun:test` + happy-dom/RTL per existing renderer tests — confirm the renderer test runner before authoring; if RTL is unavailable, assert the gate at the hook level instead via `useTerminalLifecycle` unit test): assert that with `readOnly` set, a simulated `onData("x")` does NOT call `writeRef.current`, and that a streamed `{type:"data"}` event still calls `xterm.write`. The load-bearing assertion: **the same Terminal component renders fake-command-workspace output without an interactive shell**.

**Manual gate verification:** wire a dev-only pane source that attaches the `fake-command-workspace` adapter's `runCommand` stream to the renderer stream path, open the desktop app, and visually confirm log output renders read-only. (This is the gate criterion — "non-PTY fake renders in the real UI", refined plan line 338.)

---

#### Step 8 — Lint, typecheck, run the gate

**Commands (run once, end of phase — per Quality Check Discipline):**
```bash
cd /Users/tylersheffield/code/superset/packages/host-service && bun test src/runtime
cd /Users/tylersheffield/code/superset && bun run typecheck
cd /Users/tylersheffield/code/superset && bun run lint:fix
```
If a renderer test runner is configured for `apps/desktop`, also run the Terminal test; otherwise the hook-level gate test substitutes.

**Acceptance criteria (the gate — ALL must hold before Phase F begins):**
- [ ] `fake-pty-workspace` passes `describeRuntimeProviderContract` (pty branch + keep-disk + refresh-activity + fs + diff).
- [ ] `fake-command-workspace` passes the SAME `describeRuntimeProviderContract` (streaming-command branch + discard + hard-cap `must-rehydrate` + fs + diff), including `writeStdin` rejection.
- [ ] The contract FAILS if a fake is mutated to contradict its descriptor (spot-check: flip `fake-command-workspace` to accept `writeStdin`, confirm `describePtyContract` non-pty branch goes red, then revert).
- [ ] The non-PTY fake renders in the REAL renderer terminal in read-only/log mode: data streams to xterm, keystrokes are dropped, the `ReadOnlyModeOverlay` shows.
- [ ] `bun run typecheck` and `bun run lint:fix` are clean; no `any`; the `UnsupportedExecutionError`/`HeartbeatResult` use discriminated unions (mirroring `runtime/git/refs.ts` `ResolvedRef`).
- [ ] No code under `runtime/providers/` or `src/providers/` was created.


---

### Phase C — Thin schema migration + fix silent-migrate bug

Target DB: host-service SQLite only (`packages/host-service`, better-sqlite3, drizzle-kit `dialect:'sqlite'`, migrations in `packages/host-service/drizzle/`, applied at startup by `createDb` in `src/db/db.ts`). The Neon-branch / `packages/db/drizzle` rule does NOT apply here — no cloud Postgres is touched. Migrations are generated with `cd packages/host-service && bunx drizzle-kit generate --name=...` and committed verbatim; never hand-edit `drizzle/*.sql`, `drizzle/meta/*.json`, or `drizzle/meta/_journal.json`.

Ground truth this phase builds on (verified):
- `src/db/db.ts:23-27` wraps `migrate(db, { migrationsFolder })` in a `try/catch` that only `console.error`s and returns the half-migrated db — the silent-migrate bug.
- `src/db/schema.ts:138-167` `workspaces` has no `runtimeKind`/`currentRuntimeId`; `worktreePath` is `notNull()`. `terminalSessions` (`schema.ts:10-31`) has no `runtimeInstanceId`.
- The two workspace insert sites (`src/trpc/router/project/utils/ensure-main-workspace.ts:89`, `src/trpc/router/workspaces/workspaces.ts`, `.../workspace-creation/shared/adopt-existing-worktree.ts`) do NOT set `runtimeKind`, so a `.default("local")` backfills every existing and new row with zero call-site change.
- `createDb` callers: `src/app.ts:80` and tests `src/terminal/terminal.adoption.node-test.ts:78`. Tests that migrate a `:memory:` db do it directly via `migrate(db,{migrationsFolder})` (e.g. `src/trpc/router/config/config.test.ts:41`), so they are unaffected by the db.ts change.
- Test runner is `bun:test` (NOT vitest) using `drizzle-orm/bun-sqlite`; `bunfig.toml` preloads `./test/setup-env.ts`. Co-locate new tests as `*.test.ts` and import from `bun:test`.
- Dormant `sandboxStatusEnum` lives in `packages/db/src/schema/enums.ts:51-64` (Postgres/cloud projection) with values `pending|spawning|connecting|warming|syncing|ready|running|stale|snapshotting|stopped|failed`. `cloudWorkspaceConfigSchema` (`packages/db/src/schema/zod.ts:10-21`) carries `modalSandboxId|modalObjectId|snapshotImageId|status|lastActivityAt|lastSpawnError|spawnFailureCount`.

---

#### Step 1 — Fix the silent-migrate bug (make a failed startup migration fatal)

**Modify** `packages/host-service/src/db/db.ts`. Replace the swallowing `try/catch` (lines 23-27) so a failed migration logs and **rethrows**:

```ts
try {
  migrate(db, { migrationsFolder });
} catch (error) {
  console.error(
    `[host-service:db] FATAL: migration failed for ${dbPath} (migrations: ${migrationsFolder}). ` +
      `Refusing to run on an un-migrated database.`,
    error,
  );
  sqlite.close(); // release the file/WAL handle before crashing
  throw error;
}
```

Do not add retry/backoff or alarm plumbing in v1 — rethrow is the "fatal" contract; the existing host supervisor surfaces the crash. Leave the existing `console.error` initialization log (line 19-21) intact.

**Test — create** `packages/host-service/src/db/db.test.ts` (bun:test):
- `createDb` with the real `../../drizzle` folder against a fresh temp-dir db path succeeds and the `workspaces` table is queryable (`db.select().from(schema.workspaces).all()` returns `[]`).
- `createDb` against a **bad migrations folder** (point `migrationsFolder` at a temp dir containing a deliberately invalid `.sql` + a minimal `meta/_journal.json` that references it) **throws** (assert `expect(() => createDb(tmpDbPath, badFolder)).toThrow()`), proving failures are no longer swallowed.
- Use `mkdtempSync(join(tmpdir(), "host-db-test-"))` for isolation and `rmSync(..., {recursive:true, force:true})` in `afterEach`.

**Commands:** `cd packages/host-service && bun test src/db/db.test.ts`

**Acceptance:** a corrupt/failed startup migration throws instead of returning a half-migrated db; the happy path is unchanged; `db.test.ts` green. This step ships in **PR1** (it is a prerequisite for safely landing any new migration).

---

#### Step 2 — Brand a `Secret` type and a metadata value type that forbids it

**Create** `packages/host-service/src/db/types/secret.ts` (one concept per folder per repo convention; barrel below):

```ts
declare const secretBrand: unique symbol;
/** A value that must never be persisted in a *Json/preview/command column or logged. */
export type Secret = string & { readonly [secretBrand]: "Secret" };

export const asSecret = (value: string): Secret => value as Secret;

/** JSON-safe scalars allowed inside metadataJson. Excludes Secret structurally. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The only shape allowed in a *_json metadata column. `Secret` is a branded
 * `string`; this Exclude makes a `Secret`-typed field unassignable here, so
 * illegal "secret in metadata" states fail to compile (mirrors ResolvedRef
 * discipline in runtime/git/refs.ts).
 */
export type RuntimeMetadata = Record<string, Exclude<JsonValue, Secret>>;
```

**Create** `packages/host-service/src/db/types/index.ts` re-exporting `Secret`, `asSecret`, `JsonScalar`, `JsonValue`, `RuntimeMetadata`.

**Test — create** `packages/host-service/src/db/types/secret.test.ts`:
- Runtime: `asSecret("x")` round-trips as a string (`expect(String(asSecret("x"))).toBe("x")`).
- Compile-time: add a `// @ts-expect-error` block asserting `const m: RuntimeMetadata = { token: asSecret("t") }` does not type-check, proving the brand is forbidden in metadata. (bun:test executes the file; `@ts-expect-error` is verified by `tsc` in the typecheck step.)

**Commands:** `cd packages/host-service && bun test src/db/types/secret.test.ts` then `bun run typecheck` (must pass, including the `@ts-expect-error`).

**Acceptance:** `RuntimeMetadata` rejects `Secret`-typed values at compile time. Ships in **PR2** alongside the `runtimeInstances.metadataJson` typing (Step 4) that consumes it. (Honest limit: a plain `string` token still type-checks into metadata; full structural redaction is Phase F.)

---

#### Step 3 (PR1) — Add the two nullable workspace columns

**Modify** `packages/host-service/src/db/schema.ts` `workspaces` table (after `pullRequestId`, before `createdAt`):

```ts
runtimeKind: text("runtime_kind").notNull().default("local"), // 'local' | 'remote'
currentRuntimeId: text("current_runtime_id"),                 // nullable; FK added in PR2 (Step 4)
```

Keep `worktreePath` `notNull()` for v1 (refined plan: relax only when a remote-only workspace ships). No FK on `currentRuntimeId` yet — `runtime_instances` does not exist until PR2.

Add the discriminated binding helper next to the schema so call sites read `runtimeKind` through a typed seam, not a bare string. **Create** `packages/host-service/src/db/types/runtime-binding.ts`:

```ts
export type RuntimeKind = "local" | "remote";
export type RuntimeBinding =
  | { kind: "local"; worktreePath: string }
  | { kind: "remote"; currentRuntimeId: string };

/** Boundary refinement: local ⇒ worktreePath; remote ⇒ currentRuntimeId. */
export function toRuntimeBinding(row: {
  runtimeKind: string;
  worktreePath: string;
  currentRuntimeId: string | null;
}): RuntimeBinding;
```

Barrel it from `src/db/types/index.ts`.

**Generate the migration (never hand-write):**
```bash
cd packages/host-service && bunx drizzle-kit generate --name=workspace_runtime_columns
```
This writes `drizzle/0006_workspace_runtime_columns.sql`, a new `drizzle/meta/0006_snapshot.json`, and appends an entry to `drizzle/meta/_journal.json`. Expected SQL: two `ALTER TABLE workspaces ADD ...` statements (matching the `0003_workspace_upstream_ref.sql` ALTER pattern). **Inspect it**: confirm it is plain `ALTER TABLE ... ADD`, that `runtime_kind` has `NOT NULL DEFAULT 'local'`, and that drizzle did NOT emit a `workspaces__new` recreate-table block (SQLite recreate drops/reinserts data — if it appears, stop and reconcile, do not commit). Commit `0006_*.sql` + `0006_snapshot.json` + the `_journal.json` change verbatim.

**Test — create** `packages/host-service/src/db/migrations.test.ts`:
- Apply ALL migrations (`migrate(db,{migrationsFolder: resolve(import.meta.dir,"../../drizzle")})`) against an in-memory `drizzle/bun-sqlite` db.
- Insert a project, then insert a workspace **without** `runtimeKind`/`currentRuntimeId` (exactly as `ensure-main-workspace.ts:89` does) and assert the read-back row has `runtimeKind === "local"` and `currentRuntimeId === null` — proves existing local workspaces load unchanged.
- Assert `toRuntimeBinding` on that row returns `{ kind: "local", worktreePath }`.

**Commands:** `cd packages/host-service && bun test src/db/migrations.test.ts && bun run typecheck`

**Acceptance:** generated migration is a pure additive ALTER; a pre-existing-shaped workspace insert backfills `runtime_kind='local'`; test green. Ships in **PR1** with Step 1.

---

#### Step 4 (PR2) — Add `runtimeInstances` table, `terminalSessions.runtimeInstanceId`, and the `currentRuntimeId` FK

**Modify** `packages/host-service/src/db/schema.ts`. Add the table (place after `workspaces`):

```ts
export const runtimeInstances = sqliteTable(
  "runtime_instances",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text().notNull(),                 // 'local-worktree' | 'daytona'
    role: text().notNull().default("workspace"),
    externalId: text("external_id"),            // provider id/name for reconnect
    status: text().notNull(),                   // NormalizedRuntimeStatus (Phase A)
    previewUrl: text("preview_url"),
    lastActivityAt: integer("last_activity_at"),
    ttlExpiresAt: integer("ttl_expires_at"),
    metadataJson: text("metadata_json")
      .notNull()
      .default("{}")
      .$type<RuntimeMetadata>(),               // Secret forbidden (Step 2)
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
    destroyedAt: integer("destroyed_at"),
    failureReason: text("failure_reason"),
  },
  (table) => [
    index("runtime_instances_workspace_id_idx").on(table.workspaceId),
  ],
);
```

Import `RuntimeMetadata` from `./types/index.ts`. Use `.$type<RuntimeMetadata>()` (the same `$type` pattern already used at `schema.ts:46` for `BranchPrefixMode`); store/read JSON via `JSON.stringify`/`JSON.parse` at the boundary.

Add the FK on the column introduced in PR1 (now legal):
```ts
currentRuntimeId: text("current_runtime_id").references(
  () => runtimeInstances.id,
  { onDelete: "set null" },
),
```

Add the nullable process-tracking column to `terminalSessions` (refined plan: reuse `terminalSessions`, do NOT add a `runtime_processes` table in v1):
```ts
runtimeInstanceId: text("runtime_instance_id").references(
  () => runtimeInstances.id,
  { onDelete: "set null" },
),
```

Do NOT add `runtime_events`, `runtime_routes`, `runtime_snapshots`, `runtime_mounts`, `runtime_network_policies`, or `runtime_activity_leases` — all deferred per the refined plan. Do NOT mark these tables for Electric sync; `runtime_*` is server-managed and host-local only.

**Generate (never hand-write):**
```bash
cd packages/host-service && bunx drizzle-kit generate --name=runtime_instances
```
Writes `drizzle/0007_runtime_instances.sql` + `0007_snapshot.json` + `_journal.json` append. Expected: `CREATE TABLE runtime_instances (...)`, `CREATE INDEX runtime_instances_workspace_id_idx`, plus the two FK additions on `workspaces.current_runtime_id` and `terminal_sessions.runtime_instance_id`. In SQLite, adding a column **with** a foreign-key reference forces drizzle's recreate-table pattern (`*__new` + data copy + rename); verify the generated copy preserves all existing columns/data and inspect carefully before committing. Commit all three generated artifacts verbatim.

**Test — extend** `packages/host-service/src/db/migrations.test.ts`:
- After applying all migrations, insert a project + workspace, then insert a `runtimeInstances` row (`provider:'local-worktree'`, `role:'workspace'`, `status:'running'`, `metadataJson` default), read it back, assert `metadataJson` parses to `{}` and `role === "workspace"`.
- Update the workspace's `currentRuntimeId` to that instance id; assert read-back; then delete the instance and assert `currentRuntimeId` is set to `null` (FK `onDelete:'set null'`).
- Delete the workspace; assert the `runtimeInstances` row is gone (FK `onDelete:'cascade'`).
- Insert a `terminalSessions` row with `runtimeInstanceId` set; delete the instance; assert the session's `runtimeInstanceId` is `null` and the session still exists.
- Re-assert the PR1 case still holds (workspace without runtime fields → `runtimeKind:'local'`).

**Commands:** `cd packages/host-service && bun test src/db/migrations.test.ts && bun run typecheck`

**Acceptance:** `runtime_instances` + index created; cascade/set-null FK behavior verified by test; `metadataJson` typed `RuntimeMetadata`; no deferred tables added; generated migration committed unedited. Ships in **PR2**.

---

#### Step 5 — Reconcile status vocabulary with the dormant `sandboxStatusEnum`

Do NOT import or reuse `sandboxStatusEnum` (`packages/db/src/schema/enums.ts`) in host-service: it is the cloud Postgres projection and importing it would couple host SQLite to the cloud package. Instead define a host-local normalized status as the single source for the `runtime_instances.status` column, and document the field mapping so the two models stay reconcilable.

**Create** `packages/host-service/src/db/types/runtime-status.ts`:
```ts
/** NormalizedRuntimeStatus — host-local lifecycle for runtime_instances.status.
 *  Phase A owns the canonical union; this re-exports it for the DB layer. */
export type NormalizedRuntimeStatus =
  | "provisioning" | "running" | "stopped" | "destroyed" | "failed";
```
(If Phase A has already exported `NormalizedRuntimeStatus`, import and re-export it here rather than redefining — single source of truth.) Barrel from `src/db/types/index.ts`. Where Phase A's type exists, prefer `.$type<NormalizedRuntimeStatus>()` on the `status` column.

**Add a reconciliation note** as a short doc block in `packages/host-service/src/db/types/runtime-status.ts` (this is a real hidden-constraint comment, allowed by the comment policy) mapping cloud → host:

| cloud `cloudWorkspaceConfigSchema` | host `runtime_instances` | source of truth |
|---|---|---|
| `modalSandboxId` | `externalId` | host (local execution) |
| `status` (`sandboxStatusEnum`) | `status` (`NormalizedRuntimeStatus`) | host for local exec; cloud projection unchanged |
| `lastActivityAt` | `lastActivityAt` | host |
| `snapshotImageId` | future snapshot ref (deferred) | — |

Recommendation to record in the PR description: host `runtime_instances` is the source of truth for local-execution metadata; the cloud `cloudWorkspaceConfigSchema`/`sandboxStatusEnum` stay the cloud projection until a cross-device need forces unification (Open Question 3 in the refined plan). No code change to `packages/db` in this phase.

**Acceptance:** host status is a host-local discriminated string union, not a borrowed cloud enum; the cloud↔host field mapping is documented; `packages/db` untouched.

---

#### Step 6 — Final checks and the two-PR split

**The exact commands, in order:**
```bash
# PR1 (Steps 1, 3 — db.ts fatal + workspace columns):
cd packages/host-service && bunx drizzle-kit generate --name=workspace_runtime_columns
cd packages/host-service && bun test src/db
bun run typecheck && bun run lint:fix    # from repo root

# PR2 (Steps 2, 4, 5 — Secret type + runtime_instances + status), rebased on PR1:
cd packages/host-service && bunx drizzle-kit generate --name=runtime_instances
cd packages/host-service && bun test src/db
bun run typecheck && bun run lint:fix    # from repo root
```

**Two-PR split rationale (refined plan):** PR1 (columns) is verified against live rows in isolation before the table lands; PR2 (table) depends on PR1's `currentRuntimeId` column existing. After rebasing PR2 on PR1, if `_journal.json`/snapshot files conflict, **regenerate** with drizzle-kit — never hand-merge generated files.

**Phase-wide acceptance criteria:**
- A failed startup migration is fatal (rethrows; `db.ts` no longer swallows) — proven by `db.test.ts`.
- Existing/new local workspaces inserted without runtime fields load with `runtimeKind='local'`, `currentRuntimeId=null` — proven by `migrations.test.ts`; no workspace-insert call site (`ensure-main-workspace.ts`, `workspaces.ts`, `adopt-existing-worktree.ts`) changed.
- `runtime_instances` + `runtime_instances_workspace_id_idx` + the two FKs exist with correct cascade/set-null behavior — proven by `migrations.test.ts`.
- `Secret` is type-forbidden in `runtimeInstances.metadataJson` (`RuntimeMetadata`) — proven by `secret.test.ts` `@ts-expect-error` + `bun run typecheck`.
- All migrations were `drizzle-kit generate`d and committed unedited (`drizzle/0006_*`, `drizzle/0007_*`, `drizzle/meta/*`, `_journal.json`); no hand edits.
- No deferred `runtime_*` tables added; `packages/db` untouched; status is host-local, reconciliation documented.


---

### Phase D — Provider-neutral diff collector

Depends on Phase A (`describeDiffContract` spec + `runtime/contract/` exist). Target package: `packages/host-service`. Tests run under **`bun:test`** (not vitest) — `cd packages/host-service && bun test`.

**Why this phase exists.** Today `getDiff` lives inside the tRPC endpoint (`packages/host-service/src/trpc/router/git/git.ts:369`) and reconstructs file content with `git.show()` one ref:path at a time per category. Quoting the current `against-base` branch (git.ts:388–403):

```ts
if (input.category === "against-base") {
  const base = await resolveBaseComparison(git, input.baseBranch);
  const baseRef = base?.baseRef ?? "HEAD";
  const originRef = await git
    .raw(["merge-base", baseRef, "HEAD"])
    .then((s) => s.trim())
    .catch(() => baseRef);
  try { originalContent = await git.show([`${originRef}:${input.path}`]); } catch {}
  try { modifiedContent = await git.show([`HEAD:${input.path}`]); } catch {}
}
```

There is no reusable collector and no `--binary` patch surface. The Daytona adapter (Phase F) needs to collect a whole-workspace patch (not per-file content) to push diffs host-side (the security gate). This phase extracts BOTH surfaces into one provider-neutral module that takes a `SimpleGit` (matching `GitFactory = (path) => Promise<SimpleGit>` from `runtime/git/types.ts`), so the same code serves the local endpoint and the remote adapter without re-importing `simple-git` (forbidden by `scripts/check-simple-git-usage.sh`).

---

#### Step 1 — Capture a golden baseline of current `getDiff` output (regression guard, write FIRST)

**Create** `packages/host-service/src/trpc/router/git/getDiff.golden.integration.test.ts`.

Mirror the existing harness in `v2-diff-surfaces.integration.test.ts` (`initRepo`, `commitFile`, `mkTmp`, `bun:test`). Because `getDiff` is a tRPC procedure, do NOT spin up tRPC — instead extract the current per-file logic into a temporary local copy of the resolver body OR (preferred) snapshot by calling the soon-to-exist collector. To keep this test stable across the refactor, assert against **literal expected `{oldFile,newFile}` shapes** built from a known fixture repo, one test per `category`:

- `against-base`: branch off main, add commits to both; assert `oldFile.contents` = merge-base content, `newFile.contents` = HEAD content, `oldFile.name`/`newFile.name` = basename.
- `staged`: stage an edit; assert `oldFile.contents` = HEAD content, `newFile.contents` = index (`:0:`) content.
- `commit` (with and without `fromHash`): assert from `commitHash^` vs `commitHash`.
- `unstaged`: edit working tree without staging; assert `oldFile.contents` = `:0:` content, `newFile.contents` = raw worktree file read.
- `unstaged` new/untracked file: `oldFile.contents === ""`, `newFile.contents` = file body.
- missing path (deleted): the `catch {}` path leaves the side empty-string.

**Assertion:** each category returns exactly `{ oldFile: { name, contents }, newFile: { name, contents } }` with the basename rule `input.path.split("/").pop() ?? input.path`.

**Run:** `cd packages/host-service && bun test src/trpc/router/git/getDiff.golden.integration.test.ts` — confirm green against the UNCHANGED endpoint before touching anything.

---

#### Step 2 — Create the collector module folder

**Create** `packages/host-service/src/runtime/git/diff-collector/diff-collector.ts`.

The collector exposes two surfaces: (a) `collectFileDiff` — the per-file content surface the tRPC endpoint needs (byte-identical to today), and (b) `collectWorkspacePatch` — the whole-workspace patch surface the Daytona adapter needs. Both take a `SimpleGit` so the module is provider-neutral. No `simpleGit(...)` construction here (lint-enforced).

```ts
import { readFile } from "node:fs/promises";
import type { SimpleGit } from "simple-git";
import { resolveBaseComparison } from "../../../trpc/router/git/utils/git-helpers";
// NOTE: if importing across trpc → runtime creates a cycle, hoist
// resolveBaseComparison into runtime/git/refs.ts first (it only uses
// resolveUpstream, already in refs.ts) and re-export. Decide in review.

export type DiffCategory = "against-base" | "staged" | "unstaged" | "commit";

export interface FileDiffRequest {
  category: DiffCategory;
  path: string;            // worktree-relative
  worktreePath: string;    // for the unstaged raw-read branch
  baseBranch?: string;
  commitHash?: string;
  fromHash?: string;
}

export interface FileDiffResult {
  oldFile: { name: string; contents: string };
  newFile: { name: string; contents: string };
}

/** Per-file content surface — byte-identical to the legacy endpoint. */
export async function collectFileDiff(
  git: SimpleGit,
  req: FileDiffRequest,
): Promise<FileDiffResult>;

export interface WorkspacePatch {
  status: string;        // git status --porcelain=v1 (NUL or newline, see Step 3)
  unstaged: string;      // git diff --binary
  staged: string;        // git diff --cached --binary
  log: string;           // git log --oneline (bounded; see options)
}

export interface WorkspacePatchOptions {
  /** baseRef..HEAD bound for the log surface; default HEAD only. */
  logRange?: string;
  /** cap log lines; default 100. */
  logLimit?: number;
}

/** Whole-workspace patch surface — provider-neutral; Phase F reuses this. */
export async function collectWorkspacePatch(
  git: SimpleGit,
  options?: WorkspacePatchOptions,
): Promise<WorkspacePatch>;
```

`collectFileDiff` body is a **lift-and-shift** of git.ts:385–445 — keep the exact branch logic, including:
- `against-base`: `resolveBaseComparison` → `merge-base baseRef HEAD` (catch → baseRef) → `git.show([originRef:path])` vs `git.show([HEAD:path])`, each wrapped in `try {} catch {}`.
- `staged`: `git.show([HEAD:path])` vs `git.show([:0:path])`.
- `commit`: throw `TRPCError` BAD_REQUEST when `commitHash` missing (keep the error so the endpoint behavior is identical), `from = fromHash ?? \`${commitHash}^\``.
- `unstaged`: `git.show([:0:path])` vs `readFile(\`${worktreePath}/${path}\`, "utf-8")`, both in try/catch.
- basename: `req.path.split("/").pop() ?? req.path`.

`collectWorkspacePatch` body:
```ts
const [status, unstaged, staged, log] = await Promise.all([
  git.raw(["status", "--porcelain=v1", "-z"]),
  git.raw(["diff", "--binary"]),
  git.raw(["diff", "--cached", "--binary"]),
  git.raw(["log", "--oneline", "-n", String(options?.logLimit ?? 100),
           ...(options?.logRange ? [options.logRange] : [])]),
]);
return { status, unstaged, staged, log };
```
Wrap each in the repo's existing `.catch(() => "")` convention (mirrors `git-status.ts` and `getChangedFilesForDiff`) so a non-repo or empty repo yields empty strings, not a throw.

**Create** `packages/host-service/src/runtime/git/diff-collector/index.ts`:
```ts
export {
  collectFileDiff,
  collectWorkspacePatch,
} from "./diff-collector";
export type {
  DiffCategory,
  FileDiffRequest,
  FileDiffResult,
  WorkspacePatch,
  WorkspacePatchOptions,
} from "./diff-collector";
```

**Optionally** re-export from `runtime/git/index.ts` for adapter ergonomics:
```ts
export {
  collectFileDiff,
  collectWorkspacePatch,
} from "./diff-collector";
export type { WorkspacePatch } from "./diff-collector";
```

---

#### Step 3 — Confirm the `--porcelain` variant and `-z` choice against the contract

The plan text says `status --porcelain` (`plans/...refined.md:347`). Use **`--porcelain=v1 -z`** to match the NUL-delimited parsing already standard in this codebase (`git-helpers.ts` `parseNameStatus`/`parseNumstat` all use `-z`). If Phase A's `describeDiffContract` froze a non-`-z` form, follow the contract; otherwise standardize on `-z` and note it in the collector's one-line doc. The Daytona adapter (Phase F) will parse this with the existing `parseNameStatus`-style splitter, so consistency with the rest of `runtime/git` matters more than matching the prose verbatim.

---

#### Step 4 — Delegate the tRPC endpoint to the collector

**Modify** `packages/host-service/src/trpc/router/git/git.ts`.

Replace the `getDiff` resolver body (git.ts:381–446) so it resolves the worktree path + `git`, then delegates:

```ts
.query(async ({ ctx, input }) => {
  const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
  const git = await ctx.git(worktreePath);
  return collectFileDiff(git, {
    category: input.category,
    path: input.path,
    worktreePath,
    baseBranch: input.baseBranch,
    commitHash: input.commitHash,
    fromHash: input.fromHash,
  });
});
```

Add the import at the top: `import { collectFileDiff } from "../../../runtime/git/diff-collector";`. Remove the now-unused `readFile` import IF no other resolver uses it (git.ts:1 imports `{ readFile, rm }`; `rm` is still used by `discardChanges`/`discardAllStaged`, so keep `rm`, drop `readFile`). The `TRPCError` for missing `commitHash` moves into the collector, so the endpoint no longer needs that inline check — but keep `TRPCError` imported (used elsewhere in the router). Leave every OTHER resolver in `git.ts` untouched.

**Acceptance for this step:** the `getDiff` input zod schema (git.ts:371–380) is unchanged; the return shape is identical; consumers (`apps/desktop/.../useGitStatus.ts:44` invalidations, `ChangesTreeView.tsx`, `ChangesSection.tsx`) need zero changes.

---

#### Step 5 — Co-located collector unit/integration test

**Create** `packages/host-service/src/runtime/git/diff-collector/diff-collector.test.ts`.

Use `bun:test` + the `initRepo`/`commitFile`/`mkTmp` harness copied from `v2-diff-surfaces.integration.test.ts` (or extract that harness to a shared `test/helpers/git-repo.ts` and import — preferred to avoid a fourth copy). Build the `SimpleGit` with `createUserSimpleGit(repo)` from `runtime/git/simple-git.ts` (the approved wrapper) so the test itself doesn't trip `check-simple-git-usage.sh`; alternatively `simpleGit(repo)` is allowed inside `*.test.ts` (the lint excludes `**/*.test.ts`).

`collectFileDiff` assertions (must match the golden test from Step 1 exactly):
- `against-base` uses merge-base, not raw base tip (regression: add a commit on base AFTER fork, assert it is NOT in `oldFile.contents`).
- `staged` returns HEAD vs index content.
- `commit` with explicit `fromHash` and with default `^`.
- `unstaged` returns index vs raw worktree read; untracked file → `oldFile.contents === ""`.
- missing `commitHash` for `category: "commit"` throws `TRPCError` code `BAD_REQUEST`.
- basename rule for nested path `a/b/c.ts` → `name === "c.ts"`.

`collectWorkspacePatch` assertions:
- clean repo → all four fields are empty strings (no throw).
- one staged + one unstaged edit → `staged` contains the staged hunk, `unstaged` contains the unstaged hunk, and they don't bleed into each other.
- a binary fixture (write bytes incl. `\x00`) → `unstaged` contains the `GIT binary patch` marker (proves `--binary` is in effect, the whole point of the surface vs plain `diff`).
- `status` (with `-z`) lists an untracked file as `?? <path>\0`.
- `log` honors `logLimit` (commit 3 files, `logLimit: 2` → 2 lines) and `logRange` (`main..HEAD`).

**Run:** `cd packages/host-service && bun test src/runtime/git/diff-collector/`.

---

#### Step 6 — Wire `describeDiffContract` to the collector

**Modify** `packages/host-service/src/runtime/contract/diff-contract.ts` (the pure spec authored in Phase A — confirm exact filename; Phase A names it `describeDiffContract`).

In Phase A this is a spec that takes a runtime/adapter handle and asserts diff behavior abstractly. Bind it here to the collector by having the contract accept a `collect: () => Promise<WorkspacePatch>` (and/or a `collectFile` callback) injected by each adapter:

```ts
export interface DiffContractSubject {
  collectWorkspacePatch(): Promise<WorkspacePatch>;
  collectFileDiff(req: FileDiffRequest): Promise<FileDiffResult>;
}

export function describeDiffContract(
  label: string,
  makeSubject: () => Promise<{ subject: DiffContractSubject; seed: SeedFns }>,
): void {
  // asserts: clean → empty patch; staged/unstaged separation;
  // binary marker present; file-diff byte-identical for each category.
}
```

The **local** binding (registered in Phase E's `localWorktree` adapter) wraps `collectFileDiff(git, …)` / `collectWorkspacePatch(git)`; the **Daytona** binding (Phase F) wraps the same functions over its remote `SimpleGit`. Add a local-runtime invocation now so the contract has at least one passing subject:

**Create** `packages/host-service/src/runtime/contract/diff-contract.local.test.ts` that calls `describeDiffContract("local-worktree", …)` seeding a temp repo. This is the proof that the collector satisfies the frozen contract before any adapter exists.

**Run:** `cd packages/host-service && bun test src/runtime/contract/`.

---

#### Step 7 — Full verification pass (end of phase, single run)

```bash
cd /Users/tylersheffield/code/superset
# collector + endpoint + contract + golden, all under host-service
( cd packages/host-service && bun test src/runtime/git/diff-collector/ \
    src/runtime/contract/ \
    src/trpc/router/git/getDiff.golden.integration.test.ts )
# guardrails: no direct simple-git in the new module
bash scripts/check-simple-git-usage.sh
bash scripts/check-git-ref-strings.sh
# repo-wide quality gate
bun run typecheck
bun run lint:fix
```

---

#### Acceptance criteria (phase-level)

1. **Byte-identical diff output.** The Step 1 golden test passes identically before and after the endpoint refactor; `git.getDiff` returns the exact same `{oldFile,newFile}` shape and contents for all four categories (incl. merge-base for `against-base`, index read for `unstaged`, untracked→empty-old). No renderer/consumer change.
2. **Collector is provider-neutral.** `collectFileDiff`/`collectWorkspacePatch` take a `SimpleGit` (no `simpleGit(...)` construction, no `simple-git` runtime import); `scripts/check-simple-git-usage.sh` and `scripts/check-git-ref-strings.sh` pass.
3. **Patch surface exists and is correct.** `collectWorkspacePatch` produces `status --porcelain=v1 -z`, `diff --binary`, `diff --cached --binary`, and bounded `log --oneline`; binary patch marker verified; staged/unstaged isolation verified.
4. **Contract passes.** `describeDiffContract` runs green against the local collector subject (`diff-contract.local.test.ts`), proving the same contract the Daytona adapter (Phase F) will satisfy.
5. **Reuse proven by construction.** The module under `runtime/git/diff-collector/` is exported from `runtime/git/index.ts` and consumed by exactly one caller now (the tRPC endpoint); Phase F's Daytona adapter binds the same functions and the same contract — no second diff implementation introduced.
6. **typecheck + lint clean** at repo root.


---

### Phase E — Extract LocalWorktreeRuntime behind the seam

**Goal:** Make today's local-worktree behavior the first `RuntimeAdapter` implementation with **zero behavior change**, and route `workspaces.create` (`packages/host-service/src/trpc/router/workspaces/workspaces.ts:531`) through it via a backward-compatible facade. The adapter **coordinates** the existing concern modules — it does not rewrite them.

**Verified ground truth this phase builds on:**
- `workspaces.create` lives at `packages/host-service/src/trpc/router/workspaces/workspaces.ts:531`. It calls `registerCloudAndLocal(...)` (defined above it, ends ~line 502), `adoptExistingWorktree(...)`, `addBranchWorktree({ git, plan, worktreePath })`, `startSetupTerminalIfPresent(...)`, `dispatchSugarAgents(...)`, `startCommandTerminal(...)`.
- Setup config: `runtime/setup/config.ts` → `loadSetupConfig`, `getResolvedSetupCommands`, `SetupConfig`.
- Teardown: `runtime/teardown/teardown.ts` → `runTeardown(...)`, `TeardownResult`, `TEARDOWN_SCRIPT_REL_PATH` (barrel `runtime/teardown/index.ts`).
- Filesystem: `runtime/filesystem/filesystem.ts` → `WorkspaceFilesystemManager` (barrel `runtime/filesystem/index.ts`).
- Git: `runtime/git/git.ts` → `createGitFactory(GitCredentialProvider)`; refs discriminated union in `runtime/git/refs.ts` (`ResolvedRef`).
- Terminal/PTY seam: `terminal/terminal.ts` → `createTerminalSessionInternal(...)` returns `TerminalSession` (interface at `terminal.ts:246`) which exposes `pty: DaemonPty` (`pid`, `write`, `writeBytes`, `resize`, `kill`, `onData`, `onExit`); `DaemonClient` at `terminal/DaemonClient/DaemonClient.ts`.
- Destroy/teardown saga: `trpc/router/workspace-cleanup/workspace-cleanup.ts` → `destroyWorkspace`/`runDestroy` (PTY dispose, `git worktree remove --force --force`, cloud delete, branch delete, sqlite row delete).
- **Tests use `bun:test`** (e.g. `runtime/teardown/teardown.test.ts:1` `import { describe, expect, test } from "bun:test";`). Do NOT use vitest.
- Phase A delivers `RuntimeAdapter`, `ProviderDescriptor`, role-discriminated `createInstance`/`RuntimeHandleFor`, `WorkspaceRuntime` handle type, `ActivityLease`/`HeartbeatResult`, `RuntimeBinding`, and the contract specs under `runtime/contract/`. Phase D delivers `runtime/git/diff-collector.ts`. Phase C delivers `workspaces.runtimeKind`/`currentRuntimeId` columns + `runtime_instances`.

---

#### Step 1 — Create the local descriptor

**CREATE** `packages/host-service/src/runtime/descriptors/localWorktree.ts`

Author the descriptor as a frozen const matching the Phase A `ProviderDescriptor` shape, populated with exactly what local exercises (no speculative facets):

```ts
import type { ProviderDescriptor } from "../contract/types"; // Phase A
export const LOCAL_WORKTREE_DESCRIPTOR: ProviderDescriptor = {
  provider: "local-worktree",
  roles: ["workspace"],
  execution: [{ kind: "pty" }],
  filesystem: { read: true, write: true, list: true },
  ingress: [{ kind: "runtime-preview-url", tokenScheme: "standard" }],
  persistence: { onStop: { kind: "keep-disk" }, durableStore: { kind: "none" } },
  activity: { kind: "refresh-activity", idleStopMs: Number.POSITIVE_INFINITY }, // local never idle-stops; no-op lease
  egress: [{ kind: "allow-all" }], // host network — informational only for local
} as const;
```

> Note: the exact field names (`execution`/`filesystem`/`ingress`/`persistence`/`activity`/`egress`) must mirror Phase A's `ProviderDescriptor` definition verbatim. If Phase A names the activity facet `ActivityStrategy` with `{ kind: "refresh-activity"; idleStopMs }`, use `Number.POSITIVE_INFINITY` (or a dedicated `{ kind: "none" }` member if Phase A adds one) to encode "never idle-stops".

**CREATE** `packages/host-service/src/runtime/descriptors/index.ts` — barrel: `export { LOCAL_WORKTREE_DESCRIPTOR } from "./localWorktree";`

**Acceptance:** descriptor typechecks against the Phase A `ProviderDescriptor`; `roles: ["workspace"]`, `execution: [{kind:"pty"}]`, fs read/write/list, ingress preview, persistence `onStop:keep-disk`, activity no-op.

---

#### Step 2 — `LocalPtyTransport` wrapping `DaemonClient`/`createTerminalSessionInternal`

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/LocalPtyTransport.ts`

Wrap the existing terminal primitive with **zero behavior change**. The transport is the adapter's `startShell`/exec surface; it must delegate to `createTerminalSessionInternal` and the `DaemonPty` it returns, preserving `initialCommand` (joined exactly as today), `listed`, `cwd`, and replay semantics.

```ts
import { createTerminalSessionInternal, disposeSession } from "../../../terminal/terminal";
import type { HostDb } from "../../../db";
import type { EventBus } from "../../../events";

export interface PtyShellHandle {
  terminalId: string;
  pid: number;
  write(data: string): void;
  writeBytes(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): { dispose(): void };
  onExit(cb: (info: { exitCode: number; signal: number }) => void): { dispose(): void };
  kill(): Promise<void>;
}

export class LocalPtyTransport {
  constructor(private readonly db: HostDb, private readonly eventBus?: EventBus) {}
  async startShell(opts: {
    terminalId: string; workspaceId: string; initialCommand?: string;
    cwd?: string; listed?: boolean; cols?: number; rows?: number;
  }): Promise<PtyShellHandle | { error: string }> {
    const session = await createTerminalSessionInternal({ db: this.db, eventBus: this.eventBus, ...opts });
    if ("error" in session) return session;
    return { terminalId: opts.terminalId, pid: session.pty.pid, /* delegate pty.* methods */ };
  }
  dispose(terminalId: string): void { disposeSession(terminalId, this.db); }
}
```

> Do not re-implement PTY logic. `LocalPtyTransport.startShell` is a thin pass-through to `createTerminalSessionInternal` (`terminal.ts:1063`). The `PtyShellHandle` members forward 1:1 to `session.pty` (`DaemonPty`, `terminal.ts:59`).

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/LocalPtyTransport.test.ts` (`bun:test`):
- asserts `startShell` forwards `initialCommand`, `listed`, `cwd` unchanged into `createTerminalSessionInternal` (mock it via `bun:test` `mock`); assert returned handle exposes `pid` from the session and that `write`/`resize`/`kill` call through to the underlying `pty`.

**Acceptance:** transport delegates with no transformation of args; test green.

---

#### Step 3 — `LocalWorktreeRuntime` coordinator (the handle)

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/LocalWorktreeRuntime.ts`

This is the `WorkspaceRuntime` handle returned by `createInstance({ role: "workspace" })`. It **coordinates** existing modules; it owns no new git/fs/teardown logic.

```ts
import { LOCAL_WORKTREE_DESCRIPTOR } from "../../descriptors/localWorktree";
import { LocalPtyTransport } from "./LocalPtyTransport";
import { WorkspaceFilesystemManager } from "../../filesystem";
import { runTeardown } from "../../teardown";
import { collectDiff } from "../../git/diff-collector"; // Phase D
import { loadSetupConfig, getResolvedSetupCommands } from "../../setup/config";
import type { GitFactory } from "../../git/types";
import type { ActivityLease, HeartbeatResult } from "../../contract/types"; // Phase A
import type { HostDb } from "../../../db";

export interface LocalWorktreeRuntimeDeps {
  db: HostDb;
  git: GitFactory;
  fs: WorkspaceFilesystemManager;
  pty: LocalPtyTransport;
}

const NO_OP_LEASE: ActivityLease = {
  async heartbeat(): Promise<HeartbeatResult> { return { ok: true }; }, // local never idle-stops
  async release() {},
};

export class LocalWorktreeRuntime /* implements WorkspaceRuntime (Phase A) */ {
  readonly descriptor = LOCAL_WORKTREE_DESCRIPTOR;
  readonly binding: { kind: "local"; worktreePath: string };
  constructor(private readonly deps: LocalWorktreeRuntimeDeps, args: { workspaceId: string; worktreePath: string }) {
    this.binding = { kind: "local", worktreePath: args.worktreePath };
  }
  startShell(opts) { return this.deps.pty.startShell(opts); }
  getDiff() { return collectDiff(/* git for this.binding.worktreePath */); } // delegates to Phase D collector
  getFilesystem() { return this.deps.fs.getServiceForWorkspace(/* workspaceId */); }
  async runTeardown(args) { return runTeardown({ db: this.deps.db, ...args }); }
  exposePreview(/* ... */) { /* local preview = existing port/preview behavior, unchanged */ }
  activityLease(): ActivityLease { return NO_OP_LEASE; }
}
```

> Coordinate, do not rewrite: `getFilesystem` returns the existing `WorkspaceFilesystemManager` service; `runTeardown` calls the existing `runTeardown`; `getDiff` calls the Phase D `collectDiff`; setup-command resolution reuses `loadSetupConfig`/`getResolvedSetupCommands`. The only new code is wiring.

**Acceptance:** `LocalWorktreeRuntime` satisfies the Phase A `WorkspaceRuntime` handle interface (compile-time); no method re-implements logic that exists in the coordinated modules.

---

#### Step 4 — `LocalWorktreeAdapter` implementing `RuntimeAdapter`

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/adapter.ts`

```ts
import { LOCAL_WORKTREE_DESCRIPTOR } from "../../descriptors/localWorktree";
import { LocalWorktreeRuntime } from "./LocalWorktreeRuntime";
import type {
  RuntimeAdapter, RuntimePlan, RuntimeHandleFor, RuntimeRole,
  NormalizedRuntimeStatus, CleanupMode,
} from "../../contract/types"; // Phase A

export class LocalWorktreeAdapter implements RuntimeAdapter {
  readonly descriptor = LOCAL_WORKTREE_DESCRIPTOR;
  constructor(private readonly deps: LocalWorktreeRuntimeDeps) {}

  async createInstance<R extends RuntimeRole>(plan: RuntimePlan<R>): Promise<RuntimeHandleFor<R>> {
    // role is "workspace" only in v1. The local worktree add already happened
    // in the facade (Step 5) for backward-compat; createInstance binds the
    // existing worktreePath into a handle. It MUST NOT re-run `git worktree add`.
    return new LocalWorktreeRuntime(this.deps, { workspaceId: plan.workspaceId, worktreePath: plan.worktreePath }) as RuntimeHandleFor<R>;
  }

  async reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>> { /* look up worktreePath by workspaceId from sqlite, rebuild handle */ }
  async getStatus(externalId: string): Promise<NormalizedRuntimeStatus> { /* "running" if worktreePath exists, else "missing" */ }
  async destroy(externalId: string, mode: CleanupMode): Promise<void> {
    // Local destroy = the existing runDestroy saga (PTY dispose + worktree remove).
    // v1: delegate to destroyWorkspace OR no-op here and let workspace-cleanup own it.
  }
}
```

**Design decision (state it in the PR):** for v1, **keep the existing `workspace-cleanup.ts` destroy saga as the destroy path** and have `LocalWorktreeAdapter.destroy` either delegate to it or stay a no-op the cleanup router calls last. Do NOT move the 5-phase saga into the adapter this phase — that risks the byte-for-byte AC. Wire it into the adapter only when a remote adapter (Phase F) needs a uniform destroy.

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/descriptor.ts` — re-export `LOCAL_WORKTREE_DESCRIPTOR` for adapter-local imports (or have adapter import from `../../descriptors`; pick one and keep consistent — prefer importing from `runtime/descriptors/` to avoid duplication).

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/index.ts` — barrel:
```ts
export { LocalWorktreeAdapter } from "./adapter";
export { LocalWorktreeRuntime } from "./LocalWorktreeRuntime";
export { LocalPtyTransport } from "./LocalPtyTransport";
```

**Acceptance:** `LocalWorktreeAdapter` compiles against the Phase A `RuntimeAdapter` interface; `createInstance` returns a role-discriminated `WorkspaceRuntime` handle; `createInstance` does NOT call `git worktree add`.

---

#### Step 5 — Facade: route `workspaces.create` through the adapter (backward compatible)

**MODIFY** `packages/host-service/src/trpc/router/workspaces/workspaces.ts`

The seam must be **additive and behavior-preserving**. The existing branch-resolution, `worktree add`, `registerCloudAndLocal`, `adoptExistingWorktree`, setup-terminal, and sugar-agent logic stays exactly as-is. Insert the adapter at three points only:

1. **Construct the adapter once** (or get it from a tiny registry — see Step 6) using `ctx`-derived deps (`ctx.db`, `ctx.git` factory, the `WorkspaceFilesystemManager`, a `LocalPtyTransport`).
2. **After** the workspace row + worktree exist (i.e. after `registerCloudAndLocal`/`adoptExistingWorktree` returns `workspaceRow` and `worktreePath`), call `adapter.createInstance({ role: "workspace", workspaceId: workspaceRow.id, worktreePath })` to obtain the handle. This is the seam; it changes nothing on disk because the worktree already exists.
3. **Set the binding** on the new sqlite columns from Phase C: write `runtimeKind: "local"` and leave `currentRuntimeId` null (local binding lives in `worktreePath`, per `RuntimeBinding` discriminant). Do this inside the existing `persistLocalWorkspace`/`registerCloudAndLocal` insert so no extra write path is added.

Keep `startSetupTerminalIfPresent` and `startCommandTerminal` as-is OR route them through `adapter` (handle).`startShell` — but only if byte-for-byte identical. **Safest v1: leave setup/command terminals on their current calls** and only prove the adapter handle can also start them via the contract suite. Document this in the PR.

> The facade must not introduce a feature flag or alternate path. Local is the **only** runtime in v1, so the adapter route is the single code path. "Backward compatible" means the renderer/tRPC contract and on-disk effects are unchanged, not that two paths coexist.

**Acceptance:** `workspaces.create` returns the identical shape (`cloudRow` + `terminals` + warnings); `git worktree add`, rollback sagas, PR-adoption path, and setup-terminal dispatch are unchanged; new rows carry `runtimeKind: "local"`.

---

#### Step 6 — Minimal runtime registry (resolve adapter by `runtimeKind`)

**CREATE** `packages/host-service/src/runtime/registry/registry.ts` (+ `index.ts` barrel)

A one-entry registry so `workspaces.create`, `workspace-cleanup`, and Phase F have a single lookup. Converge on the desktop `WorkspaceRuntime` vocabulary (Phase 0 decision); do NOT introduce a competing registry.

```ts
import { LocalWorktreeAdapter } from "../adapters/localWorktree";
import type { RuntimeAdapter } from "../contract/types";

export function getRuntimeAdapter(runtimeKind: "local" /* | "remote" later */, deps): RuntimeAdapter {
  if (runtimeKind === "local") return new LocalWorktreeAdapter(deps);
  throw new Error(`No runtime adapter for kind: ${runtimeKind}`);
}
```

> Keep this trivial. Phase F adds the `"remote"`/`"daytona"` branch. Do not pre-build a plugin system.

**CREATE** `packages/host-service/src/runtime/registry/registry.test.ts` (`bun:test`): asserts `getRuntimeAdapter("local", deps)` returns a `LocalWorktreeAdapter` whose `descriptor.provider === "local-worktree"`; asserts unknown kind throws.

**Acceptance:** single registry; `"local"` resolves to `LocalWorktreeAdapter`.

---

#### Step 7 — Run the FULL Phase A contract suite against the local adapter

**CREATE** `packages/host-service/src/runtime/adapters/localWorktree/adapter.contract.test.ts` (`bun:test`)

Drive the local adapter through the shared Phase A contract spec (`describeRuntimeProviderContract` and its sub-contracts), using a real temp worktree so behavior is exercised, not mocked:

```ts
import { describe } from "bun:test";
import { describeRuntimeProviderContract } from "../../contract"; // Phase A
import { LocalWorktreeAdapter } from "./adapter";

describeRuntimeProviderContract({
  name: "local-worktree",
  makeAdapter: async () => {
    // build a real temp git repo + worktree (mirror runtime/teardown/teardown.test.ts setup:
    // mkdtempSync + git init + worktree add), wire deps, return adapter + cleanup
  },
  expectedDescriptor: LOCAL_WORKTREE_DESCRIPTOR,
});
```

The suite must run, at minimum:
- `describePtyContract` — `startShell` produces a working PTY (echo a marker, read it back) via `LocalPtyTransport`.
- `describeFilesystemContract` — read/write/list against the temp worktree via `WorkspaceFilesystemManager`.
- `describePersistenceContract` — descriptor says `onStop: keep-disk`; assert files survive a stop/reconnect cycle (local: worktree on disk persists).
- `describeActivityLeaseContract` — the **no-op lease** `heartbeat()` returns `{ ok: true }` and `release()` resolves; assert the contract tolerates a never-idle local lease (coordinate with Phase A so the spec does not require an idle-stop).
- `describeDiffContract` — `getDiff` (Phase D `collectDiff`) returns the expected porcelain/binary diff for a dirty temp worktree.

**Acceptance (the headline AC):** the local adapter **passes the full `describeRuntimeProviderContract` suite**; the local code path is **byte-for-byte identical** to pre-Phase-E (proven by Step 8).

---

#### Step 8 — Byte-for-byte regression guard

**MODIFY/ADD assertions** rather than new behavior. Prove no on-disk or wire-shape drift:

- **Reuse existing tests unchanged:** `runtime/teardown/teardown.test.ts`, `runtime/setup/config.test.ts`, `trpc/router/workspace-creation/shared/setup-terminal.test.ts` must still pass with no edits — they exercise the coordinated modules the adapter now calls.
- **CREATE** `packages/host-service/src/runtime/adapters/localWorktree/byte-identical.test.ts` (`bun:test`): assert `LOCAL_WORKTREE_DESCRIPTOR.execution[0].kind === "pty"`, that `LocalWorktreeRuntime.runTeardown` produces the identical `exec bash <scriptPath>` command (via `buildTeardownInitialCommand`), and that `startShell` joins multiple setup commands with `" && "` exactly as `setup-terminal.ts:resolveInitialCommand` does today.
- **Manual/CI check:** confirm `scripts/check-simple-git-usage.sh` and `scripts/check-git-ref-strings.sh` still pass — the adapter must only touch git through `runtime/git` (it does: it never imports `simple-git` or calls `execFile("git")`).

**Acceptance:** all pre-existing host-service tests green with no edits; new descriptor/command-shape assertions green; git-usage lint scripts pass.

---

#### Step 9 — Lint, typecheck, test gate (run once at end)

Commands (run from repo root, `/Users/tylersheffield/code/superset`):

```bash
# Targeted package test (bun:test, NOT vitest)
cd /Users/tylersheffield/code/superset/packages/host-service && bun test

# Whole-repo gates before PR
bun run typecheck
bun run lint:fix
bash scripts/check-simple-git-usage.sh
bash scripts/check-git-ref-strings.sh
```

**Acceptance:**
- `bun test` in `packages/host-service` is green, including the contract suite run from Step 7.
- `bun run typecheck` passes (adapter implements Phase A `RuntimeAdapter`; descriptor matches `ProviderDescriptor`; handle matches `WorkspaceRuntime`).
- `bun run lint:fix` produces no remaining errors; new files follow the one-folder-per-unit + `index.ts` barrel convention under `runtime/adapters/localWorktree/`, `runtime/descriptors/`, `runtime/registry/`.
- `check-simple-git-usage.sh` / `check-git-ref-strings.sh` pass (no raw `simple-git`/`execFile("git")`; git only via `runtime/git`).

---

#### Phase E acceptance criteria (rollup)

1. New code lives under `packages/host-service/src/runtime/adapters/localWorktree/` (`adapter.ts`, `LocalWorktreeRuntime.ts`, `LocalPtyTransport.ts`, `descriptor.ts`, `index.ts`, tests), `runtime/descriptors/localWorktree.ts`, and `runtime/registry/registry.ts` — never under `runtime/providers/` or `src/providers/`.
2. `LocalWorktreeRuntime` **coordinates** `runtime/setup/config`, `runtime/teardown`, `runtime/filesystem`, `runtime/git` + Phase D `diff-collector`, and `LocalPtyTransport` wraps `createTerminalSessionInternal`/`DaemonClient` — none of those modules are rewritten.
3. `workspaces.create` routes through `LocalWorktreeAdapter.createInstance` via the facade; setup-terminal, sugar-agent, PR-adoption, and rollback behavior are unchanged; new rows carry `runtimeKind: "local"`.
4. Local descriptor: `roles:['workspace']`, `execution:[{kind:'pty'}]`, fs read/write/list, ingress preview, persistence `onStop:keep-disk`, activity local no-op lease.
5. The local path is **byte-for-byte identical** (Step 8) and the local adapter **passes the full `describeRuntimeProviderContract` suite** (Step 7).
6. `bun test` (host-service), `bun run typecheck`, `bun run lint:fix`, and both git-usage lint scripts pass.

---

### Phase F — Daytona adapter — first remote provider, end-to-end

**Depends on:** Phase A (`RuntimeAdapter`, role-discriminated `createInstance`, facets, `ProviderDescriptor`, `ActivityLease`, `NormalizedRuntimeStatus`, `RuntimeBinding`), Phase B (the non-PTY/PTY fakes + `describeRuntimeProviderContract` already green), Phase C (`workspaces.runtimeKind`/`currentRuntimeId` columns + `runtime_instances` table + branded `Secret`), Phase D (`runtime/git/diff-collector.ts`), Phase E (`runtime/adapters/localWorktree/` extracted, `workspaces.create` routes through a `RuntimeAdapter` facade, desktop terminal router resolves the runtime per-workspace via `getForWorkspaceId`).

**Naming/placement (locked by refined plan):** adapter lives at `packages/host-service/src/runtime/adapters/daytona/`. Descriptor at `packages/host-service/src/runtime/descriptors/daytona.ts`. Contract specs reused from `packages/host-service/src/runtime/contract/`. NEVER `runtime/providers/`, never `src/providers/`.

**Scope guardrail:** v1 role is the single-member union `RuntimeRole = "workspace"`. Daytona is the ONLY remote provider. Do not spec Vercel/Modal/Cloudflare, snapshot reuse, the credential broker, `runtime_routes`/`runtime_snapshots`, or persisted activity leases. The activity lease is one `refreshActivity()` on a timer with state in memory.

---

#### Step 1 — Add and pin the Daytona SDK; add `DAYTONA_API_KEY` to host-service env

**Modify** `packages/host-service/package.json` — add to `dependencies`:
```jsonc
"@daytonaio/sdk": "0.184.0"
```
Pin exactly (no `^`). `@daytonaio/sdk` and `@daytona/sdk` mirror-publish identical 0.184.0 with no deprecation flag; standardize on `@daytonaio/sdk`. Import surface: `import { Daytona } from "@daytonaio/sdk"`. Host-service is Node, so the browser Buffer-polyfill caveat does not apply.

**Modify** `packages/host-service/src/env.ts` — extend the existing `createEnv({ server: {...} })` (currently `HOST_SERVICE_SECRET`, `ORGANIZATION_ID`, `HOST_DB_PATH`, etc.):
```ts
DAYTONA_API_KEY: z.string().min(1).optional(),
DAYTONA_API_URL: z.string().url().optional(),     // defaults to https://app.daytona.io/api inside the SDK
DAYTONA_TARGET: z.string().optional(),
```
Keep them optional so a host with no Daytona config still boots; the adapter throws a clear error only when actually selected (Step 9).

**Command:** `bun install`

**Acceptance:** `bun install` resolves `@daytonaio/sdk@0.184.0`; `import { Daytona } from "@daytonaio/sdk"` typechecks in a scratch file; `env.DAYTONA_API_KEY` is typed `string | undefined`.

---

#### Step 2 — Scaffold the adapter package

**Create** these files (one folder per unit, `index.ts` barrel — repo convention):
- `packages/host-service/src/runtime/adapters/daytona/adapter.ts` — `DaytonaRuntimeAdapter implements RuntimeAdapter` (Step 9).
- `packages/host-service/src/runtime/adapters/daytona/DaytonaWorkspaceRuntime.ts` — the role-`workspace` handle (Step 4 + 6).
- `packages/host-service/src/runtime/adapters/daytona/DaytonaPtyTransport.ts` — PTY→desktop-terminal seam (Step 5).
- `packages/host-service/src/runtime/adapters/daytona/descriptor.ts` — re-export of `packages/host-service/src/runtime/descriptors/daytona.ts` (Step 3).
- `packages/host-service/src/runtime/adapters/daytona/status-map.ts` — `SandboxState` → `NormalizedRuntimeStatus` (Step 8).
- `packages/host-service/src/runtime/adapters/daytona/DaytonaActivityLease.ts` — in-memory lease (Step 7).
- `packages/host-service/src/runtime/adapters/daytona/index.ts` — barrel: `export { DaytonaRuntimeAdapter } from "./adapter"; export { daytonaDescriptor } from "./descriptor";`
- `packages/host-service/src/runtime/adapters/daytona/types.ts` — local types: `DaytonaSdk` (the minimal `Daytona` surface the adapter uses, for mocking), `DaytonaAdapterDeps`.

`types.ts` defines the dependency-injected SDK seam so unit tests never hit the network:
```ts
import type { Daytona, Sandbox } from "@daytonaio/sdk";
export type DaytonaSdk = Pick<Daytona, "create" | "get" | "delete" | "stop">;
export interface DaytonaAdapterDeps {
  sdk: DaytonaSdk;                       // injectable; prod = new Daytona({ apiKey })
  diffCollector: DiffCollector;          // from Phase D runtime/git/diff-collector.ts
  git: GitFactory;                       // host ctx.git, for host-side push
  mintRepoScopedToken: TokenMinter;      // Step 10
  db: HostDb;                            // runtime_instances writes
  now?: () => number;                    // injectable clock for lease tests
}
```

**Acceptance:** files exist, `index.ts` barrel compiles, no logic yet.

---

#### Step 3 — Descriptor (advertise ONLY what Daytona does)

**Create** `packages/host-service/src/runtime/descriptors/daytona.ts` using the Phase A facet types (`ExecutionSurface`, `IngressMode`, `EgressMode`, `OnStop`, `DurableStore`, `ActivityStrategy`):
```ts
import type { ProviderDescriptor } from "../types"; // Phase A
export const daytonaDescriptor: ProviderDescriptor = {
  provider: "daytona",
  roles: ["workspace"],
  execution: [{ kind: "pty" }],                                   // first-class PTY, no stderr-mux caveat
  ingress: [{ kind: "runtime-preview-url", tokenScheme: "standard" },
            { kind: "runtime-preview-url", tokenScheme: "signed", defaultTtlSec: 3600, maxTtlSec: 86400 }],
  egress: [{ kind: "allow-all" }, { kind: "deny-all" },
           { kind: "allow-cidrs", maxEntries: 10, ipv4Only: true }],
  persistence: { onStop: { kind: "keep-disk" }, durableStore: { kind: "none" } }, // stop keeps disk; archive deferred
  activity: { kind: "refresh-activity", idleStopMs: 15 * 60_000 },  // autoStop default 15 min
};
```
Notes baked into a `descriptor.test.ts` comment, not prose in code: egress is IPv4-CIDR-only, max 10, tier-gated (Tier1/2 cannot set sandbox-level policy — surfaced as a runtime error in Step 9, NOT as a missing descriptor mode).

**Create** `packages/host-service/src/runtime/descriptors/daytona.test.ts` — asserts: `roles` is exactly `["workspace"]`; `execution` contains `{kind:"pty"}` and no `streaming-command`; `egress` contains `allow-cidrs` with `maxEntries:10` and `ipv4Only:true`; `activity.kind === "refresh-activity"`; passes a Phase A `assertDescriptorWellFormed(daytonaDescriptor)` if that helper exists.

**Acceptance:** `descriptor.test.ts` green; descriptor advertises exactly Daytona's real capability set.

---

#### Step 4 — VERTICAL SLICE: `createInstance` → clone → destroy (no PTY yet)

This is the first runnable slice. Implement `DaytonaRuntimeAdapter.createInstance({ role: "workspace", repo, branch, env })` and `destroy(externalId, mode)` end to end, plus the clone using the host-push security model.

**`adapter.ts` `createInstance`:**
```ts
async createInstance(plan: RuntimePlan<"workspace">): Promise<DaytonaWorkspaceRuntime> {
  const sandbox = await this.deps.sdk.create({
    language: "typescript",                       // never default to python
    envVars: plan.env ?? {},                      // env the agent legitimately needs (Security: blast radius = agent's)
    autoStopInterval: 15,                          // minutes; lease keeps it alive (Step 7)
    networkBlockAll: true,                         // DENY-ALL default (Step 9)
    networkAllowList: DEFAULT_DEV_CIDRS,           // minimal allowlist (Step 9), may throw on Tier1/2 -> Step 9 handling
    ephemeral: false,
  });
  await this.persistInstance(plan.workspaceId, sandbox); // INSERT runtime_instances row (status from status-map)
  await this.cloneRepo(sandbox, plan);                    // below
  return new DaytonaWorkspaceRuntime(sandbox, this.deps, plan);
}
```

**Clone — short-lived single-repo-scoped token (NOT host-push; clone needs creds in-sandbox once):** Per refined plan Security: clone uses a short-lived single-repo-scoped token; push uses host-side push (Step 6b). Mint a scoped token and pass it to Daytona's provider git API (`sandbox.git.clone(url, path, branch?, undefined, "x-access-token", token)`), which talks to the Daytona host git API — the token rides one TLS call, is `contents:read/write` scoped to ONE repo, TTL ≤ 1h:
```ts
private async cloneRepo(sandbox: Sandbox, plan: RuntimePlan<"workspace">) {
  const { token } = await this.deps.mintRepoScopedToken({ owner: plan.repo.owner, repo: plan.repo.name });
  await sandbox.git.clone(plan.repo.httpsUrl, "workspace", plan.branch, undefined, "x-access-token", token);
  // token is now stale within the hour; never persisted, never echoed to logs/metadataJson
}
```
Hard gate (assert + clear error): never pass a user PAT or org-wide token. The minted token is `repositories:[repo]`, `permissions:{contents:'write', metadata:'read'}`.

**`destroy`:**
```ts
async destroy(externalId: string, mode: CleanupMode): Promise<void> {
  const sandbox = await this.deps.sdk.get(externalId);
  await this.deps.sdk.delete(sandbox, 60_000);            // delete requires timeout arg
  await this.markDestroyed(externalId);                   // UPDATE runtime_instances SET status='destroyed', destroyedAt
}
```

**Tests** — `packages/host-service/src/runtime/adapters/daytona/adapter.test.ts` (mocked `DaytonaSdk`, in-memory fake `mintRepoScopedToken`, fake `HostDb`):
- `createInstance` calls `sdk.create` with `networkBlockAll:true` and `language:"typescript"`, never `python`.
- `createInstance` inserts a `runtime_instances` row with `provider:"daytona"`, `role:"workspace"`, `externalId` = sandbox id, `status` = mapped from `started`.
- `cloneRepo` calls `mintRepoScopedToken({owner,repo})` exactly once and passes the returned token as the `password`/token arg of `sandbox.git.clone`, with username `"x-access-token"`.
- `cloneRepo` NEVER writes the token into the inserted `metadataJson` (assert `JSON.parse(row.metadataJson)` contains no value equal to the token).
- `destroy` calls `sdk.delete(sandbox, 60000)` and sets `status:"destroyed"` + `destroyedAt`.

**Command:** `cd packages/host-service && bun test src/runtime/adapters/daytona/adapter.test.ts`

**Acceptance:** vertical slice (create → scoped-token clone → destroy) passes with a mocked SDK; no token appears in any persisted column; `runtime_instances` lifecycle row transitions created→destroyed.

---

#### Step 5 — PTY shell streamed into the EXISTING desktop terminal renderer (`DaytonaPtyTransport`)

The integration target is the **desktop-local** `WorkspaceRuntime` seam (`apps/desktop/src/main/lib/workspace-runtime/types.ts`), NOT the host-service WS route. The named renderer hooks `useTerminalStream`/`useTerminalLifecycle` already consume per-pane EventEmitter events. A remote terminal runtime must implement the same `TerminalRuntime` interface and emit the SAME events. Two integration surfaces:

**5a — host-service side (this package):** `DaytonaPtyTransport.ts` owns the Daytona PTY and exposes a small async surface the desktop runtime consumes over the existing host-service tRPC channel:
```ts
export class DaytonaPtyTransport {
  private handle: PtyHandle | null = null;
  private decoder = new TextDecoder("utf-8");          // ONE persistent decoder; stream:true avoids splitting UTF-8 across WS chunks
  constructor(private sandbox: Sandbox, private paneId: string) {}

  async start(cols: number, rows: number, cwd = "workspace", envs?: Record<string,string>) {
    this.handle = await this.sandbox.process.createPty({
      id: this.paneId,                                  // REQUIRED; this is the reconnect/kill handle
      cols, rows, cwd, envs,
      onData: (bytes) => this.onData(this.decoder.decode(bytes, { stream: true })),  // emit STRING (desktop-local seam is string-based)
    });
    await this.handle.waitForConnection();              // MUST await before first sendInput
  }
  write(data: string)        { return this.handle!.sendInput(data); }        // append \n upstream as today
  signalInterrupt()          { return this.handle!.sendInput(new Uint8Array([3])); } // Ctrl+C
  resize(cols: number, rows: number) { return this.handle!.resize(cols, rows); }     // arg order (cols, rows)
  async kill()               { await this.handle!.kill(); }                  // disconnect() does NOT terminate; kill() does
  async reconnect(cols, rows) { this.handle = await this.sandbox.process.connectPty(this.paneId, { onData: ... }); }
  private onData(str: string) { /* feed up to the desktop runtime's `data:${paneId}` emitter */ }
}
```
Key facts encoded: `id` is mandatory and is the reconnect/kill handle; `waitForConnection()` before first input; `disconnect()` leaves the process alive — only `kill()`/`killPtySession()` terminate; transport is WebSocket carrying `Uint8Array`.

**5b — desktop side:** **Modify** the registry/runtime so a remote workspace returns a `DaytonaWorkspaceRuntime`-backed `TerminalRuntime`:
- `apps/desktop/src/main/lib/workspace-runtime/registry.ts` — `getForWorkspaceId(workspaceId)` currently always returns `getDefault()` (local). Make it inspect the workspace's `runtimeKind` (Phase C column, surfaced to desktop) and return a remote runtime instance when `runtimeKind === "remote"`. This is the documented selection point ("Future: check workspace metadata… select cloud runtime").
- **Create** `apps/desktop/src/main/lib/workspace-runtime/remote.ts` — `RemoteWorkspaceRuntime implements WorkspaceRuntime` whose `terminal` implements `TerminalRuntime` by bridging host-service Daytona PTY events into per-pane emitters `data:${paneId}` / `exit:${paneId}` / `disconnect:${paneId}` / `error:${paneId}`, mirroring `LocalTerminalRuntime` in `local.ts`. CRITICAL: the stream subscription MUST NOT `emit.complete()` on exit (types.ts invariant #1; paneIds are reused across restarts) — emit an `exit` event, keep the subscription open.
- `capabilities`: `{ persistent: true, coldRestore: false }` for v1 (Daytona PTY can reconnect via `connectPty`, but cross-app-restart cold restore is out of scope).

**Tests:**
- `packages/host-service/src/runtime/adapters/daytona/DaytonaPtyTransport.test.ts` (mocked `PtyHandle`): `start` calls `createPty` with `id === paneId` and awaits `waitForConnection` before any `sendInput`; `write` appends nothing extra (caller controls `\n`); `signalInterrupt` sends `new Uint8Array([3])`; `resize` forwards `(cols, rows)` in that order; `kill` calls `handle.kill()` not `disconnect()`; multi-byte UTF-8 split across two `onData` chunks decodes to ONE correct string (feed `[0xF0,0x9F]` then `[0x98,0x80]`, assert single `😀`).
- `apps/desktop/src/main/lib/workspace-runtime/remote.test.ts`: emitting a Daytona exit does NOT complete the stream (a `data:${paneId}` listener added after exit still receives subsequent data); events use the exact `data:${paneId}` channel name.

**Command:** `cd packages/host-service && bun test src/runtime/adapters/daytona/DaytonaPtyTransport.test.ts && cd ../../apps/desktop && bun test src/main/lib/workspace-runtime/remote.test.ts`

**Acceptance:** a remote PTY shell streams bytes into the real desktop renderer terminal path; input/resize/Ctrl-C/kill round-trip; UTF-8 is not corrupted across chunk boundaries; the exit invariant holds.

---

#### Step 6 — `DaytonaWorkspaceRuntime`: diff (Phase D) + host-side push

**6a — `getDiff` via the Phase D collector.** `DaytonaWorkspaceRuntime.getDiff()` must produce identical output to local. Daytona has no host-side checkout, so run the Phase D collector commands inside the sandbox via `sandbox.process.executeCommand` and feed raw output through the SAME `diff-collector` parser:
```ts
async getDiff(): Promise<RuntimeDiff> {
  const run = (cmd: string) => this.sandbox.process.executeCommand(cmd, "workspace");
  const status = (await run("git status --porcelain=v1 -z")).result;
  const unstaged = (await run("git diff --binary")).result;
  const staged   = (await run("git diff --cached --binary")).result;
  const log      = (await run("git log --format=... ")).result;
  return parseDiff({ status, unstaged, staged, log }); // diff-collector.ts pure parser from Phase D
}
```
Phase D must expose the parser as a pure function (`parseDiff`) separate from the local `ctx.git` execution, so both local and Daytona reuse it. If Phase D only exposes a `ctx.git`-bound collector, add a pure `parseDiff(raw)` in `runtime/git/diff-collector.ts` here and have the local path delegate to it (keeps "collector reused by the remote adapter" AC from refined plan Phase D).

**6b — host-side push (broad token never enters the sandbox).** Refined-plan-preferred model: collect the patch from the sandbox, push from the HOST where the scoped token lives.
- `DaytonaWorkspaceRuntime.exportPatch()` runs `git format-patch` (or `git bundle create`) inside the sandbox and downloads it via `sandbox.fs.downloadFile(remotePath)` → `Buffer`.
- **Create** a host-service tRPC mutation `packages/host-service/src/trpc/router/git/git.ts` addition (or a new `runtime/git` procedure) `pushRemotePatch({ workspaceId, patch })` that: materializes/locates the host worktree branch, applies the patch with `ctx.git(worktreePath).raw(["am", ...])` or `git apply`, then pushes with the SAME `ctx.git` instance — which carries the `CloudGitCredentialProvider` askpass env (the scoped token). Reuse push-target resolution from `apps/desktop/src/lib/trpc/routers/changes/utils/git-push.ts` (`pushWithResolvedUpstream`) but run through `ctx.git` so the scoped token is used.
- Same-repo only: assert the workspace's upstream owner/repo matches the token scope; fork-push is explicitly out of scope v1 (base-repo-scoped token cannot push to a fork — `pr-branch-materialize.ts` synthetic fork remotes).

**Tests** — `packages/host-service/src/runtime/adapters/daytona/DaytonaWorkspaceRuntime.test.ts` (mocked `Sandbox`):
- `getDiff` calls `executeCommand` with `git status --porcelain`, `git diff --binary`, `git diff --cached --binary`, `git log …`, in the `"workspace"` cwd, and returns the result of `parseDiff` on the concatenated raw output (assert parser is the Phase D `parseDiff`, e.g. via a spy producing a known `RuntimeDiff`).
- `getDiff` output for a fixed fake `git status`/`git diff` fixture equals the local adapter's output for the same fixture (shared golden fixture in `runtime/contract/fixtures/`).
- `exportPatch` downloads via `sandbox.fs.downloadFile` and returns a `Buffer`; the patch is never passed to `metadataJson`.
- `pushRemotePatch` (router test) rejects with a clear error when `upstreamOwner/upstreamRepo` differs from the workspace repo (fork guard).

**Acceptance:** Daytona `getDiff` matches local byte-for-byte on the shared fixture (refined plan Phase D AC: collector reused by remote adapter); push happens host-side using the scoped token; no broad token is ever sent into the sandbox.

---

#### Step 7 — Preview URL + in-memory activity lease

**7a — Preview URL.** `DaytonaWorkspaceRuntime.exposePreview(port)`:
```ts
async exposePreview(port: number): Promise<{ url: string }> {
  const { url } = await this.sandbox.getPreviewLink(port); // standard token-in-header; token RESETS on restart
  // persist ONLY port + sandboxId; never the token, never the token-bearing URL (Security gate, Secret-type forbidden in previewUrl col)
  await this.deps.db.update(runtimeInstances)
    .set({ previewUrl: url })  // url is the host shape https://{port}-{id}.{domain}; token lives in a header, not the URL
    .where(eq(runtimeInstances.externalId, this.sandbox.id));
  return { url };
}
```
After any sandbox restart, re-fetch via `getPreviewLink()` (the standard token is invalid post-restart) — never cache the token. For private sandboxes, the consumer sends the token in the `x-daytona-preview-token` header; the host→adapter channel is authenticated separately (never use the public preview URL for control-plane auth).

**7b — Activity lease (in memory, never rely on preview traffic).** `DaytonaActivityLease.ts` implements the Phase A `ActivityLease`:
```ts
export class DaytonaActivityLease implements ActivityLease {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private sandbox: Sandbox, private intervalMs = 60_000) {}
  start() { this.timer = setInterval(() => this.heartbeat(), this.intervalMs); }
  async heartbeat(): Promise<HeartbeatResult> {
    try { await this.sandbox.refreshActivity(); return { ok: true }; }  // resets lastActivityAt; NOT refreshData()
    catch { return { ok: false, reason: "expired" }; }
  }
  async release() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
```
Facts encoded: `refreshActivity()` resets the idle timer without changing state; the server `autostopCheck` runs ~every 10s; internal dev-server traffic does NOT keep the sandbox alive — the timer is the ONLY keep-alive. `refreshData()` is explicitly NOT used (it only re-fetches state). The lease is started when a session attaches and `release()`d on detach/destroy. State stays in memory — no `runtime_activity_leases` table in v1.

**Tests:**
- `DaytonaActivityLease.test.ts` (fake timers via injected `now` / `vi.useFakeTimers()`): `start` then advancing `intervalMs` calls `sandbox.refreshActivity()` once per interval; `release` stops further calls; `heartbeat` returns `{ok:false,reason:"expired"}` when `refreshActivity` throws; asserts `refreshData` is NEVER called.
- `DaytonaWorkspaceRuntime.test.ts`: `exposePreview` persists `previewUrl` but never a token value; calling `exposePreview` twice re-invokes `getPreviewLink` (no token caching).

**Acceptance:** lease calls `refreshActivity` on the timer (not preview traffic); preview URL re-fetches after restart and no token is persisted.

---

#### Step 8 — Map Daytona lifecycle states → `NormalizedRuntimeStatus`

**Create** `status-map.ts`:
```ts
import type { NormalizedRuntimeStatus } from "../../types"; // Phase A
type SandboxState = string; // verbatim Daytona enum values
export function mapDaytonaState(state: SandboxState): NormalizedRuntimeStatus {
  switch (state) {
    case "creating": case "starting": case "restoring": case "pulling_snapshot": return "starting";
    case "started": case "resizing":                                              return "running";
    case "stopping": case "stopped": case "archiving": case "archived":           return "stopped";
    case "destroying": case "destroyed":                                          return "destroyed";
    case "error": case "build_failed":                                            return "error";
    default:                                                                      return "unknown"; // pending_build, building_snapshot, snapshotting, forking, unknown
  }
}
```
`getStatus(externalId)` in `adapter.ts`: `const s = await this.deps.sdk.get(externalId); return mapDaytonaState(s.state);`. For `error` states, also read `s.recoverable`/`s.errorReason` and surface them in `failureReason` (do not auto-`recover()` in v1).

**Tests** — `status-map.test.ts`: every documented `SandboxState` value maps to a defined `NormalizedRuntimeStatus` (table-driven, one assertion per enum value); unknown/odd strings fall through to `"unknown"`; `started → "running"`, `archived → "stopped"`, `destroyed → "destroyed"`, `error → "error"`.

**Acceptance:** the full Daytona `SandboxState` enum is covered; mapping is exhaustive with a safe `"unknown"` default.

---

#### Step 9 — Deny-all egress default + tier-gating error; stop/delete cleanup semantics

**9a — Egress.** Default to deny-all + minimal IPv4-CIDR allowlist at create (Step 4 already passes `networkBlockAll:true` + `networkAllowList`). Define `DEFAULT_DEV_CIDRS` (≤10 entries; e.g. the org's package-registry/proxy ranges — keep it minimal). For runtime changes, `setEgress(policy)` calls `sandbox.updateNetworkSettings({ networkBlockAll, networkAllowList })`. Tier-gating: Tier1/Tier2 orgs cannot set sandbox-level policy — the Daytona API errors. Catch it and surface a typed runtime error, do NOT silently fall back to default egress:
```ts
async setEgress(p: EgressMode): Promise<void> {
  try { await this.sandbox.updateNetworkSettings(toDaytonaNetwork(p)); }
  catch (e) {
    throw new RuntimeProviderError("EGRESS_TIER_GATED",
      "Daytona Tier 1/2 organizations cannot set sandbox-level network policy; upgrade to Tier 3/4 to control egress.");
  }
}
```
CIDR validation before the call: IPv4 only, every entry has `/N` (0..32), max 10 entries — reject early with a clear message (don't round-trip an invalid policy).

**9b — Stop/delete semantics.** `stop` = `sdk.stop(sandbox)` (clears memory, keeps disk → maps to `stopped`). `destroy(externalId, mode)` already deletes (Step 4): `sdk.delete(sandbox, 60_000)` (instance `delete` REQUIRES the timeout arg). Archive is out of v1 scope (descriptor `durableStore:none`); do not call `archive()`. On `destroy`, also `release()` the activity lease and `kill()` any live PTY.

**Tests** — extend `adapter.test.ts`:
- create passes `networkBlockAll:true`.
- `setEgress` with `>10` CIDRs / a hostname / IPv6 throws a validation error BEFORE calling the SDK.
- `setEgress` surfaces `RuntimeProviderError("EGRESS_TIER_GATED", …)` when `updateNetworkSettings` rejects.
- `destroy` calls lease `release()` and PTY `kill()` before `sdk.delete`.

**Acceptance:** new sandboxes default to deny-all egress; invalid/tier-gated egress requests produce clear runtime errors; stop keeps disk, delete passes the required timeout, and cleanup releases lease + PTY.

---

#### Step 10 — Scoped-token minter wiring (clone token + host-push token)

The minter is the seam the clone (Step 4) and host-push (Step 6b) both need. If Phase C/D did not already add it, add it here, scoped to this PR.

**Create (apps/api)** a route that mints a single-repo-scoped installation token using the existing GitHub App: `apps/api/src/app/api/github/scoped-token/route.ts` calling `githubApp.getInstallationOctokit(installationId)` then `octokit.rest.apps.createInstallationAccessToken({ repositories:[repo], permissions:{ contents:"write", metadata:"read" } })`. Resolve `installationId` from `githubInstallations` by org and the repo from `githubRepositories.fullName` (`packages/db/src/schema/github.ts`). Gate with org membership. Return `{ token, expiresAt }` (TTL ~1h). Rationale for a route vs shared-trpc procedure: the GitHub App (`githubApp`) lives in `apps/api`, which the shared `packages/trpc` cannot import — the host calls this over HTTP.

**Modify (host-service)** the credential wiring at `packages/host-service/src/serve.ts:60` and `apps/desktop/src/main/host-service/index.ts:105` (the two `credentials: new LocalGitCredentialProvider()` sites): construct `new CloudGitCredentialProvider(tokenFetcher)` for remote workspaces, where `tokenFetcher(remoteUrl)` parses owner/repo from `remoteUrl` and calls the new endpoint. The adapter's `mintRepoScopedToken` dep (Step 2) uses the SAME fetcher.

**Fix the latent cache bug (refined-plan + grounding):** `CloudGitCredentialProvider` caches one askpass keyed only by expiry, not by repo. For single-repo-scoped tokens this returns the wrong scope across repos. Either (a) include the repo in the cache key, or (b) for the clone token in Step 4, bypass the provider cache and mint per-call. Add a test in `CloudGitCredentialProvider.test.ts` asserting two different repos within the cache window get DIFFERENT tokens.

**Tests:**
- `apps/api/src/app/api/github/scoped-token/route.test.ts` (mocked `githubApp`): calls `createInstallationAccessToken` with `repositories:[repo]` and `permissions:{contents:"write",metadata:"read"}`; rejects non-members; returns `{token,expiresAt}`.
- `packages/host-service/src/providers/git/CloudGitCredentialProvider/CloudGitCredentialProvider.test.ts`: two distinct repos within the cache TTL receive distinct tokens (the wrong-scope guard).

**Acceptance:** a single-repo-scoped, ≤1h token is minted for clone and host-push; no user PAT or org-wide token ever reaches the sandbox; the per-repo cache bug is fixed and covered by a test.

---

#### Step 11 — `DaytonaRuntimeAdapter` assembly + `reconnect` + provider selection

**Finish `adapter.ts`** implementing the full Phase A `RuntimeAdapter`:
```ts
export class DaytonaRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor = daytonaDescriptor;
  constructor(private deps: DaytonaAdapterDeps) {}
  createInstance(plan) { /* Step 4 */ }
  async reconnect(externalId) { const s = await this.deps.sdk.get(externalId);
    if (mapDaytonaState(s.state) === "stopped") await s.start(); // start stopped sandbox before use
    return new DaytonaWorkspaceRuntime(s, this.deps, /* reconstruct plan from runtime_instances row */); }
  getStatus(externalId) { /* Step 8 */ }
  destroy(externalId, mode) { /* Step 4 + 9b */ }
}
```
Construct in prod with `new Daytona({ apiKey: env.DAYTONA_API_KEY })` — inject explicitly, never rely on env fallback inside a host service. Throw a clear error if `env.DAYTONA_API_KEY` is unset when the adapter is selected.

**Wire selection (Phase E facade):** the host-service `workspaces.create` adapter facade and the desktop `getForWorkspaceId` (Step 5b) pick `DaytonaRuntimeAdapter` when `runtimeKind === "remote"` and `provider === "daytona"`. v1 validation = "provider exists and supports role `workspace`" checked against the descriptor (`descriptorSupports(daytonaDescriptor, …)`), no `RuntimePlanner` rules.

**Tests** — `adapter.test.ts`: `reconnect` on a `stopped` sandbox calls `start()` before returning; `reconnect` on a `started` sandbox does not; constructing the adapter with no `DAYTONA_API_KEY` and then calling `createInstance` throws a clear configuration error.

**Acceptance:** the adapter implements the complete `RuntimeAdapter` contract; reconnect restarts stopped sandboxes; selection routes remote `daytona` workspaces to it.

---

#### Step 12 — Contract suite (mocked) + gated real-API integration test

**12a — Contract suite (unit, mocked SDK).** **Create** `packages/host-service/src/runtime/adapters/daytona/daytona.contract.test.ts` that runs the Phase A/B `describeRuntimeProviderContract` against `DaytonaRuntimeAdapter` backed by an in-memory fake `DaytonaSdk` (a deterministic state machine modeling create/get/stop/delete/PTY). This is the descriptor-driven suite that fails when reality contradicts the descriptor — it must include `describePersistenceContract` (stop+reconnect keeps disk, matching `persistence.onStop:keep-disk`), `describePtyContract` (input/resize/exit, exit does NOT complete the stream), and `describeDiffContract` (golden fixture from Step 6).

**12b — Gated integration test (real API key, skipped in normal CI).** **Create** `packages/host-service/src/runtime/adapters/daytona/daytona.integration.test.ts` following the repo's `*.integration.test.ts` convention (e.g. `v2-diff-surfaces.integration.test.ts`, `git-helpers.integration.test.ts`). Gate it:
```ts
const RUN = !!process.env.DAYTONA_API_KEY && process.env.RUN_DAYTONA_INTEGRATION === "1";
describe.skipIf(!RUN)("daytona integration (real API)", () => {
  it("create → clone → exec → preview → destroy", async () => {
    const adapter = new DaytonaRuntimeAdapter({ sdk: new Daytona({ apiKey: process.env.DAYTONA_API_KEY! }), /* real deps */ });
    const rt = await adapter.createInstance({ role:"workspace", repo: TEST_PUBLIC_REPO, branch:"main", env:{} });
    try {
      const diff = await rt.getDiff();              // smoke
      const { url } = await rt.exposePreview(3000);
      expect(url).toContain("3000-");
    } finally { await adapter.destroy(rt.externalId, "full"); } // always clean up
  });
});
```
Use a public test repo (no token-scope dependency) and ALWAYS destroy in `finally` so leaked sandboxes don't accrue cost. The test is skipped unless both `DAYTONA_API_KEY` and `RUN_DAYTONA_INTEGRATION=1` are set — so normal `bun test` and CI skip it.

**Commands:**
- Unit/contract (CI): `cd packages/host-service && bun test src/runtime/adapters/daytona`
- Integration (manual/gated): `cd packages/host-service && DAYTONA_API_KEY=… RUN_DAYTONA_INTEGRATION=1 bun test src/runtime/adapters/daytona/daytona.integration.test.ts`

**Acceptance:** `describeRuntimeProviderContract` + `describePersistenceContract` + `describePtyContract` + `describeDiffContract` pass against the mocked Daytona adapter; the gated integration test, when run with a real key, creates a real sandbox, clones, execs, exposes a preview, and self-cleans, and is skipped otherwise.

---

#### Step 13 — Final verification (single end-of-cycle pass, per Quality Check Discipline)

**Commands (run once, before PR):**
```bash
cd /Users/tylersheffield/code/superset
bun run lint:fix
bun run typecheck
bun test                                   # gated integration stays skipped
bash scripts/check-simple-git-usage.sh     # adapter must use ctx.git / Daytona SDK git, never raw execFile("git")
bash scripts/check-git-ref-strings.sh
```
(If a `scripts/check-runtime-capability.sh` lint was added in Phase A to ban ad-hoc capability booleans, run it too; the Daytona adapter must ask capability questions only via `descriptorSupports`.)

**Phase F acceptance criteria (from the refined plan, all must hold):**
1. A remote (Daytona) workspace runs an agent and streams a terminal into the EXISTING desktop renderer terminal path (same per-pane events, exit does not complete the stream).
2. `getDiff` returns identical output to local via the Phase D collector (shared golden fixture).
3. A preview URL is exposed and re-fetched after restart; the standard token is never persisted.
4. An in-memory activity lease keeps the sandbox alive via `refreshActivity()` on a timer — never relying on preview traffic; `refreshData()` is never used for keep-alive.
5. `stop`/`delete` use correct Daytona semantics (stop keeps disk; delete passes the required timeout; lease + PTY released on destroy).
6. Egress defaults to deny-all + minimal IPv4 CIDR allowlist; tier-gated failures surface a clear runtime error; the descriptor advertises only what Daytona supports.
7. Security gates: no broad/PAT/org-wide token ever enters the sandbox (clone uses a short-lived single-repo-scoped token; push is host-side); no secrets in `metadataJson`/`previewUrl`/logs (branded `Secret` forbidden at the type level).
8. `SandboxState` → `NormalizedRuntimeStatus` mapping is exhaustive.
9. Unit/contract tests (mocked SDK) pass in CI; the real-API integration test is gated and skipped in normal CI.
10. Lint, typecheck, and the git-usage guard scripts all pass.

---

## Global testing & CI

## Cross-cutting testing + CI strategy

**Runner is `bun:test`, full stop.** Every contract spec, fake, and co-located `*.test.ts` in `packages/host-service` imports `{ describe, expect, test }` from `bun:test`. The package test script is `bun test --pass-with-no-tests`; there is no vitest config in the repo. Authoring against vitest is the single most likely way to ship dead tests. (The desktop renderer side, where the non-PTY fake drives `useTerminalLifecycle`/`useTerminalStream`, uses the desktop app's existing test setup — match whatever that hook's existing tests use.)

**The contract suite is the spine (Phases A → B → D → E → F).**
- Authored in A as PURE specs under `runtime/contract/`: `describeRuntimeProviderContract` (harness) + five sub-contracts (`describePtyContract`, `describeFilesystemContract`, `describePersistenceContract`, `describeActivityLeaseContract`, `describeDiffContract`). Each takes a `makeAdapter` factory and **must be exported but NOT executed at import time** — no top-level `describe`, or `bun test` runs them with no adapter and fails.
- The contract is descriptor-driven: it **fails when an adapter contradicts its own descriptor** (e.g. a `{kind:'pty'}` descriptor whose handle lacks `startShell`; a non-PTY adapter that accepts `writeStdin`). Assert descriptor-vs-behavior agreement, not just happy-path output — otherwise it degenerates into a PTY-shaped rubber stamp.
- B runs it against two fakes (PTY + non-PTY); D runs `describeDiffContract` against the collector; E runs the FULL suite against `LocalWorktreeRuntime`; F runs it against Daytona (unit, mocked SDK) plus `describePersistenceContract` against the real provider.

**The non-PTY hard gate (B).** A mandatory non-PTY run of the workspace contract — the suite cannot pass unless at least one non-PTY runtime satisfies it. The non-PTY fake emits ONLY `{type:'data'}`/`{type:'exit'}` `TerminalStreamEvent`s (the shape `useTerminalStream.handleStreamData` already consumes); it must NOT touch `resize`/`write`/cold-restore snapshots/`clearScrollback` (PTY-only). The renderer read-only gate is a ref (`isReadOnlyRef`) checked at the TOP of `handleTerminalInput` and `handleKeyPress`, mirroring the existing `isRestoredModeRef.current` early-returns — not a render-coupled branch (it is a hot input path).

**Golden-snapshot regression for D.** Before refactoring `getDiff`, capture the current tRPC endpoint output as a golden snapshot (per-file `{oldFile,newFile}` content via `git.show`, NOT a unified patch). The collector must reproduce it byte-identically across all four category branches (against-base merge-base, staged `:0:`, commit `from^`, unstaged index-vs-worktree). Reuse the existing `initRepo`/`commitFile` temp-repo harness.

**Schema verification for C.** Inspect the drizzle-generated SQL before committing — drizzle-kit emits a `__new`-table rebuild (SQLite recreate pattern) for new columns, not a plain ALTER. Verify the generated migration against a copy of a real `host.db`. Regenerate (never hand-merge) `meta/_journal.json` after rebasing PR2 on PR1.

**Lint / typecheck (per-phase, run once before each PR).**
- `check-runtime-capability.sh` (new in A) bans ad-hoc capability booleans; wire it into `/scripts/lint.sh` at repo ROOT (where `check-git-ref-strings.sh` lives), not `packages/host-service/scripts/`.
- `check-simple-git-usage.sh` already forbids importing `simple-git` outside approved wrappers — the diff collector (D) and Daytona adapter (F) must accept a `SimpleGit` from `ctx.git`, never construct one.
- tsconfig is verbatim ESM with `allowImportingTsExtensions` + `isolatedModules`: every relative import needs a `.ts` extension and every type-only re-export needs `export type`, or tsc/biome fails.
- A Phase F lint bans logging `Secret`-typed values and `${token}`-in-URL construction.
- Follow the repo's quality-check discipline: run lint/typecheck/test ONCE per dev cycle right before opening each PR, not per-edit.

**Integration test gating (F only).** Unit tests run against a mocked `@daytonaio/sdk` (pinned exact 0.184.0) and run in CI unconditionally. The real-API integration test is GATED behind an env flag / credentials and skipped by default — it must never block CI on missing Daytona creds. It exercises the live `create → clone → shell → destroy` slice plus the tier-gated egress error path.

---

## Rollout (PR-by-PR)

## PR-by-PR rollout checklist

**Branch discipline (every PR):** branch off `main` (never commit to `main`); one phase = one PR except C = two PRs; conventional-commit messages focused on what/why; use `gh` for PR operations; merge only when the phase AC (the merge gate) is met and CI is green.

### PR 0 — Reconciliation gate (`feat/runtime-phase-0-reconciliation`)
- [ ] Commit a one-page decision doc: names host-service `HostServiceRuntime` (not desktop `WorkspaceRuntime`) as the relevant peer; states `RuntimeAdapter` is the per-workspace execution backend BELOW the chat/filesystem/pullRequests/diff capability managers.
- [ ] Records: ONE registry per layer (no third introduced); status vocabulary = a documented mapping between `NormalizedRuntimeStatus` and cloud `sandboxStatusEnum` (11 members); `runtime_routes` deferred to v2-remote-ports (preview state stays terminalId-keyed; `runtime_instances.previewUrl` = runtime-level ingress only).
- [ ] Two tiny NON-behavioral type/lint touchpoints only. Do NOT move terminal code or merge registries here (that is E).
- **Gate:** decision doc committed; no second registry; status mapping written before C.

### PR A — Type seam + contracts (`feat/runtime-phase-a-type-seam`)
- [ ] `RuntimeAdapter`, role-discriminated `createInstance`/`RuntimeHandleFor`, variant-carrying facets (`ExecutionSurface`/`IngressMode`/`EgressMode`/`OnStop`/`DurableStore`/`ActivityStrategy`), `ProviderDescriptor`, `ActivityLease`+`HeartbeatResult` (with `must-rehydrate`), `RuntimeBinding`, `NormalizedRuntimeStatus`, `CleanupMode`, `RuntimePlan`. Types only, zero adapters.
- [ ] Pure contract specs under `runtime/contract/` (exported, not run at import). `check-runtime-capability.sh` wired into root `/scripts/lint.sh`.
- [ ] Cross-check frozen Daytona descriptor facets against "Corrected provider facts" (CIDR-only/tier-gated egress, `refresh-activity` heartbeat).
- **Gate:** types compile (`.ts` extensions, `export type`); contracts are runnable specs with no adapters; `bun test` does not try to execute them.

### PR B — Contract suite + fakes (`feat/runtime-phase-b-fakes-gate`)
- [ ] Harness + five sub-contracts complete; `fake-pty-workspace` and `fake-command-workspace` both pass; each sub-contract asserts descriptor-vs-behavior disagreement fails.
- [ ] Non-PTY fake drives the real renderer in a read-only mode via `isReadOnlyRef` early-returns in `handleTerminalInput`/`handleKeyPress`; emits only `data`/`exit` events.
- **Gate (HARD):** both fakes green; non-PTY fake renders in real UI. No remote work starts until this merges.

### PR C1 — Schema columns + fatal migrate (`feat/runtime-phase-c1-columns`)
- [ ] Make startup `migrate()` fatal (log full error + dbPath before rethrow); add `runtimeKind` (default `'local'`) + `currentRuntimeId` (plain nullable text, NO FK yet — table does not exist) + `terminalSessions.runtimeInstanceId` (nullable).
- [ ] Inspect generated SQL vs a real `host.db` copy; verify existing local workspaces load unchanged.

### PR C2 — `runtime_instances` table + Secret brand (`feat/runtime-phase-c2-instances`)
- [ ] Rebase on C1; REGENERATE `meta/_journal.json` + snapshots (never hand-merge). Add `runtime_instances` table; add the `currentRuntimeId` → `runtime_instances` reference here. Brand `Secret`, type-forbid in `metadataJson` (state the partial-guarantee limit honestly).
- **Gate (C):** existing local workspaces operate unchanged; failed migration is fatal/diagnosable.

### PR D — Diff collector (`feat/runtime-phase-d-diff-collector`)
- [ ] Capture golden snapshot of current `getDiff` first. Extract `runtime/git/diff-collector/` accepting `SimpleGit` from `ctx.git` (no `simple-git` import); preserve exact category branching; tRPC `git.getDiff` delegates with byte-identical output. `describeDiffContract` passes; document untracked-as-`??` handling.
- **Gate:** diff viewer output unchanged (golden snapshot); collector reusable by F.

### PR E — Extract LocalWorktreeRuntime (`feat/runtime-phase-e-local-extract`)
- [ ] `runtime/adapters/localWorktree/` COORDINATES existing `setup/teardown/filesystem/git`/terminal — does not rewrite the ~540-line `workspaces.create` branching (PR/adopt/typed-branch paths, sagas) — threads the adapter only at seam points (worktree add, terminal start, descriptor lookup). `LocalPtyTransport` wraps `createTerminalSessionInternal`/`DaemonClient` byte-for-byte (same `&&` join, listed flag, replay). Local activity lease = no-op (`heartbeat → {ok:true}`, `release` no-op).
- **Gate:** local path byte-for-byte identical; passes the FULL contract suite.

### PR F — Daytona adapter, end-to-end (`feat/runtime-phase-f-daytona`)
- [ ] Vertical slice first: create → clone (host-push diff via D + short-lived single-repo-scoped token; assert same-repo or fail; per-call token mint not the expiry-only askpass cache) → PTY shell into desktop renderer → destroy.
- [ ] Then diff (D), preview (re-fetch `getPreviewLink()` after restart; store only port+sandboxId), in-memory `refreshActivity` lease (timer; never rely on preview traffic), stop-delete cleanup, deny-all egress (catch + surface tier-gated failure as `NormalizedRuntimeStatus`).
- [ ] `DaytonaPtyTransport` surfaces as a desktop `WorkspaceRuntime` emitting the SAME per-pane events (`data:${paneId}`), never `emit.complete()` on exit; desktop terminal router calls `getForWorkspaceId(workspaceId)` (not the once-captured default). Decode `Uint8Array` with one persistent `TextDecoder({stream:true})` per session.
- [ ] Add the apps/api token-mint route (`createInstallationAccessToken` scoped to `[repo]`) + host-service `tokenFetcher` in THIS PR if not already present. Pin `@daytonaio/sdk` exact version. Mocked-SDK unit tests in CI; gated real-API integration test.
- **Gate:** remote workspace runs an agent, streams terminal, collects diff, exposes preview, self-cleans; contract + persistence contracts pass; security gates met (no broad token in sandbox, deny-all default, no secrets in metadata/logs).

---

## Risk register

## Consolidated risk register

| # | Risk | Phase | Mitigation |
|---|---|---|---|
| R1 | TWO registries exist (desktop `WorkspaceRuntime` terminal-centric vs host-service `HostServiceRuntime` per-capability). If 0 doesn't name the peer, A–F create a THIRD. | 0 | Decision doc names host-service `HostServiceRuntime` as the peer; `RuntimeAdapter` = execution backend BELOW the capability managers. |
| R2 | In-flight diff + chat plans extend `HostServiceRuntime` with sibling managers; `RuntimeAdapter` as a new top-level concept competes with them. | 0 | State `RuntimeAdapter` is the thing `app.ts` selects per-workspace to BACK those managers, not a replacement. |
| R3 | v2-remote-ports owns a terminalId-keyed preview model; a `runtime_routes`/per-instance preview model double-writes. | 0, C | No `runtime_routes` in v1; `runtime_instances.previewUrl` = runtime-level ingress only; per-terminal ports stay in v2-remote-ports. |
| R4 | Status vocabulary collision: cloud `sandboxStatusEnum` (11 members) vs new `NormalizedRuntimeStatus` will drift. | 0, C | Decide canonical set + documented mapping in 0, BEFORE C writes the column. |
| R5 | Phase 0 scope creep (moving terminal code / merging registries). | 0 | 0 = decision doc + two non-behavioral touchpoints only; registry merge is E. |
| R6 | Authoring tests against vitest — they would not run. | A,B,D,E,F | All `*.test.ts` and contract specs import from `bun:test`; package script `bun test --pass-with-no-tests`. |
| R7 | verbatim-ESM tsconfig (`allowImportingTsExtensions`+`isolatedModules`): missing `.ts` extension or `export type` breaks tsc/biome. | A | Every relative import `.ts`; every type-only re-export `export type`. |
| R8 | Two `WorkspaceRuntime` types collide (desktop terminal vs new host-service handle). | A | Keep in separate packages; name the new role-handle distinctly per the 0 decision. |
| R9 | `check-runtime-capability.sh` wired into the wrong location. | A | Wire into root `/scripts/lint.sh` (where `check-git-ref-strings.sh` lives). |
| R10 | Frozen descriptor facets seed every later phase; wrong Daytona facts propagate. | A | Cross-check against "Corrected provider facts" before merging (CIDR-only/tier-gated egress, refresh-activity). |
| R11 | Pure-spec contracts run at import with no adapter → `bun test` fails. | A,B | Export specs; no top-level `describe`; execute only via a `makeAdapter` caller. |
| R12 | Renderer read-only gate added as a render-coupled branch on the hot input path → keystroke-rate re-renders. | B | `isReadOnlyRef` checked at TOP of `handleTerminalInput`/`handleKeyPress`, mirroring `isRestoredModeRef.current`. |
| R13 | Non-PTY fake reaches into PTY-only ops (`resize`/`write`/snapshots/`clearScrollback`) → gate proves nothing. | B | Fake emits only `data`/`exit` `TerminalStreamEvent`s. |
| R14 | Contract degenerates into a PTY rubber stamp (only happy-path). | A,B | Each sub-contract asserts descriptor-vs-behavior agreement; a contradicting adapter must FAIL. |
| R15 | Persistence/lease sub-contracts can't be written if A didn't freeze `ActivityLease`/`HeartbeatResult`/`OnStop`/`DurableStore`. | A,B | Freeze those types in A (hard dependency). |
| R16 | drizzle-kit emits `__new` table rebuild, not plain ALTER. | C | Inspect generated SQL vs a real `host.db` copy before commit. |
| R17 | Fatal `migrate()` crashes hosts that previously limped on a bad/locked DB. | C | Log full error + dbPath before rethrow so the failure is diagnosable. |
| R18 | Branded `Secret` only constrains `Secret`-typed call sites; a plain string token still type-checks. | C | State the partial guarantee; full coverage lands with F egress redaction + lint. |
| R19 | C's two PRs both touch `meta/_journal.json` → rebase conflicts. | C | REGENERATE (never hand-merge) after rebasing C2 on C1. |
| R20 | `currentRuntimeId` FK references a table that doesn't exist until C2. | C | C1 ships it as plain nullable text (no FK); FK added in C2. |
| R21 | Diff byte-identical regression: `getDiff` returns per-file `{oldFile,newFile}` via `git.show`, not a unified patch. | D | Golden snapshot before refactor; preserve exact category branching. |
| R22 | Collector constructs its own `simple-git` → violates `check-simple-git-usage.sh`. | D,F | Accept `SimpleGit` from `ctx.git` (`GitFactory`); never import `simple-git`. |
| R23 | `describeDiffContract` (authored in A) drifts from D's assertion surface. | A,D | Keep in sync; reconcile rather than redefine. |
| R24 | Untracked files silently dropped by the Daytona adapter. | D,F | Document untracked-as-`??` (`status --porcelain=v1`) handling, mirroring `getGitStatusSnapshot`. |
| R25 | Rewriting the ~540-line `workspaces.create` breaks PR-adoption/rollback sagas. | E | Facade calls existing helpers unchanged; thread adapter only at seam points. |
| R26 | `LocalPtyTransport` diverges from `createTerminalSessionInternal`/`DaemonClient` (initialCommand join, listed flag, replay). | E | Wrap byte-for-byte; coordinate, do not reimplement. |
| R27 | Activity-lease contract falsely fails the local no-op lease. | A,E | Contract accepts a no-op lease (`heartbeat → {ok:true}`, no-op `release`). |
| R28 | Desktop terminal router captures `registry.getDefault().terminal` ONCE at construction → no per-workspace remote selection. | F | E/F router change calls `getForWorkspaceId(workspaceId)`. |
| R29 | `DaytonaPtyTransport` emits `complete()` on exit (violates types.ts invariant #1) or wrong per-pane events. | F | Surface as desktop `WorkspaceRuntime`, same `data:${paneId}` events, never `emit.complete()`. |
| R30 | Data-type seam: desktop path = strings, Daytona `onData` = `Uint8Array`; multi-byte UTF-8 split across WS chunks corrupts output. | F | One persistent `TextDecoder({stream:true})` per session. |
| R31 | Daytona egress is tier-gated; Tier1/2 `updateNetworkSettings`/`networkBlockAll` API-errors. | F | Catch and surface a clear `NormalizedRuntimeStatus` failure; never silently run default egress. |
| R32 | Standard preview token RESETS on restart; persisting a token-bearing URL leaks. | F | Store only port + sandboxId; re-fetch `getPreviewLink()` after restart. |
| R33 | Cross-repo/fork PR push: base-repo-scoped token can't push to a fork. | F | Host-push path asserts same-repo or fails clearly; cross-fork OUT OF SCOPE for v1. |
| R34 | `CloudGitCredentialProvider` caches askpass by expiry only, not repo → wrong-scope bug for single-repo tokens. | F | Per-call clone-token mint, not the cache; or include repo in cache key. |
| R35 | Token-mint endpoint (apps/api `createInstallationAccessToken` scoped `[repo]`) does not exist yet. | F | Add a thin apps/api route + host-service `tokenFetcher` in THIS PR if absent. |
| R36 | `@daytonaio/sdk` vs `@daytona/sdk` both publish identical 0.184.0. | F | Pick `@daytonaio/sdk`, pin exact version (host-service is Node — Buffer-polyfill caveat irrelevant). |

---

## Open items to resolve during build

## Open items to resolve during build

These are the refined-plan open questions still live for v1 (the "is remote a goal at all" and "which provider" questions are answered: yes, Daytona). Resolve before or during the named phase.

1. **Phase 0 ownership decision (BLOCKING for everything).** Who owns the single capability model and registry across the four in-flight host-service plans (chat, filesystem-transport, diff, v2-remote-ports)? Confirm `RuntimeAdapter` sits BELOW the capability managers and that `runtime_routes` is folded into v2-remote-ports' terminalId-keyed model rather than added. This is the gate the rest of the plan hangs on.

2. **Canonical status set (resolve in 0, needed before C).** Pin the exact `NormalizedRuntimeStatus` members and the explicit mapping to cloud `sandboxStatusEnum` (11 members: pending/spawning/connecting/warming/syncing/ready/running/stale/snapshotting/stopped/failed). C writes the `status` column against this; deferring it causes drift.

3. **Does cloud Postgres need any of this in v1?** Default is NO — runtime state stays host-local SQLite. If cross-device UI must show `runtimeKind`/remote status, a mirrored cloud field requires the Neon-branch workflow as a SEPARATE, deferrable PR. Decide whether that UI need is real before F, or explicitly punt it.

4. **Reconcile new model with existing cloud `cloudWorkspaceConfigSchema`** (`modalSandboxId → externalId`, `status → status`, `lastActivityAt → lastActivityAt`, `snapshotImageId → future snapshot ref`). State which is source of truth — recommended: host `runtime_instances` = local execution metadata; cloud config stays the cloud projection until a cross-device need forces unification. Confirm in 0/C.

5. **Security posture for Daytona (decide before F).** Host-side push (token never enters the sandbox) is the recommended, strictly-safer default. Confirm this is acceptable for v1, or specify the in-sandbox git-auth requirement (which widens blast radius). Also confirm: deny-all egress default is acceptable for the agent workloads v1 targets.

6. **Snapshot/image taint policy.** Not exercised by Daytona's stop-delete v1 cleanup (Daytona "snapshots" are reusable image templates, not live checkpoints, and v1 does not reuse base images). Decide the default-tainted policy BEFORE any snapshot-reuse provider; for v1, the operative rule is simply: do not snapshot when a disk-delivered secret was in scope. Confirm v1 takes no snapshots.

7. **Concrete trigger for provider #2.** Name the workload that pulls in the second provider (e.g. "Modal when parallel test-runners/GPU are requested") so breadth stays demand-pulled, not spec-pushed. Not a v1 blocker, but record it so the deferred seams don't re-expand speculatively.