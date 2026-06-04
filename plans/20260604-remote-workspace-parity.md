# Remote Workspace Feature Parity Plan

Goal: a remote (Daytona) workspace does everything a local (worktree) workspace does in the desktop UI.

## The one root cause

Almost every worktree-bound capability reads/writes the **local worktree fs/git directly** with no `runtime_kind` branch. Remote workspaces have `worktree_path = ""` (sentinel), so those paths fail or no-op.

The fix is uniform and already proven once: `git.getDiff` resolves the live `WorkspaceRuntime` for the workspace and calls a seam method (`runtime.getFileContents`) whose Daytona impl runs the same command **in-sandbox** via `executeCommand`/`fs`. Parity = apply that pattern everywhere:

1. Add the missing methods to the `WorkspaceRuntime` seam (`packages/host-service/src/runtime/seam/`).
2. Implement each in **both** adapters — `LocalWorktreeRuntime` (delegates to today's host fs/git) and `DaytonaWorkspaceRuntime` (sandbox fs API + `executeCommand`).
3. Branch each consumer (tRPC router / manager) on `runtime_kind` through a cached resolver.

Reference pattern (already shipped): `git.ts:401-418` (getDiff remote branch) + `DaytonaWorkspaceRuntime.getFileContents` (in-sandbox `git show`/`cat`).

## What already works for remote (no change)

- Interactive terminal (`/runtime/:ws/pty/:pane` — shipped last session).
- Per-file diff content (`getDiff` → `getFileContents`).
- Workspace create (forks on `runtimeKind`; runs setup/agent/command in-sandbox via `runWorkspaceCommand`).
- Workspace destroy (deletes the Daytona sandbox + releases lease).
- Review tab, PR/issue **read** (octokit + host clone, never the worktree).
- Branch push **machinery** exists (`git.exportAndPushRemote`) — but the UI never calls it.
- Host registration, auth, settings, notifications fan-out, attachments storage (host/cloud-only).

## Dependency-ordered waves

Effort: S≈<½d, M≈½–1d, L≈1–2d, XL≈multi-day/infra.

### Wave 0 — Seam foundation (unblocks all of 1–4)
| Item | Effort |
|---|---|
| `exec(command, cwd?, env?, timeoutMs?) → {stdout,stderr,exitCode}` on seam; Local spawns in worktree, Daytona = `executeCommand` (already used internally). The building block under most git verbs. | M |
| Cache the remote resolver on `ctx` + add `ctx.resolveWorkspaceRuntime(workspaceId)` that branches local/remote, so every router stays one-liner-thin and stops re-importing env per request. | M |
| Shared contract test so every new seam method ships local+Daytona parity (the `*.contract.test.ts` suites already enforce this per facet). | S |

### Wave 1 — Filesystem facet → Files tab + editor parity
Add a `FilesystemFacet` to the seam; Daytona impl uses `sandbox.fs.*` (`listFiles`, `getFileDetails`, `downloadFile`, `uploadFile`, `createFolder`, `deleteFile`, `moveFiles`, `findFiles`) + `executeCommand` (`rg`, `cp`). Branch **both** filesystem stacks (host-service `WorkspaceFilesystemManager` and electron-main `getServiceForWorkspace`) on `runtime_kind`.

| Seam method | Backs | Effort |
|---|---|---|
| `readFile` | open file, v2 editor, image preview | M |
| `writeFile` | CodeEditor save, new file | M |
| `listDir` | Files tree | M |
| `stat` | metadata, terminal-link validation | M |
| `mkdir` / `rm` / `rename` / `copy` | Files tab actions | S each |
| `searchFiles` (glob) | command palette / quick-open | M |
| `searchContent` (ripgrep) | full-text search | M |
| Renderer: FilesTab root = sandbox workdir for remote; gate Reveal-in-Finder / Open-in-Editor (fix the `hostId !== machineId` guard → `runtimeKind`) | M |

### Wave 2 — Git reads + mutations → Changes panel parity
Fixes "Unable to load git status" and every Changes action. Most build on `exec`.

| Seam method | Backs | Effort |
|---|---|---|
| `gitStatus` | the Changes panel (the headline failure) | L |
| `listBranches` / `listCommits` / `getCommitFiles` | selectors, commit filter | S each |
| `getBaseBranch` / `setBaseBranch` | base-branch selector | M |
| `renameBranch` | rename action | M |
| `getBranchSyncStatus` | PR action header | M |
| `stage` / `unstage` | bulk stage/unstage | M |
| `discard` / `discardAll` | discard file / bulk | M |
| Renderer: `useChangesTab`/`ChangesTreeView` runtimeKind-aware (open via relative path; hide host-only actions) | M |

### Wave 3 — Run / presets / ports / preview
| Item | Effort |
|---|---|
| Route `terminal.createSession` + the run/preset launcher through an in-sandbox shell for remote (today `createTerminalSessionInternal` hard-requires `existsSync(worktreePath)`). | L |
| `listPorts` seam (Daytona: `ss -ltnp`/`lsof` in-sandbox) + branch `ports.getAll`/`subscribe`/`kill`; static labels read `.superset/ports.json` in-sandbox. | L |
| Wire the port badge "open in browser" through `exposePreview` (Daytona impl exists, zero callers) → tokenized ingress URL; inject the Daytona preview token header in the webview. | L |

### Wave 4 — PR create / push
| Item | Effort |
|---|---|
| Wire renderer PR flow to the existing `git.exportAndPushRemote` (push branch from sandbox patch via host token) + a host-side `pullRequests.create` (octokit; the scoped token can't open PRs). | L |
| Remote PR-status sync: `getBranchState` seam (branch/headSha/upstream in-sandbox) + a poll trigger (GitWatcher is worktree-bound) so PR badges/links populate. | L |

### Wave 5 — Agents (headline; biggest, has forks)
| Item | Effort | Note |
|---|---|---|
| Custom Daytona image/snapshot preloaded with agent CLIs (claude/codex/opencode/copilot/…) + git/gh + Superset hook scripts; reference from `createInstance`. | XL | **Decision needed.** Stock image is bare TS — agents hit "command not found". Also needs in-sandbox agent **auth**. |
| Inject `SUPERSET_AGENT_HOOK_URL` + terminal/workspace ids into the remote shell env (so lifecycle tracking, "agent alive" state, chimes work) + sandbox egress to the host hook endpoint. | L | |
| Route preset/agent-button launches (currently local-only `terminal.createSession`) through the in-sandbox path. | L | Overlaps Wave 3. |
| Built-in **chat** agent (`superset`): runs the Mastra harness in the host process with `cwd=worktreePath`. Needs a remote execution model — run harness in-sandbox **or** proxy its fs/exec tools through the seam. | XL | **Decision needed.** |
| Remote agent prompt attachments: upload bytes into sandbox + rewrite prompt paths. | M | |

### Wave 6 — Live updates (push events)
| Item | Effort |
|---|---|
| Pragmatic floor: skip the worktree watcher for remote; rely on refetch-on-focus + manual refresh + invalidate-after-mutation. | S |
| Full parity: host-driven poll of `getDiff`/`listDir` (or a sandbox-side watcher) re-emitting `git:changed`/`fs:events` over the existing `/events` WS. | XL |

### Wave 7 — Renderer UX gating polish
Replace implicit `worktreePath`-truthiness gating with explicit `isRemote`: copy-path uses sandbox-absolute path; drag-drop of OS files suppressed or uploaded; "Open in Editor"/"Reveal in Finder" hidden with tooltip; chat `workspacePath` = sandbox cwd. (S–M each.)

## Decisions that need you

1. **Agent CLIs in the sandbox (Wave 5).** Full agent parity requires a custom Daytona image with the CLIs + auth. Build it now, or ship everything-but-in-sandbox-agents first and treat the agent image as a follow-up? (The terminal already lets a user run an agent they install manually.)
2. **Built-in chat remote model (Wave 5).** Run the Mastra harness inside the sandbox, or keep it host-side and route its file/exec tools through the seam?
3. **Live updates (Wave 6).** Ship the polling floor (cheap, slight lag) and defer the true watcher, or build the watcher now?
4. **Sequencing.** Recommended: land Waves 0→1→2 first (Files tab + Changes panel = the bulk of daily-use parity, all low-risk mechanical work on a proven pattern), then 3→4, then the agent/chat XL items. Confirm or reprioritize.

## Risks / notes

- Two filesystem stacks (host-service + electron-main) must both branch — easy to fix one and miss the other.
- `writeFile` optimistic-lock (`ifMatch` via mtime+size) needs a sandbox equivalent (`getFileDetails` before/after); document any weaker guarantee.
- Trash-on-delete and Reveal-in-Finder have no sandbox analog (permanent delete; hide the action).
- Daytona auto-stops idle sandboxes; the activity lease (already implemented) must stay armed during long operations.
