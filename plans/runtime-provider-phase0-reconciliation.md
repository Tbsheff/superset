# Runtime Provider Abstraction — Phase 0 Reconciliation (ADR)

**Status:** Accepted · **Date:** 2026-06-03 · **Scope:** v1 (local + Daytona)

This is a committed decision record. It resolves how the new `RuntimeAdapter` /
`ProviderDescriptor` layer (Phase A, landing in `packages/host-service`) relates
to the **two pre-existing abstractions** in the repo, and freezes the status
vocabulary so Phases A and C agree. Phase 0 ships this doc plus two minimal,
zero-behavior-change code touchpoints (steps 5–6). No registry, no
`runtime/providers/` directory, no `runtime_routes` table, and no terminal or
manager code moves here — those are Phases C/E/F.

The two existing abstractions are not the same thing:

| Abstraction | Location | Shape | Who extends it |
|---|---|---|---|
| Desktop `WorkspaceRuntime` + `WorkspaceRuntimeRegistry` | `apps/desktop/src/main/lib/workspace-runtime/{types.ts,registry.ts,local.ts,index.ts}` | Terminal-centric (`terminal: TerminalRuntime`, `capabilities.terminal`), Electron **main** process | Nobody yet |
| Host-service `HostServiceRuntime` | `packages/host-service/src/types.ts:16`, assembled `app.ts:120` | Per-capability managers (`auth`, `chat`, `filesystem`, `pullRequests`); lives on `ctx.runtime` (`types.ts:29`) | in-flight diff / chat / filesystem-transport plans |

The `RuntimeAdapter` layer lands in `packages/host-service`, so its real peer is
`HostServiceRuntime`, **not** the desktop `WorkspaceRuntime`.

---

## Decision 1 — Adopt the host-service capability vocabulary; don't reinvent it

**Decision:** `RuntimeAdapter` is the per-workspace **execution backend** that
sits **below** the existing host-service capability managers (`chat`,
`filesystem`, `pullRequests`, and the in-flight `diff`), not a sibling of them
and not a replacement. A `RuntimeHandleFor<"workspace">` (the role-discriminated
handle from Phase A) is what a future per-workspace selector hands to those
managers so a remote workspace's `filesystem`/`chat`/`git` resolve against the
remote instance instead of a local worktree. We reuse the noun `runtime` already
on `ctx.runtime` (`HostServiceContext.runtime`, `types.ts:29`) and the
per-capability manager pattern.

**Why:** the desktop `WorkspaceRuntime` interface is terminal-shaped and
Electron-coupled (guarded by `no-electron-coupling.test.ts`), so importing it
into host-service would drag the wrong boundary across the process line. The
host-service managers already own `workspaceId → worktreePath` resolution; the
adapter is the layer that makes "where does this workspace run" pluggable
underneath them.

```
HostServiceContext.runtime (existing)
  ├─ auth / chat / filesystem / pullRequests  (capability managers — unchanged in v1)
  └─ [Phase E/F] runtimeRegistry: workspaceId -> RuntimeAdapter
                                         │
                                         ├─ localWorktree adapter  (Phase E)
                                         └─ daytona adapter        (Phase F)
```

## Decision 2 — One registry per process boundary, two boundaries, shared vocabulary

**Decision:** There are exactly two registries — one per process boundary — and
neither is duplicated:

- **Host-service:** the selector that maps `workspaceId → RuntimeAdapter` lives
  next to `HostServiceRuntime` (recommended: a `runtimeRegistry` field added to
  `HostServiceRuntime` in a **later** phase, not Phase 0). The capability
  managers keep their current `workspaceId → worktreePath` resolution for v1 and
  gain a `workspaceId → RuntimeAdapter` path only in Phase E/F.
- **Desktop:** the existing `WorkspaceRuntimeRegistry` (`registry.ts`) stays the
  single desktop-side terminal registry; it is not duplicated. When a remote
  workspace exists, its `getForWorkspaceId` will route terminal ops over the
  host-service transport (future work; named here, out of scope for v1).

**Why:** the two boundaries (Electron main vs host-service) are real and cannot
collapse into one object, but a third competing registry inside host-service
would re-derive what `HostServiceRuntime` already models.

**Invariant (checkable):** no third registry is introduced. Phase A–F must not
add a `runtime/providers/` directory or a second `workspaceId → backend` map
outside the host-service `runtimeRegistry` field and the desktop
`WorkspaceRuntimeRegistry`.

## Decision 3 — `runtime_instances` is local execution truth; cloud config stays the cloud projection; unify the status vocabulary

**Decision 3a (source of truth):** host `runtime_instances` (Phase C) is the
source of truth for **local execution metadata**; the cloud `config` JSON
(`cloudWorkspaceConfigSchema`, `packages/db/src/schema/zod.ts:10`) stays the
**cloud projection** and is **not** unified in v1. Phase C must not try to FK
across the Postgres/SQLite boundary.

**Decision 3b (field mapping):**

| cloud `cloudWorkspaceConfigSchema` field | host `runtime_instances` field | note |
|---|---|---|
| `modalSandboxId` / `modalObjectId` | `externalId` | provider-opaque reconnect id; provider-specific extras → `metadataJson` |
| `status` (`sandboxStatusEnum`) | `status` (`NormalizedRuntimeStatus`) | see 3c |
| `lastActivityAt` | `lastActivityAt` | epoch ms in host SQLite vs ISO string in cloud config |
| `snapshotImageId` | (deferred) | no snapshot column in v1; lands with first snapshot-reuse provider |
| `lastSpawnError` / `spawnFailureCount` | `failureReason` (+ counts → `metadataJson`) | v1 keeps one failure string column |

