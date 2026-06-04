# Remote (Daytona) Workspaces — Remaining Work Punch List

## Honest status

Today nothing works end-to-end for remote workspaces; only **local** workspaces are fully functional. The Daytona pieces that exist are mature and independently verified: `DaytonaRuntimeAdapter` (create/reconnect/getStatus/destroy), `DaytonaWorkspaceRuntime` (startShell, getDiff, exportPatch, activityLease), `DaytonaPtyTransport`, the `DaytonaActivityLease` heartbeat, the scoped-token route at `apps/api/.../github/scoped-token/route.ts`, the `createRepoScopedTokenMinter` wired into host-service `ctx.mintRepoScopedToken`, schema migrations 0006/0007 (`workspaces.runtimeKind`, `workspaces.currentRuntimeId`, `runtime_instances`), and the entire desktop remote scaffold (`RemoteWorkspaceRuntime`, `RemotePtyTransportFactory`, `HostServiceRemoteTransport`, `setWorkspaceRemote`, `resolveWorkspaceRuntimeKind`, the WebSocket channel decoder, registry wiring). All of it is **disconnected from product entry points**: `getRuntimeAdapter` only knows `"local"` and throws otherwise; `workspaces.create` hardcodes `getRuntimeAdapter("local")`; the Daytona SDK and a real `DaytonaInstanceStore` are never injected; `runtime_instances` has zero production reads/writes; host-service exposes no `/runtime/*` PTY endpoint; `git.getDiff`/`pushRemotePatch` require a local `worktreePath` that remote workspaces don't have; no creation UI offers a runtime choice; and nothing ever calls `setWorkspaceRemote` so the desktop always routes to the local runtime. The adapter has only been proven against a **public** repo; private-repo cloning and live GitHub-App-credential auth are unverified.

## Milestone 1 — one remote workspace usable end-to-end

Strictly dependency-ordered. The chain is: persist a real runtime row → route creation to Daytona → mark the workspace remote → stream PTY → diff/push. Each step is dead until its predecessors land.

1. **Production `DaytonaInstanceStore` over `runtime_instances`** — implement the `insert/setPreviewUrl/markDestroyed/get` interface (`packages/host-service/src/runtime/adapters/daytona/types.ts:55`) against the real `runtime_instances` table; today only `FakeInstanceStore` (`test-support/fake-sandbox.ts`) exists and there are **zero** production reads/writes to the table. **Why it blocks:** the adapter's `persistInstance` (`adapter.ts:83`) calls `store.insert`, so without this every remote create either no-ops its state or crashes. **Effort: M. Deps: none.**

