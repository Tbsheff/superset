# Runtime Provider Plan (Refined) — Lean v1, Deferred North Star

This supersedes the original runtime-provider plan. It is grounded against the actual repo, corrected against verified provider docs, and rescoped per six adversarial critiques. The headline change: **stop building a six-provider capability operating system before a single remote workspace has run.** Extract the local worktree behind a thin runtime seam, prove it with fakes + a contract suite, ship exactly one remote provider, and let the second provider — not the spec — tell you which abstractions are real.

---

## Changelog vs original

- **Rescoped to a lean v1 (one remote provider), not 15 phases of taxonomy.** Grounding confirms the repo is local-only with zero provider abstraction and zero `runtime_*` tables; YAGNI + contrarian critiques both call the descriptor/planner/facet/lease machinery premature generalization for a one-provider reality. v1 = local-worktree extraction + fakes + contract suite + ONE remote provider. Everything else is a deferred seam.
- **Cut 5 of 6 providers from v1.** Daytona is the only provider that maps cleanly onto today's workspace shape (first-class PTY, provider git API, full FS, preview URLs, a real heartbeat verb). Vercel/Modal force a non-PTY terminal-UI rewrite; Cloudflare needs a deployed Worker/DO bridge that does not exist. (YAGNI, contrarian, architecture critiques.)
- **Cut 7 of 9 tables.** Ship `runtime_instances` + (optionally) `runtime_events`; add two nullable workspace columns. Everything provider-specific goes in `metadataJson` until a query needs an indexed column. The original `runtime_events` was in the migration-order list but missing from the table inventory — resolved. (Data-model critique.)
- **Reworked the type model before any code.** Replaced ~40 capability booleans + parallel enum arrays with discriminated, variant-carrying facets so illegal states are unrepresentable — matching the repo's existing `ResolvedRef` discipline (`runtime/git/refs.ts`, lint-enforced by `scripts/check-git-ref-strings.sh`). `createInstance` returns a role-discriminated handle, not a fat grab-bag. (Type-design critique.)
- **Corrected provider facts that the original baked in wrong.** Modal HAS a real PTY (`exec(pty=True)`); Vercel is persistent-by-default (auto-snapshot on stop, auto-resume on get); Vercel `get()` is keyed by name and auto-resumes (not active-only-by-id); Daytona egress is IPv4-CIDR-only and tier-gated (not host-based); Daytona "snapshots" are image templates, not live checkpoints. The original's `requireInteractiveTerminal=true fails for Modal` rule is deleted. (All four fact-checks.)
- **Pinned the target DB and migration workflow.** `runtime_*` tables and workspace columns live in **host-service SQLite** (`packages/host-service`, better-sqlite3, drizzle-kit `dialect: 'sqlite'`, migrations in `packages/host-service/drizzle/`, applied at startup via `migrate()`). The Neon-branch / `packages/db/drizzle` constraint applies ONLY if cloud Postgres is touched. The original never said which of the three `workspaces` tables it meant. (Data-model critique.)
- **Promoted security to a v1 gate, trimmed to two safe modes.** Untrusted agent code runs with shell + egress; env-var/mounted-file secrets are readable by the adversary. v1 collapses the 7-mode credential broker to: (1) short-lived single-repo-scoped git token, preferably **pushed from the host** so it never enters the sandbox, and (2) deny-all-egress default. Snapshot taint policy decided before any snapshot-reuse provider. (Security critique.)
- **Reordered: contract suite + fakes + planner come BEFORE local extraction, and a non-PTY fake is a hard gate before any remote provider.** The single biggest risk is a PTY-shaped abstraction; the original deferred proving otherwise to phase 10+. (Architecture + type-design critiques.)
- **Resolved the `providers/` naming collision.** New runtime adapters live under `packages/host-service/src/runtime/adapters/` and descriptors under `runtime/descriptors/` — NOT `runtime/providers/` and never `src/providers/` (which already holds auth/git/host-auth/model-providers). The word "provider" is overloaded; we use "adapter"/"runtime". (Architecture critique.)
- **Added a Phase 0 reconciliation gate** with the existing desktop `WorkspaceRuntime` + registry (`apps/desktop/src/main/lib/workspace-runtime/`) and the four in-flight host-service plans (chat, filesystem-transport, diff, remote-ports) that are independently building the same `workspaceId → host → capability` boundary. Without this, we ship a third competing abstraction. (Architecture critique.)
- **Kept the capability-descriptor model as a clearly-marked DEFERRED north star**, populated only with what local + the first remote provider actually exercise, growing member-by-member from real integrations.

---

## Grounded current state

What the repo actually is today (verified, not assumed):