**Decision 3c (canonical status):** `NormalizedRuntimeStatus` is the v1
**normalization** of `sandboxStatusValues` (`packages/db/src/schema/enums.ts:51`,
11 members). v1 set: `"pending" | "starting" | "ready" | "running" | "stopped" |
"failed"`.

**Correction to the plan's wording:** this is **not a strict subset** — the cloud
enum has no `starting` member; `starting` collapses the four transient bring-up
members (`spawning|connecting|warming|syncing`). The binding contract is the
total projection `cloudToNormalizedStatus: Record<CloudSandboxStatus,
NormalizedRuntimeStatus>`: typing it as a `Record` keyed by the cloud tuple
forces it to be total over all 11 members and forces every produced value to be a
`NormalizedRuntimeStatus`. That `Record` typing is the compile-time guarantee the
two vocabularies cannot drift; the runtime mirror lives in `status.test.ts`. The
11→6 projection:

| cloud `sandboxStatus` | normalized | rationale |
|---|---|---|
| `pending` | `pending` | 1:1 |
| `spawning` | `starting` | transient bring-up |
| `connecting` | `starting` | transient bring-up |
| `warming` | `starting` | transient bring-up |
| `syncing` | `starting` | transient bring-up |
| `ready` | `ready` | 1:1 |
| `running` | `running` | 1:1 |
| `stale` | `running` | still alive, idle |
| `snapshotting` | `running` | still alive while imaging |
| `stopped` | `stopped` | 1:1 |
| `failed` | `failed` | 1:1 |

Phase A freezes the `NormalizedRuntimeStatus` type; Phase 0 records the set and
projection so A and C agree.

**Why:** the total `Record<CloudSandboxStatus, NormalizedRuntimeStatus>`
projection means the two vocabularies cannot drift — adding a cloud member breaks
compilation until it is projected, and changing a projection target to a
non-normalized value also breaks compilation. Enforced at compile time and
re-checked at runtime in `packages/host-service/src/runtime/status.ts` /
`status.test.ts` (see Touchpoints).

**electric sync note:** `runtime_*` is server/host-managed and is **NOT** synced
to local-db/desktop (matches refined plan §Data model).

## Decision 4 — No `runtime_routes` in v1; preview is one runtime-level origin; per-terminal ports stay in v2-remote-ports

**Decision:** No `runtime_routes` table ships in v1. v2-remote-ports
(`plans/20260422-v2-remote-ports.md`) already owns listening-port surfacing
keyed by `terminalId`, workspace-grouped, host-scoped, with no schema (reusing
`terminalSessions`'s `terminalId/workspaceId/pid`). Per-terminal listening ports
remain entirely in that model. `runtime_instances.previewUrl` is reserved for a
**single runtime-level ingress origin** (the workspace's one preview URL from a
remote provider, e.g. Daytona `getPreviewLink()`), not per-port routes.

**Why:** duplicating port routing into a new table would fork the source of
truth v2-remote-ports already defines.

**Build trigger:** if a `runtime_routes` table is ever needed, it must first be
folded into v2-remote-ports' `terminalId`-keyed model.

## Decision 5 — Phase-0 code is exactly the two touchpoints below

**Decision:** the only Phase-0 code is Touchpoints 1 and 2. Everything
structural — extracting `LocalWorktreeRuntime`, adding `runtimeRegistry` to
`HostServiceRuntime`, wiring managers to adapters — is Phase C/E, not Phase 0.

**Why:** Phase 0 is a decision gate. Behavior changes belong to phases with their
own acceptance criteria and rollback story.

---

## Touchpoints (the two Phase-0 code changes)

**Touchpoint 1 — startup migration failure is fatal.**
`packages/host-service/src/db/db.ts` re-throws after logging a failed `migrate`,
so a bad migration crashes startup instead of silently running on an un-migrated
SQLite file. Covered by `packages/host-service/src/db/db.test.ts` (happy path +
throw on a nonexistent migrations folder).

**Touchpoint 2 — pin the shared status type and align the desktop docstring.**
`packages/host-service/src/runtime/status.ts` exports
`normalizedRuntimeStatusValues` / `NormalizedRuntimeStatus` plus the 11→6
`cloudToNormalizedStatus` projection, with the total-`Record` compile-time
guarantee and a runtime mirror in `status.test.ts`. The desktop `WorkspaceRuntime`
JSDoc
(`apps/desktop/src/main/lib/workspace-runtime/types.ts`) now points readers at
this doc and states the desktop boundary stays terminal-only.

**Note on the status import:** `@superset/db` is not a dependency of
`packages/host-service`, and the package's export is `@superset/db/enums` (not
`@superset/db/schema/enums`). Rather than add a cross-package dependency for a
type-only check, `status.ts` mirrors the 11 cloud `sandboxStatus` values as a
local literal tuple and enforces the projection via a total
`Record<CloudSandboxStatus, NormalizedRuntimeStatus>` (compile time) plus an
explicit runtime assertion in `status.test.ts`. The chosen set and projection
from Decision 3c stand regardless. If a later phase adds `@superset/db` as a
host-service dependency, the local mirror should be replaced with a direct import
of `sandboxStatusValues` so the projection binds to the real enum.

---

## Deferred to user

- None. All six decisions are settled above.
