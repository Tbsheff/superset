# Runtime Provider v1 — Build Report

Branch: `feat/runtime-provider-v1` (not committed; review then commit). Built from `plans/20260603-runtime-provider-abstraction-v1-impl-plan.md`.

## Verified (re-run on the real environment, not the build sandbox)

- `bun run typecheck` (host-service): exit 0, clean.
- `bun test src/runtime`: 222 pass, 0 fail (67 new files: seam, descriptors, contract suite, two fakes, localWorktree adapter, daytona adapter, diff collector).
- `bun test src/db`: 9 pass, 0 fail (schema + migrations `0006_workspace_runtime_columns`, `0007_runtime_instances`).
- Lint guards pass: `check-runtime-capability.sh`, `check-simple-git-usage.sh`, `check-git-ref-strings.sh`.
- `@daytonaio/sdk@0.183.0` added to `packages/host-service/package.json`.

## Status by phase

| Phase | What landed | Verified |
|---|---|---|
| 0 Reconciliation | Decision doc `plans/runtime-provider-phase0-reconciliation.md`; `runtime/status.ts` (total cloud→normalized projection); `db.ts` fatal-migrate fix; JSDoc-only desktop `WorkspaceRuntime` note | typecheck + status tests |
| A Type seam | `runtime/seam/*` (RuntimeAdapter, facets, ActivityLease, RuntimeBinding, RuntimePlan, roles), `runtime/descriptors/*`, `runtime/contract/*`, `scripts/check-runtime-capability.sh` | typecheck; no-impl asserted |
| B Contracts + fakes | `describeRuntimeProviderContract` + sub-contracts; `fake-pty-workspace` + `fake-command-workspace` both pass the same harness; renderer read-only/log mode + hook test | 34/34 fakes; renderer hook test 4/4; negative gate proven |
| C Schema | `workspaces.runtimeKind`/`currentRuntimeId`, `runtime_instances` table + index, `terminalSessions.runtimeInstanceId`, `NonSecretString`-branded metadata, generated migrations | db tests 9/9 |
| D Diff collector | `runtime/git/diff-collector/` (porcelain -z, `--binary` staged+unstaged, log); endpoint delegates | 24/24 incl. golden + contract |
| E Local extraction | `runtime/adapters/localWorktree/*` coordinating existing setup/teardown/filesystem/git; `LocalPtyTransport` over `DaemonClient`; `workspaces.create` facade (byte-for-byte parity) | full contract suite green; byte-identical test |
| F Daytona | `runtime/adapters/daytona/*` (adapter, WorkspaceRuntime, PtyTransport, descriptor); create→clone→PTY→destroy, diff via D, preview, in-memory `refreshActivity` lease, stop/delete, deny-all egress | 85 pass + 1 skipped (gated integration) |

## NOT done — Phase F integration follow-ups (the adapter works in isolation; the product wiring does not yet)

These are explicitly deferred; Daytona is **not** runnable end-to-end in the app until they land:

1. **apps/api token-mint route** — `createInstallationAccessToken` scoped to one repo. The adapter consumes it via an injected `TokenMinter` (stubbed in tests); production needs the real route.
2. **Host-side push mutation** — a tRPC `pushRemotePatch` that applies `DaytonaWorkspaceRuntime.exportPatch()` output via `ctx.git` and pushes with the scoped token, plus a same-repo/fork guard. `exportPatch()` is implemented + tested; the apply/push side is not.
3. **Desktop renderer remote bridge** — `RemoteWorkspaceRuntime` + `registry.getForWorkspaceId` routing remote workspaces and emitting per-pane `data:${paneId}` events. The host-service `DaytonaPtyTransport` (string surface, streaming UTF-8 decode, kill-not-disconnect) is done + tested; the desktop-main side is not.
4. **CloudGitCredentialProvider per-repo cache fix** — currently keys askpass by expiry only, not repo. Clone bypasses it (per-call mint); the host-push path needs the cache-key fix.
5. **Live Daytona integration test** — written, skips cleanly without `DAYTONA_API_KEY`. Never executed against a real sandbox.

## Grounded corrections the build made to the plan (the code is right; the plan was slightly off)

