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
## Blocker 2 — Sandbox disk — RESOLVED (commit `9aeea0b22`), not a bigger snapshot
**What we thought:** the 10 GB sandbox was too small and we needed a bigger-disk snapshot.

**What it actually was (measured live):**

- A bigger snapshot is **impossible to self-serve** — Daytona caps sandbox disk at **10 GB** (16 GB on enzo); `snapshot.create` with disk>10 returns `400 "exceeds maximum allowed per sandbox"`. Raising it needs a request to [support@daytona.io](mailto:support@daytona.io).
  
- The 10 GB was **never the real shortfall**: a fresh sandbox has the full 10 GB writable (the 2.2 GB base image is read-only overlay layers); a bonaparte shallow clone is only **~0.35 GB**.
  
- **Real cause:** bonaparte uses **pnpm**, which _copies_ its store into `node_modules` on the overlay fs — two full copies (store 4.4 GB + tree 3.8 GB) → ENOSPC during install (huge native dep `react-native-skia`).
  

**Fix (shipped):** force pnpm to **hardlink** so `node_modules` shares the store's inodes. A best-effort post-create step runs `pnpm config set --location=global package-import-method hardlink` in the sandbox (`adapter.ts` → `configureSandboxStorageBestEffort`). A full `pnpm install --frozen-lockfile` then lands at **7.5 GB used / 2.6 GB free** — verified live on a real `enzo-health/bonaparte` clone. No snapshot rebuild, no volume.

**Daytona volumes:** evaluated and **not used** — FUSE/S3-backed (2-5× slower for git + many small files), and unnecessary once the footprint fits 10 GB.

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
1. ✅ **Disk (Blocker 2)** — DONE. pnpm hardlink fix; installs fit 10 GB. (No bigger snapshot — impossible to self-serve.)
  
2. **[you] Neon autosuspend off** — instant; makes create confirm fast (Blocker 1; code half shipped, plus the local-Postgres switch sidesteps it).
  
3. **[me] Agent-launch-into-pane (Blocker 3)** — makes the create-with-prompt flow feel right.
  
4. **[me] Preview header (Blocker 4)** — unblocks web/dev-server workflows.
  

Remaining for daily-usable: **3** (and **4** for web dev). Disk + create reliability are handled.

* * *
## Smaller follow-ups (not blockers)
- "Workspace not found" vs "syncing" distinction (covered by Blocker 1's UX item).
  
- Remote PR-create surfaces duplicate-PR as a raw error toast.
  
- The fs watcher is root-level only (nested gitignored changes aren't seen; any git-status change still triggers a full refresh).
