# Remote workspace usability — path to "a person can actually use this"
**Goal:** a user creates a remote workspace, it opens reliably, agents run in the visible pane, and they can view their dev server. Today the parity plumbing exists (PR #1) but four gaps stop it from being daily-usable.

Legend: **[you]** = a setting/ops action only you can do · **[me]** = a code change I can make · size = rough effort.

* * *
## Blocker 1 — Create is unreliable (Electric/Neon txid lag) · **highest priority**
**Symptom:** you create a remote workspace and it either showed "Couldn't create" (now downgraded) or sits as "Workspace not found" until sync catches up. The workspace _is_ created (cloud row + sandbox are durable) — the renderer just can't confirm it.

**Root cause:** the optimistic create waits up to 30s for Electric to stream the new row's txid. Electric reads from Neon over a direct replication connection; when Neon **idle-suspends**, that connection drops and the txid never arrives in time.

**Fix:**

- **[you]** Turn off (or greatly extend) **autosuspend** on the Neon compute Electric connects to. This is the actual cure and takes ~2 minutes in the Neon console. _(Effort: XS)_
  
- **[me]** Give a freshly-created remote workspace an explicit **"provisioning / syncing"** state instead of falling through to "Workspace not found" while the row catches up. _(Effort: S)_
  
- **[me]** Confirm Electric's shape subscription **reconnects** cleanly after a drop (it should; verify + tune backoff if not). _(Effort: S)_
  

Already shipped this round: a txid-timeout after a successful mutation no longer hard-fails or abandons the sandbox, and re-submits can't orphan a sandbox.

* * *
## Blocker 2 — Sandbox disk is too small for real work
**Symptom:** even with the shallow clone, the bonaparte working tree fills the **10 GB** snapshot to ~0 free. `bun install` / builds / agents will hit `No space left on device`.

**Root cause:** `CreateSandboxFromSnapshotParams` can't set disk size — only **image creation** can (`resources.disk`).

**Fix:**

- **[me]** Build a Daytona **image with a bigger disk** (~40–60 GB) carrying the same tooling (Codex/Claude/gh/node), snapshot it, and point `DEFAULT_DAYTONA_SNAPSHOT` / the `DAYTONA_SNAPSHOT` env at it. I can script this with the Daytona SDK. _(Effort: M — mostly a build + verify loop)_
  

Without this, agents can provision but can't actually do work — so this gates the core value.

* * *
## Blocker 3 — Agents launch detached, not in the visible pane
**Symptom:** creating a remote workspace with a prompt runs the agent in a detached shell; you don't see it in the terminal pane.

**Fix:**

- **[me]** Route the create-time agent launch through the same **stash-by-terminalId + attach-replay** path the preset/initial-command flow uses, so it lands in the pane the user is looking at. _(Effort: M)_
  

* * *
## Blocker 4 — In-app preview (dev server) 401s
**Symptom:** opening a sandbox preview URL fails auth.

**Root cause:** Daytona preview links need the `x-daytona-preview-token` header; the webview / system browser don't inject it.

**Fix:**

- **[me]** Inject the preview token header in the webview request path (and decide system-browser behavior — likely a tokenized URL or an in-app-only preview). _(Effort: M)_
  

* * *
## Prerequisite (deployment)
Wherever the desktop app runs, the host-service needs valid Daytona credentials (`DAYTONA_API_KEY`, or `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID`) and a valid snapshot id. Today it reads these from env with a default snapshot. Confirm these are set for any non-dev build. **[you]**

The two uncommitted dev hacks (`apps/api/next.config.ts` Electric proxy, `apps/desktop/src/main/index.ts` CDP port) are local-only and dev-gated — they do **not** need to ship.

* * *
## Recommended sequence
1. **[you] Neon autosuspend off** — instant, makes create work today.
  
2. **[me] Bigger-disk snapshot** — unblocks real agent work (the core value).
  
3. **[me] Agent-launch-into-pane** — makes the create-with-prompt flow feel right.
  
4. **[me] Preview header** — unblocks web/dev-server workflows.
  
5. **[me] Provisioning/syncing UX** — polish on top of #1.
  

A usable MVP is **1 + 2 + 3**. #4 matters for web dev specifically.

* * *
## Smaller follow-ups (not blockers)
- "Workspace not found" vs "syncing" distinction (covered by Blocker 1's UX item).
  
- Remote PR-create surfaces duplicate-PR as a raw error toast.
  
- The fs watcher is root-level only (nested gitignored changes aren't seen; any git-status change still triggers a full refresh).