2. **Daytona SDK factory + env/credential selection** — instantiate the real Daytona SDK and add credential resolution in `packages/host-service/src/env.ts`; the adapter is DI-only (`deps.sdk`, `adapter.ts:50`) and is never constructed in production. **Why it blocks:** no SDK means no sandbox can ever be created. **Effort: M. Deps: none (parallel with #1).**

3. **Add `"remote"` to the registry and instantiate `DaytonaRuntimeAdapter`** — extend `RuntimeKind` (`packages/host-service/src/runtime/registry/registry.ts:13`, currently `= "local"`) and add a `"remote"` branch in `getRuntimeAdapter` (`registry.ts:28-48`, currently throws) that builds the adapter with `{ sdk, store, mintRepoScopedToken }`. **Why it blocks:** every routing decision (`create`, cleanup, reconnect) goes through this one selector; until it knows `"remote"`, no flow can reach Daytona. **Effort: M. Deps: #1, #2.**

4. **`runtimeKind` input on the creation schemas** — add a `runtimeKind: "local" | "remote"` field to `createInputSchema` (`packages/host-service/.../workspaces/workspaces.ts:64-90`) and to `v2Workspace.create` input (`packages/trpc/.../v2-workspace.ts:189-200`, plus persist `provider`/`role` on the inserted row). **Why it blocks:** the client cannot express "remote" and the cloud row never records it. **Effort: S. Deps: none (parallel with #1–#3, but consumed by #5).**

5. **Route `workspaces.create` to the selected runtime + persist `runtimeKind`** — replace the hardcoded `getRuntimeAdapter("local", …)` (`workspaces.ts:1053`) with `getRuntimeAdapter(input.runtimeKind, …)`; set `workspaces.runtimeKind` explicitly in `persistLocalWorkspace`/`adopt-existing-worktree.ts` instead of relying on the column default; thread `runtimeKind` through `adoptExistingWorktree`/`registerCloudAndLocal`. **Why it blocks:** this is the single switch that decides local vs. Daytona at create time. **Effort: M. Deps: #3, #4.**

6. **Mark the workspace remote after provision** — after `createInstance` succeeds for a remote workspace, set `workspaces.runtimeKind = "remote"` and `workspaces.currentRuntimeId = instance.id` (host-side, in/after the `create` path). **Why it blocks:** the FK from workspace to its live runtime instance is what every later lookup (PTY endpoint, diff, cleanup) keys on. **Effort: S. Deps: #5.**

7. **Host-service `/runtime/{workspaceId}/pty/{paneId}` WebSocket endpoint** — register a new route in `app.ts` (today only `/terminal/*` and `/events` exist, lines 173–174) that looks up `workspace.currentRuntimeId`, resolves the live `DaytonaPtyTransport`, streams PTY output as binary frames and control as JSON, and consumes `{input|resize|kill}`; apply `wsAuth` to `/runtime/*`; pin the message protocol the desktop already expects (`{attached|exit|error}` out, `{input|resize|kill}` in). **Why it blocks:** the desktop `HostServiceRemoteTransport.start()` connects to this exact path; without it every remote terminal fails with a connection error. **Effort: L. Deps: #6.**

8. **Desktop: sync `runtimeKind` and call `setWorkspaceRemote`** — read `runtimeKind` from the existing `getWorkspace` tRPC result and call `setWorkspaceRemote(workspaceId, organizationId)` (`apps/desktop/src/main/lib/workspace-runtime/binding/workspaceRuntimeBindingStore.ts:43`) so `resolveWorkspaceRuntimeKind` returns `"remote"`. The binding store, resolver, factory, and registry wiring are already built and unit-tested but have **no production caller**. **Why it blocks:** until this runs, the desktop registry always routes to `LocalWorkspaceRuntime`, so even a working endpoint is never used. **Effort: S–M. Deps: #6 (server must report remote); pairs with #7 to make terminals live.**

9. **Runtime selector UI in both creation flows** — add a local/remote toggle to the desktop `NewWorkspaceModal` (`PromptGroup.tsx` + the `new-workspace-modal` draft schema) and to the web workspaces page form (`apps/web/src/app/workspaces/page.tsx:210-261`), wiring the value to `runtimeKind`. **Why it blocks:** without it a user cannot choose remote at all; the only way to exercise the path otherwise is a raw API call. **Effort: M (×2 surfaces). Deps: #4.**

10. **Remote-aware `getDiff`** — make `git.getDiff` (`packages/host-service/.../git/git.ts:67`) detect `runtimeKind === "remote"` and call `runtime.getDiff()` instead of `resolveWorktreePath`, which throws NOT_FOUND for remote workspaces (null `worktreePath`). **Why it blocks:** the Changes view shows nothing for a remote workspace without it. **Effort: M. Deps: #6, plus a runtime resolver that loads `DaytonaWorkspaceRuntime` from `currentRuntimeId`.**

11. **Remote export-and-push pipeline** — add a host-side flow that calls `DaytonaWorkspaceRuntime.exportPatch()` and feeds it to the existing `pushRemotePatch` mutation, and fix `pushRemotePatch` (`git.ts:695-703`) which currently throws NOT_FOUND when `!workspace.worktreePath`; expose a desktop tRPC procedure to drive it; gate the desktop Changes/PR UI on `runtimeKind` so remote workspaces use this path instead of `getSimpleGitWithShellPath(worktreePath)` (`apps/desktop/src/lib/trpc/routers/changes/git-operations.ts:191-288`, which fails with no local worktree). **Why it blocks:** a user cannot get code out of a remote workspace (push/PR) without it — the final link in create→use→ship. **Effort: L. Deps: #6, #10.**

12. **Start the activity lease on session attach** — call `runtime.activityLease()` (`DaytonaWorkspaceRuntime.ts:161`, never invoked outside tests) when a remote session attaches. **Why it blocks (soft):** the sandbox sets `autoStopInterval: 15` (`adapter.ts:53`); without the 60s keep-alive heartbeat the sandbox auto-stops mid-session, so a "usable" remote workspace dies after 15 idle minutes. **Effort: M. Deps: #7 (attach happens at PTY connect).**

13. **Remote workspace delete calls `adapter.destroy()`** — wire `workspace-cleanup.ts` to resolve the remote adapter and call `destroy(externalId, {kind:"delete"})` (today the 5-phase cleanup has zero `destroy` calls; `markDestroyed`/lease release never run for remote). **Why it blocks (cost/correctness):** without it, deleting a workspace leaves a paid Daytona sandbox and leaked lease timer running indefinitely — completing the create→cleanup loop. **Effort: M. Deps: #3, #6.**

## Milestone 2 — parity & hardening

- **Startup reconnect sweep for remote runtimes** — `main-workspace-sweep.ts` (run from `app.ts:156`) only handles local; query `runtime_instances` and call `DaytonaRuntimeAdapter.reconnect()` on restart, else every active sandbox is orphaned in memory after a host restart. **Effort: M.**
- **Status polling endpoint** — expose `getStatus()` (`adapter.ts:145`) via a tRPC query so clients can show provisioning/ready/stopped. **Effort: M.**
- **Cross-device state + cloud reconciliation** — `runtime_instances` is host-local SQLite, excluded from Electric sync, write-only with no read DTOs/queries; add a host→cloud uplink to record runtime status and a bridge between `cloudWorkspaceConfig` and `runtime_instances` so other devices see remote state. **Effort: L.**
- **Lease durability** — persist `lastActivityAt`/lease state to DB so a host crash doesn't drop the heartbeat and auto-stop the sandbox; release lease resources on delete, not only `stop()`. **Effort: M.**
- **TTL enforcement / GC** — sweeper to refresh `ttlExpiresAt` and garbage-collect expired `previewUrl`/`runtime_instances` rows. **Effort: M.**
- **Graceful degradation** — handle a workspace whose `currentRuntimeId` points at a destroyed instance (revert to a safe state or offer re-provision). **Effort: M.**
- **`CloudGitCredentialProvider` cache key fix** — key the askpass cache by repo, not expiry only (deferred follow-up #4), or private-repo clones reuse the wrong token. **Effort: M.**
- **Live verification with GitHub App creds against a private repo** — the adapter is only proven against a public repo; validate the scoped-token mint → private clone → diff → push round trip live. **Effort: M.**
- **UI polish** — remote provisioning/connecting states, preview-URL surfacing, and clear errors when a sandbox is stopped or destroyed. **Effort: M.**

## Not needed for v1

- Deny-all egress + CIDR allowlist (Daytona egress is IPv4-CIDR-only and tier-gated; allow-all is the documented v1 default in `adapter.ts`).
- `listRuntimeInstances(workspaceId)` history / re-attach to past sandboxes UI.
- Any cloud↔host reconciliation bridge beyond what Milestone 2 requires for visibility.
- Multi-runtime providers beyond Daytona (the registry seam supports them, but none are in scope).

## Effort rollup

| Milestone | S | M | L | Total |
|---|---|---|---|---|
| Milestone 1 | 3 (items 4, 6, 8) | 6 (1, 2, 3, 5, 10, 12, 13 → counting 8 as S/M leaning M) | 3 (7, 11, plus 9 as M×2) | 13 |
| Milestone 2 | 0 | 7 | 1 | 8 |

Milestone 1 detail (13 items): **S = 3** (4 `runtimeKind` schema, 6 mark-remote, 8 desktop sync/setWorkspaceRemote), **M = 8** (1 store, 2 SDK/env, 3 registry, 5 create routing, 9 selector UI ×2 counted as one M-class line, 10 remote getDiff, 12 lease attach, 13 delete destroy), **L = 2** (7 PTY endpoint, 11 export-and-push pipeline).
Milestone 2 (8 items): **M = 7**, **L = 1** (cross-device state + cloud reconciliation).