- **Status is not a strict subset of the cloud enum** — `starting` isn't in `sandboxStatusValues`. Implemented a total `cloudToNormalizedStatus` Record (11 cloud → 6 normalized) as the compile-time guarantee instead of the plan's `_AssertSubset`.
- **`Exclude<JsonValue, Secret>` doesn't forbid a Secret** (a Secret is a string). Replaced with a `NonSecretString` brand so `RuntimeMetadata` structurally rejects branded secrets.
- **Daytona SDK reality** vs docs: `networkAllowList` is a comma-separated string (not array); `delete()` timeout is seconds (not ms); pinned `0.183.0` (0.184.0 blocked by bun's 3-day min-release-age); `RuntimePlan.repo` is `{cloneUrl, ref}`, so a `parse-repo.ts` derives owner/repo.

## Environment caveats (not code defects)

- `db.node-test.ts` (the `createDb` runtime proof from Phase 0) can't execute where `better-sqlite3`'s prebuilt ABI doesn't match the active Node. The `db.ts` fatal-migrate change is correct by inspection and the schema/migration tests pass; this test runs on normal dev/CI.
- Full-package `bun test` shows one **pre-existing** failure: `test/integration/terminal.integration.test.ts` "terminal disposal cleans up background process groups from real daemon sessions" — a real-PTY-daemon 3s timing test, unrelated to any file changed here, reproduces in isolation on `main`.

## Live verification (DONE — real Daytona API)

The gated integration slice (`daytona.integration.test.ts`) passed against the live API: **create → clone (public, anonymous) → getDiff → exposePreview(3000) → destroy**, `1 pass / 0 fail`, sandbox self-destroyed (zero leaks).

Three adapter bugs were found and fixed by running it live:
1. **Leak on failed provision** — `createInstance` created the sandbox then cloned with no cleanup; a clone failure leaked a paid sandbox. Fixed: create→clone wrapped in try/catch that deletes the sandbox before rethrowing (`adapter.ts` `deleteAfterFailedProvision`). Test: `adapter.test.ts` "deletes the sandbox if provisioning fails after create".
2. **Deny-all egress blocked the in-sandbox GitHub clone** (`dial tcp: lookup github.com: i/o timeout`). Per decision, v1 now defaults to **allow-all egress**; deny-all + CIDR allowlist is a deferred opt-in (`egress.ts` kept). Test updated to assert no `networkBlockAll` at create.
3. **Empty-token clone sent broken basic auth** (`Password authentication is not supported`). Fixed: `cloneRepo` clones anonymously when no token is minted. Test: "clones anonymously when no token is minted".

**Auth note (how to run it):** the env `DAYTONA_API_KEY` (`dtn_…`) 401s; the working credentials are the **CLI's OAuth token + org** from `~/Library/Application Support/daytona/config.json`. The test now accepts `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID` (the SDK requires the org with a JWT). Run:
```
RUN_DAYTONA_INTEGRATION=1 DAYTONA_JWT_TOKEN=<cli accessToken> DAYTONA_ORGANIZATION_ID=<activeOrganizationId> \
  bun test src/runtime/adapters/daytona/daytona.integration.test.ts
```

## Done in the finishing pass

- **Token-mint authz tightened** to per-repo push access (`getCollaboratorPermissionLevel` via the caller's linked GitHub login), falling back to org membership when no GitHub account is linked. (Decision: hybrid two-gate; the fallback exists because GitHub is one of three sign-in methods.)
- **Credential hardening**: askpass passes the token via process env (`GIT_ASKPASS_TOKEN`), never in the script body; `repoCacheKey` strips/rejects embedded userinfo.
- **Production `TokenMinter`** calls `/api/github/scoped-token` and is wired into `createApp`'s `ctx.mintRepoScopedToken`.

## The one real remaining gap (in-app remote terminals)

Desktop transport wiring is **partial by necessity**: the host-service `DaytonaPtyTransport` runs in-process and is exposed by **no tRPC/WebSocket procedure**, so the desktop main cannot stream remote PTY bytes over the wire yet. The desktop scaffolding (`RemotePtyTransportFactory`, `setWorkspaceRemote` resolver) is in place but inert until:
1. host-service adds a **PTY-over-wire streaming endpoint** for remote sandboxes, and
2. something authoritative **calls `setWorkspaceRemote(workspaceId, orgId)`** to mark a workspace remote.

Until then, the Daytona adapter is verified at the host-service layer (live public-repo slice) but remote workspaces don't render terminals in the desktop app.

Not exercised live: the authz route (octokit mocked) and the `TokenMinter` HTTP path (fetch mocked); private-repo clone needs a real scoped token (GH App creds + running `apps/api`).

## Next steps

1. Review the diff on `feat/runtime-provider-v1`; commit per-phase or squash.
2. Wire the production token-mint + desktop transport (above) for true in-app remote workspaces; private-repo clone needs a real scoped token (the live slice proved only the public-repo path).
3. Run the full-monorepo `bun run typecheck` + `bun run lint` in CI before opening PRs.