| Claim in original | Reality | Status |
|---|---|---|
| Host-service is local-only, no remote runtime abstraction | True. `workspaces.create` directly does `git worktree add` at a local path, registers a SQLite row, then syncs to cloud. Agents run locally (terminal via daemon PTY; chat via Mastra harness). | accurate |
| `workspaces` has `runtimeKind` / `currentRuntimeId` / `syncStrategy` | Not present. Host SQLite `workspaces` (schema.ts:138) = `id, projectId, worktreePath (NOT NULL), branch, headSha, upstreamOwner/Repo/Branch, pullRequestId, createdAt`. | **wrong — must add** |
| `runtime_*` tables exist | None. Host SQLite has `terminalSessions, projects, hostSettings, pullRequests, hostAgentConfigs, workspaces`. | **wrong — must add** |
| `runtime/providers/` with provider impls exists | `runtime/` exists with concern-organized modules (`setup/`, `teardown/`, `filesystem/`, `git/`, `pull-requests/`, `chat/`, `main-workspace-sweep.ts`). No provider/adapter layer. | partly true |
| A `SandboxProvider`/`RuntimeProviderAdapter`/`ProviderDescriptor` exists | None anywhere in source. | accurate (none) |
| `src/providers/` collision | Confirmed: `providers/` holds `auth/, git/, host-auth/, model-providers/`. | accurate |
| Git is provider-neutral | True. `runtime/git/` has `simple-git.ts`, `git.ts` (`createGitFactory(GitCredentialProvider) → GitFactory`), `refs.ts` (`ResolvedRef` discriminated union), `types.ts` (`GitCredentialProvider`). Enforced by `scripts/check-simple-git-usage.sh` + `scripts/check-git-ref-strings.sh`. | accurate |
| `getDiff` is a provider-neutral collector | No. `getDiff` lives in the tRPC endpoint (`trpc/router/git/git.ts`) and uses `git.show()` one file at a time. No `--binary` collector module. | partly true |
| Terminal UI handles PTY and non-PTY modes | **Wrong.** Terminal UI + `HeadlessEmulator` are PTY-only and would break on non-PTY transports. | wrong |
| `wasm-*-emulator` work in progress | The headless emulator uses `@xterm/headless` (TS), not WASM. | wrong |

Other ground truth that shapes this plan:

- **Three separate `workspaces` tables exist**: cloud Postgres (`packages/db`, Neon), host SQLite (`packages/host-service`), local-db SQLite (`packages/local-db`). The original never said which it targeted. Runtime instance tracking belongs in **host SQLite**.
- **Cloud already models sandbox state.** `packages/db/src/schema/zod.ts:10` `cloudWorkspaceConfigSchema` carries `modalSandboxId, modalObjectId, snapshotImageId, status, lastActivityAt, lastSpawnError, spawnFailureCount`; `schema.ts:620` `sandboxImages` table holds base images + setup commands. The new model must reconcile with these, not pretend they're greenfield.
- **An existing runtime abstraction already ships in desktop.** `apps/desktop/src/main/lib/workspace-runtime/{types.ts, registry.ts, local.ts, index.ts}` defines `WorkspaceRuntime`, a registry (`getForWorkspaceId`/`getDefault`), `LocalWorkspaceRuntime`, and capability flags, with comments saying its own docstring's invariant is "capability presence indicates feature availability, not health" and that cloud workspaces will extend the same boundary.
- **`terminalSessions` already exists** (`id, originWorkspaceId, status, createdAt, lastAttachedAt, endedAt`), owned by the pty-daemon. Any process tracking must reuse it, not duplicate it.
- **`db.ts` migration is failure-silent.** `migrate(db, {...})` is wrapped in a `try/catch` that swallows errors (db.ts:24–27), so a bad migration leaves the app running on an un-migrated DB. Fix this before adding new migrations.
- **In-flight host-service plans** (chat architecture, filesystem-transport, diff, v2-remote-ports) are each building a `workspaceId`-scoped capability boundary. v2-remote-ports already has a `terminalId`-keyed preview model that a `runtime_routes` table would conflict with.

---

## Corrected provider facts

Fold these in; do not repeat the original's stale claims. Sources verified at high confidence.

### Vercel Sandbox
| Original claim | Correction | Source |
|---|---|---|
| "Ephemeral unless snapshotted" | **Persistent-by-default** (`persistent: true`): auto-snapshot on stop, auto-restore on next resume. FS discarded only with `persistent: false`. | vercel.com/docs/sandbox/concepts/persistent-sandboxes |
| `Sandbox.get()` reconnects active-only by id | `Sandbox.get({name})` is keyed by **name**; if stopped, the next call auto-resumes (pass `resume:false` to skip). `getOrCreate()` and `fork()` also exist. | vercel.com/docs/sandbox/sdk-reference |
| Runtimes node24/22, python3.13 | Add **node26** (node24 default). | vercel.com/docs/sandbox |
| `updateNetworkPolicy()` | **Deprecated**; use `sandbox.update({ networkPolicy })`. | vercel.com/docs/sandbox/sdk-reference |
| No timeout limits stated | Default session 5 min; extend to **45 min (Hobby) / 5 h (Pro/Ent)**. Default 2 vCPU, 2048 MB/vCPU. Region `iad1` only. Up to 15 declared ports (at create or via `update`). | vercel.com/docs/sandbox/sdk-reference |
| Docs path `/docs/vercel-sandbox` | Canonical path is `/docs/sandbox`. | vercel.com/docs/sandbox |

Quirks: manual `sandbox.snapshot()` is destructive (shuts the sandbox down); auto-snapshot-on-stop is not. Persistent sandboxes snapshot on EVERY stop → `snapshotExpiration` + `keepLastSnapshots` retention is mandatory. `fork()` does not copy env. Preview ports are public, no built-in auth. `deny-all` blocks DNS.

### Daytona
| Original claim | Correction | Source |
|---|---|---|
| Egress = allow-hosts / deny-hosts | **IPv4 CIDR only**, max 10 entries, no hostnames/IPv6. `networkBlockAll` (deny-all) or `networkAllowList` (CIDRs). | daytona.io/docs/en/network-limits/ |
| Network policy is a static capability | **Tier-gated**: Tier 1/2 cannot set sandbox-level policy at all; Tier 3/4 can set at create and update live. | daytona.io/docs/en/network-limits/ |
| Snapshots = filesystem/memory checkpoints | Daytona "snapshots" are **reusable image templates** (OCI base for NEW sandboxes), not live-sandbox checkpoints. Persistence = stop (keep disk) / archive (disk to object storage) / delete. | daytona.io/docs/en/snapshots/ |
| `pause` preserves memory (VM-runner) | No separate pause op. **stop** = graceful, attempts to keep disk+memory; **force-stop** = hard SIGKILL. Treat memory preservation as best-effort. | daytona.io/docs/en/sandboxes/ |

Confirmed: first-class PTY (`createPty/sendInput/resizePty/killPty`); `refreshActivity()` heartbeat; auto-stop default 15 min idle, reset only by EXTERNAL interaction (internal dev servers do NOT keep it alive). **Do not rely on preview traffic for keep-alive** (docs inconsistent). Standard preview token resets on restart (re-fetch via `getPreviewLink()`); signed token persists (default TTL 60s, max 24h — set ~3600 explicitly). No file-watch API.

### Modal Sandboxes
| Original claim | Correction | Source |
|---|---|---|
| No PTY; command-stream only; `requireInteractiveTerminal=true` fails for Modal | **`exec(pty=True)` is a real PTY** (Modal's docs run Claude Code with it). Caveat: stderr is multiplexed into stdout; the PTY is per-exec, not a reconnectable login shell. The validation rule is deleted. | modal.com/docs/reference/modal.Sandbox |
| `cidr_allowlist` | Renamed `outbound_cidr_allowlist`. | modal.com/docs/reference/modal.Sandbox |
| GPU sandboxes generally preemptible | Sandboxes are NOT preemptible **except** when `gpu != None`. | modal.com/docs/guide/preemption |

Confirmed: default timeout 300s (max 24h, **hard cap — no extend-forever**); separate `idle_timeout`; terminal state `Finished` refuses further exec; Tunnels for ingress; Volumes sync on terminate; `snapshot_filesystem()` → Image (no list API, track `object_id` yourself). Beyond 24h: snapshot → new sandbox (rehydrate, not heartbeat).

### Cloudflare Sandbox SDK + Containers
| Original claim | Correction | Source |
|---|---|---|
| Raw disk ephemeral, no snapshots "yet to rely on" | ALL container disk is ephemeral (fresh on every wake); native snapshots "coming soon." Persistence today is **R2-backed only**. | developers.cloudflare.com/containers/architecture/ |
| Worker-side outbound brokering "outside container" | Correct, but for **raw Containers** HTTPS is NOT intercepted by default (`interceptHttps=false`; requires injecting + trusting an ephemeral CA). The **SDK** intercepts by default. Opposite trust postures per adapter. | developers.cloudflare.com/containers/platform-details/outbound-traffic/ |
| `renewActivityTimeout` is the heartbeat | True for raw containers; the SDK equivalent is `keepAlive:true` + explicit `destroy()`. Map both. | developers.cloudflare.com/sandbox/guides/background-processes/ |

Hard fact: the SDK/Container class runs **inside a Worker**; host-service cannot call it directly — a deployed Runtime Bridge Worker (Worker + Durable Object) is mandatory, not optional. SDK is Beta (pin the version). Port 3000 reserved. Preview URLs public by default.

---

## v1 scope (build now)

**One-sentence scope:** v1 runs a workspace on **one remote provider (Daytona, pending the user's choice)**, with the local worktree extracted as the second runtime to prove the seam is real. Nothing else ships.

**Why Daytona as the default candidate:** it is the only provider whose capability shape is a near-superset of today's local workspace (PTY + provider git + full FS + preview + a clean `refreshActivity` heartbeat), so it stresses the seam honestly **without** forcing the non-PTY terminal-UI rewrite that Vercel/Modal/Cloudflare demand. If the user wants a different first provider, see Open Questions.

v1 deliverables, in dependency order (detailed in Phased rollout):

1. **Phase 0 — Reconciliation gate.** Decide how this relates to the desktop `WorkspaceRuntime`/registry and the four in-flight host-service plans. One capability model, one registry.
2. **Phase A — Type seam + contract specs (no impl).** `RuntimeAdapter` interface, role-discriminated `createInstance`, variant-carrying facets, `describeRuntimeProviderContract`.
3. **Phase B — Fakes that prove the shape.** `fake-pty-workspace` AND `fake-command-workspace` (non-PTY) both pass the same contract. The non-PTY fake driving the **real renderer terminal path** is a hard gate.
4. **Phase C — Thin schema migration.** `workspaces.runtimeKind` (default `'local'`) + `workspaces.currentRuntimeId` (nullable) + `runtime_instances` table. Fix the silent-migrate bug first.
5. **Phase D — Provider-neutral diff collector.** Extract from the tRPC endpoint into `runtime/git/diff-collector.ts` (`status --porcelain`, `diff --binary`, `diff --cached --binary`, `log`).
6. **Phase E — Extract LocalWorktreeRuntime.** Coordinate existing `setup/`, `teardown/`, `filesystem/`, `git/`, terminal under one adapter behind `workspaces.create`. Zero behavior change. Must pass the full contract.
7. **Phase F — One remote adapter, end-to-end.** Vertical slice first (create → clone → shell → destroy), then diff, preview, in-memory activity lease, stop/delete cleanup.

v1 minimum-secure secret story and networking are in their own sections below and are **gates on Phase F**, not later hardening.

---

## Deferred (seams only, build when the 2nd/3rd provider arrives)

Keep the SEAM (interface stays additive); do NOT build the body until a real provider needs it.

| Deferred item | Build trigger |
|---|---|
| Vercel, Modal, Cloudflare SDK, Cloudflare Containers adapters | A concrete workload demands it (e.g. Modal when GPU/parallel test runners are requested). Add Vercel as provider #2 if you want maximal divergence to stress the abstraction. |
| `runtime_processes` table | Only if you must query processes by an indexed column across instances. Otherwise add a nullable `runtimeInstanceId` to existing `terminalSessions`. |
| `runtime_routes`, `runtime_snapshots`, `runtime_mounts`, `runtime_network_policies`, `runtime_activity_leases` | Each lands in the SAME PR as the provider that first writes it. `runtime_routes` must reconcile with v2-remote-ports first. |
| `RuntimeActivityLeaseManager` + heartbeat-kind enum + persisted leases | When the 2nd provider's lifetime model differs from the first. v1 lease is one `refreshActivity()` call on a timer, state in memory. Modal's hard-cap-rehydrate case must fit the interface (`heartbeat` may return "cannot-extend, must-rehydrate"). |
| Full `RuntimeCredentialBroker` (7 delivery modes) + `secretTaintStatus` | Phase that integrates a credential-isolating provider (Cloudflare worker-side broker). v1 reuses existing `GitCredentialProvider` + direct env. |
| Non-PTY transports (`CommandLogTransport`, `TerminalWebSocketTransport`) + read-only-log terminal UI | When a non-PTY remote provider (Vercel/Modal/Cloudflare) lands. The non-PTY fake already proves the renderer can do it. |
| `RuntimePlanner` validation rules (port-at-create, bridge-required, etc.) | Grow per real provider. v1 validation = "provider exists and supports role `workspace`," checked against the descriptor. |
| The full 5-axis enum taxonomy (`RuntimeRole`, `ExecutionSurface`, `PersistenceMode`, `IngressMode`, `EgressMode`) | Each enum stays single/few-member and grows member-by-member from real integrations. |
| Cloudflare Runtime Bridge Worker (Worker + DO) | Separate infra track, gated on Daytona+Vercel validating the abstraction. Pin `@cloudflare/sandbox` Beta version. |
| Provider scheduling/policy layer | When ≥2 providers are live and a real placement decision exists. |
| CodeInterpreterRuntime, JobRuntime, ServiceRuntime, PreviewRuntime as distinct roles | When a Superset feature actually consumes one. v1 has ONE role: `workspace`. |

**Deferred north star (kept, clearly marked as NOT v1):** the rich capability-descriptor model. We keep the descriptor as the cheap seam that makes provider #2 affordable, but populated only with what local + the first remote provider exercise. The full descriptor (resources, security, snapshot kinds, mounts, network-policy facets) is extracted from real integrations, never authored from docs up front — because authoring from docs is exactly how the original baked in the Modal/Vercel/Daytona errors corrected above.

---

## Corrected type design

Principle: **make illegal states unrepresentable** — match the repo's existing `ResolvedRef` discriminated-union discipline, not a boolean bag. Converge on the desktop `WorkspaceRuntime` vocabulary rather than inventing a second one.

### Role-discriminated handle (not a fat grab-bag)

```ts
type RuntimeRole = "workspace"; // single-member union for v1; grows additively

interface RuntimeAdapter {
  readonly descriptor: ProviderDescriptor;
  createInstance<R extends RuntimeRole>(plan: RuntimePlan<R>): Promise<RuntimeHandleFor<R>>;
  reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>>;
  getStatus(externalId: string): Promise<NormalizedRuntimeStatus>;
  destroy(externalId: string, mode: CleanupMode): Promise<void>;
}

type RuntimeHandleFor<R extends RuntimeRole> =
  R extends "workspace" ? WorkspaceRuntime : never;
```

A caller asking for `role: "workspace"` cannot be handed a handle missing `startShell`/`getDiff`/`exposePreview`, and cannot call workspace-only methods on a future job handle. Role is a discriminant on the OUTPUT type, not an input string.

### Variant-carrying facets (constraints live on the value)

Each capability mode is a discriminated member holding its own constraints — no parallel boolean flags. Predicates are DERIVED, never stored.

```ts
// Execution surface — Modal IS pty-capable, with its caveat as a typed field
type ExecutionSurface =
  | { kind: "pty"; stderrMultiplexedIntoStdout?: boolean }
  | { kind: "streaming-command" };

// Ingress — port rule and URL/auth rule compose, they don't compete for one slot
type IngressMode =
  | { kind: "runtime-preview-url"; tokenScheme: "standard" | "signed"; defaultTtlSec?: number; maxTtlSec?: number }
  | { kind: "declared-port-domain"; portsAtCreate: true; maxPorts: number };

// Egress — Daytona is CIDR-only and tier-gated; advertise ONLY what the provider does
type EgressMode =
  | { kind: "allow-all" }
  | { kind: "deny-all" }
  | { kind: "allow-cidrs"; maxEntries: number; ipv4Only: true };

// Persistence — split the two orthogonal questions the original conflated
type OnStop = { kind: "discard" } | { kind: "keep-disk" } | { kind: "keep-disk-and-memory" };
type DurableStore =
  | { kind: "none" }
  | { kind: "snapshot"; persistentByDefault?: boolean; autoSnapshotOnStop?: boolean }
  | { kind: "volume"; syncSemantics: "on-terminate" | "manual" | "immediate" };
// Vercel = onStop:keep-disk + durableStore:snapshot{persistentByDefault:true} — the flat enum couldn't express this.

// Activity — one normalized verb; provider vocabulary stays inside the adapter
type ActivityStrategy =
  | { kind: "refresh-activity"; idleStopMs: number }      // Daytona
  | { kind: "extend-timeout"; defaultMs: number; maxMs: number } // Vercel (plan-tiered)
  | { kind: "hard-cap"; maxMs: number }                   // Modal — implies rehydrate, no extend
  | { kind: "keep-alive-or-destroy" };                    // Cloudflare SDK
```

### One way to ask capability questions

```ts
const descriptorSupports = (d: ProviderDescriptor, kind: string): boolean =>
  d.execution.some(e => e.kind === kind) /* ...etc per facet */;
```

No call site re-derives capability from a boolean. Add a `scripts/check-runtime-capability.sh` lint banning ad-hoc capability booleans — mirroring `check-git-ref-strings.sh` / `check-simple-git-usage.sh`.

### Activity lease: one normalized method

```ts
interface ActivityLease {
  heartbeat(): Promise<HeartbeatResult>;
  release(): Promise<void>;
}
type HeartbeatResult = { ok: true } | { ok: false; reason: "must-rehydrate" | "expired" };
```

The adapter maps `heartbeat()` to `refreshActivity` / `extendTimeout` / `renewActivityTimeout` / `keepAlive` internally. Modal's hard cap returns `must-rehydrate` instead of pretending it's a heartbeat.

### Workspace runtime binding: discriminated column-group

Do not encode "where does this workspace run" as three loose fields. Model it as a discriminant + a boundary refinement:

```ts
type RuntimeBinding =
  | { kind: "local"; worktreePath: string }
  | { kind: "remote"; runtimeId: string };
// boundary refinement: local ⇒ worktreePath present; remote ⇒ runtimeId present.
```

In Drizzle this is `runtimeKind` (discriminant) + `worktreePath` (kept NOT NULL for v1) + nullable `currentRuntimeId`, with a zod/CHECK refinement at the boundary — same discipline `GIT_REFS.md` documents for `ResolvedRef`.

---

## Data model & migration safety

**Target:** host-service SQLite (`packages/host-service/src/db/schema.ts`), better-sqlite3, drizzle-kit `dialect: 'sqlite'`, migrations in `packages/host-service/drizzle/`, auto-applied at startup. Workflow: edit `schema.ts`, run `cd packages/host-service && bunx drizzle-kit generate --name=runtime_instances_v1`, commit the generated `drizzle/*.sql` + `meta/_journal.json`. **The Neon-branch / `packages/db/drizzle` rule applies ONLY if you also touch cloud Postgres** (e.g. to mirror `runtimeKind` for cross-device UI — defer that decision; see Open Questions).

**Fix first (blocker):** `db.ts:24–27` swallows migration errors. Make a failed startup migration fatal (or alarm) before adding new migrations — a silently un-migrated SQLite file is worse than a crash.

### v1 schema (two columns + one table)

```ts
// additive nullable columns on existing workspaces — every live row backfills safely
runtimeKind: text("runtime_kind").notNull().default("local"),     // 'local' | 'remote'
currentRuntimeId: text("current_runtime_id"),                      // nullable; app-enforced or FK onDelete:'set null'
// worktreePath stays NOT NULL for v1. Relax to nullable only when a remote-only workspace actually ships.

export const runtimeInstances = sqliteTable("runtime_instances", {
  id: text().primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text().notNull(),                 // 'local-worktree' | 'daytona' | ...
  role: text().notNull().default("workspace"),
  externalId: text("external_id"),            // provider name/id for reconnect (Vercel name, Daytona id)
  status: text().notNull(),                   // NormalizedRuntimeStatus
  previewUrl: text("preview_url"),            // one URL = a column, not a table
  lastActivityAt: integer("last_activity_at"),
  ttlExpiresAt: integer("ttl_expires_at"),
  metadataJson: text("metadata_json").notNull().default("{}"), // escape hatch for provider-specifics
  createdAt: integer("created_at").notNull(),
  destroyedAt: integer("destroyed_at"),
  failureReason: text("failure_reason"),
});
// Index: runtime_instances(workspaceId).
```

Optional `runtime_events` (append-only catch-all) only if you need queryable lifecycle history; otherwise events go in `metadataJson` or logs. If kept, define it in the schema — don't list it in migration order alone (the original's inconsistency).

### Rules

- **No manual migration ordering.** Drizzle generates one migration; FK order is resolved within it. Ship the workspace columns first (standalone PR, verified against live rows), then `runtime_instances`.
- **Reuse, don't duplicate.** For shell/PTY process tracking add a nullable `runtimeInstanceId` to existing `terminalSessions` (one ALTER, default null = backward compatible). Do NOT introduce `runtime_processes` in v1.
- **Reconcile with cloud.** Add a short subsection mapping `cloudWorkspaceConfigSchema` fields → new model (`modalSandboxId → externalId`, `status → status`, `lastActivityAt → lastActivityAt`, `snapshotImageId → a future snapshot ref`) and state which is source of truth (recommended: host `runtime_instances` = local execution metadata; cloud config stays the cloud projection until a cross-device need forces unification).
- **Invariant:** local ⇒ `worktreePath` present; remote ⇒ `currentRuntimeId` present. Enforce in app boundary or CHECK. "Generalized" must not mean "all columns nullable and meaningless."
- **Electric sync:** do NOT sync `runtime_*` to local-db/desktop; they are server-managed. State this explicitly (the original never addressed Electric across the three DB layers).
- **No raw secrets in any `*Json` column** (see Security).

---

## Security (v1 minimum-secure story)

**Threat model (state this at the top of the security section):** agent code is **untrusted**, runs with a shell and (by default) network egress. Assume it will read every env var, stat every file it can, and POST anything it finds to an attacker endpoint. Every credential decision is evaluated against this attacker. The original's rule "setup processes get fewer secrets than agents" is backwards — the agent is the untrusted party.

**v1 collapses 7 delivery modes to two safe ones:**

| Need | v1 mechanism |
|---|---|
| Git clone/push auth | **Short-lived, single-repo-scoped GitHub App installation token** (`contents:write`, `metadata:read`), TTL ≤ 1h, refreshed host-side via the existing `GitCredentialProvider`. **Preferred: push from the HOST** — collect diff/patch from the sandbox via the Phase D collector and push where the token already lives, so a broad token never enters the sandbox. **Hard gate:** never a user PAT, never an org-wide/Octokit-grade token in a remote sandbox. |
| Env secrets the agent legitimately needs | Pass directly to the provider's create call (Daytona accepts env). A credential's blast radius must equal the agent's authorized blast radius, because the agent WILL read it. |

**Structural redaction (build into Phases C + F, not aspirational prose):**

- Brand a `Secret` type; forbid it at the type level in all `metadataJson`/`previewUrl`/command columns. Metadata columns take `Record<string, JsonScalar>` excluding `Secret`.
- Store `tokenRef` only, never a token-bearing URL; reconstruct signed preview URLs on read.
- One egress-side redaction pass over persisted command/log/event streams, keyed off the workspace's known secret values, replacing them with `***`. (Today the codebase has zero redaction utilities and `console.log`s freely in `terminal.ts`.)
- Add a `check-*` lint banning logging of `Secret`-typed values and `${token}`-in-URL construction (same mechanism as `check-simple-git-usage.sh`).

**Snapshot/image taint (decide before any snapshot-reuse provider):** default every snapshot/image to **tainted**. A tainted artifact may NOT be a base for a new sandbox, may NOT cross workspace/org boundaries, gets short retention + auto-delete. `clean` requires provably no disk-resident secret (broker/proxy-only delivery). For v1's single provider: do not snapshot when any disk-delivered secret was in scope. This must be decided before enabling Vercel (auto-snapshot-on-stop) or Daytona base-image reuse.

**Deferred (north star):** the full `RuntimeCredentialBroker` (outbound-proxy / worker-side-broker / ssh-agent / git-credential-helper) and `secretTaintStatus` column — prototype on the first credential-isolating provider (Cloudflare worker-side handlers), not before.

---

## Networking (v1)

**Security default:** egress = **deny-all + allowlist** for any runtime running untrusted agent code. `allow-all` is opt-in and gated. The allowlist bounds where the agent can exfiltrate, so it's a containment control, not a networking nicety. (Most providers default to allow-all — Vercel allow-all, Modal `block_network=False`, Cloudflare `enableInternet=true`, Daytona Tier 3/4 full internet — so the safe posture must be set explicitly.)

**Per-adapter truth in the descriptor** (planner rejects unsupported modes before any provider call):

| Provider | Egress modes it actually supports | Notes |
|---|---|---|
| local-worktree | n/a (host network) | — |
| Daytona | `allow-all` (Tier 3/4), `deny-all`, `allow-cidrs` (≤10 IPv4) | Tier 1/2 cannot set policy; live update Tier 3/4 only. No host-based rules. |

Deferred providers carry their own descriptor fields (`outbound_cidr_allowlist` for Modal — corrected name; SNI domain-allow for Vercel; worker-side broker + `interceptHttps` default for Cloudflare). Preview URLs are public by default everywhere — **never use them for control-plane auth**; the host→adapter channel must be authenticated.

---

## Phased rollout + contract-test strategy

Reordered per the sequencing critique: type seam and contract specs come before any implementation; the non-PTY fake is a hard gate before any remote provider; schema lands after the adapter boundary is real; the activity-lease *interface* is designed up front with a local no-op so Daytona and (future) Modal both fit it.

**Naming (resolves the collision):** adapters live in `packages/host-service/src/runtime/adapters/{localWorktree,daytona}/`; descriptors in `runtime/descriptors/`; contract tests in `runtime/contract/`. Never `runtime/providers/`, never `src/providers/`.

### Phase 0 — Reconciliation gate (precondition for everything)
- Decide how the runtime descriptor model relates to desktop `WorkspaceRuntime`/registry and the four in-flight host-service plans (chat, filesystem-transport, diff, v2-remote-ports). Pick ONE capability model and ONE registry. Most likely the descriptor's facets ARE the union of what chat/diff/filesystem/ports already expose, and the registry is the one desktop already has.
- **AC:** a one-page decision committed; no second registry introduced.

### Phase A — Type seam + contract specs (no implementation)
- Define `RuntimeAdapter`, role-discriminated `createInstance`, variant-carrying facets, `ProviderDescriptor`, `ActivityLease` interface (with `must-rehydrate`), `RuntimeBinding`.
- Write `describeRuntimeProviderContract` + sub-contracts as PURE specs: `describePtyContract`, `describeFilesystemContract`, `describePersistenceContract` (asserts stop+reconnect FS behavior matches the descriptor), `describeActivityLeaseContract` (covers the hard-cap rehydrate path), `describeDiffContract`.
- Apply all corrected provider facts here BEFORE freezing descriptors.
- **AC:** types compile; contracts exist as runnable specs with no adapters.

### Phase B — Fakes prove the shape (hard non-PTY gate)
- `fake-pty-workspace` and `fake-command-workspace` (non-PTY, read-only/log) both pass `describeRuntimeProviderContract`.
- The non-PTY fake drives the **real renderer terminal path** in a usable read-only/log mode.
- **AC (gate):** both fakes green; non-PTY fake renders in the real UI. No remote provider work starts until this is green.

### Phase C — Thin schema migration
- Fix the silent-migrate bug.
- PR1: `workspaces.runtimeKind` (default `'local'`) + `currentRuntimeId` (nullable), verified against live rows. PR2: `runtime_instances`.
- Brand `Secret`; type-forbid it in `metadataJson`.
- **AC:** existing local workspaces load and operate unchanged; failed migration is fatal/alarmed.

### Phase D — Provider-neutral diff collector
- Extract `runtime/git/diff-collector.ts` (`status --porcelain`, `diff --binary`, `diff --cached --binary`, `log`) from the tRPC endpoint; endpoint delegates to it.
- **AC:** local diff output unchanged; `describeDiffContract` passes; collector reused by the remote adapter.

### Phase E — Extract LocalWorktreeRuntime
- `runtime/adapters/localWorktree/adapter.ts` coordinates existing `setup/config`, `teardown`, `filesystem`, `git`, and terminal under the `RuntimeAdapter` contract. Do NOT rewrite those modules — coordinate them. `LocalPtyTransport` wraps the existing `DaemonClient` with zero behavior change. `workspaces.create` routes to it via a facade (backward compatible).
- Local descriptor: `roles:['workspace']`, execution `[{kind:'pty'}]`, fs read/write/list, ingress preview, persistence `onStop:keep-disk`, activity local no-op lease.
- **AC:** local path byte-for-byte identical; passes the FULL contract suite (incl. non-PTY-agnostic checks where applicable).

### Phase F — First remote adapter, end-to-end
- Build `runtime/adapters/daytona/` (or the user's chosen provider). **Vertical slice first:** create → clone (host-pushed or scoped token) → PTY shell → destroy. Then add: diff via the Phase D collector, preview URL (re-fetch standard token after restart), in-memory activity lease (`refreshActivity` on a timer; never rely on preview traffic), `stop`/`delete` cleanup with correct semantics, deny-all egress default.
- Provider differences are plain methods + clear runtime errors (e.g. "Tier 1/2 cannot set egress policy"). The descriptor advertises only what the provider does.
- **AC:** a remote workspace runs an agent, streams a terminal, collects a diff, exposes a preview, self-cleans; passes `describeRuntimeProviderContract` and `describePersistenceContract` matching the real provider; security gates met (no broad token in sandbox; deny-all default; no secrets in `metadataJson`/logs).

### Contract-test strategy (summary)
- Contracts are **descriptor-driven** and **fail when reality contradicts the descriptor** — that's what prevents a one-provider-shaped abstraction.
- Required beyond happy-path: persistence round-trip (stop+reconnect preserves/loses FS per descriptor), activity-lease hard-cap path, and a **mandatory non-PTY run** of the workspace contract (the suite cannot pass unless at least one non-PTY runtime satisfies it).
- Run fakes against the type design in Phase A/B — the cheapest proof that the role-union and facet shapes catch illegal states at compile time before any provider exists.

---

## Open questions for the user

1. **Are remote runtimes a near-term goal at all?** If not, the genuinely valuable v1 shrinks to Phases A–E (extract local behind a seam + diff collector + fakes + contract suite) with no remote adapter. That alone de-risks future work without committing to a provider.
2. **Which remote provider first?** This plan defaults to **Daytona** (only one that fits without a terminal-UI rewrite or out-of-repo bridge). If you instead want **Vercel** (persistent microVM, command-log, declared ports), v1 must also fund the non-PTY terminal-UI path and the persistent-snapshot retention model. **Modal** adds a 24h-cap rehydrate path; **Cloudflare** requires standing up and operating a Worker/DO bridge. Pick one.
3. **Does cloud Postgres need any of this?** v1 keeps runtime state host-local (SQLite). If cross-device UI must show `runtimeKind`/remote status, we add a mirrored field to cloud `workspaces`/`v2Workspaces` (Neon-branch workflow) — but that's a separate, deferrable decision.
4. **How does this relate to the four in-flight host-service plans** (chat architecture, filesystem-transport, diff, v2-remote-ports)? Phase 0 must reconcile them. Who owns the single capability model and registry? Should `runtime_routes` be folded into v2-remote-ports' existing `terminalId`-keyed model?
5. **Does it converge on the existing desktop `WorkspaceRuntime`** (`apps/desktop/src/main/lib/workspace-runtime/`)? Recommended: yes — the host-service model should adopt that vocabulary, not introduce a second incompatible one. Confirm.
6. **Security posture for the first remote provider:** is host-side push (token never enters the sandbox) acceptable for v1, or do you need in-sandbox git auth? The former is strictly safer and is the recommended default.
7. **What is the concrete trigger for provider #2?** Naming the workload (e.g. "Modal when parallel test-runners/GPU are requested") keeps breadth demand-pulled, not spec-pushed, and prevents the taxonomy from re-expanding speculatively.
