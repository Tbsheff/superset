import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { promisify } from "node:util";
import type { FsWatchEvent } from "@superset/workspace-fs/host";
import type { HostDb } from "../db/index.ts";
import { workspaces } from "../db/schema.ts";
import type { WorkspaceFilesystemManager } from "../runtime/filesystem/index.ts";
import {
	type RemoteRuntimeResolverLike,
	RemoteWatchPoller,
} from "./remote-watch-poller.ts";

const execFileAsync = promisify(execFile);

const RESCAN_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 300;

export interface GitChangedEvent {
	workspaceId: string;
	/**
	 * Worktree-relative paths that changed when the batch was worktree-only.
	 * Absent when the batch included any `.git/*` activity, signaling a broad
	 * state change (commit, staging, branch switch, fetch, etc.).
	 */
	paths?: string[];
}

export type GitChangedListener = (event: GitChangedEvent) => void;

export interface FsChangedEvent {
	workspaceId: string;
}

export type FsChangedListener = (event: FsChangedEvent) => void;

export interface GitWatcherOptions {
	/**
	 * Resolves the live `WorkspaceRuntime` for a remote workspace, used by the
	 * remote poller. Omitted on local-only hosts (no Daytona), which disables
	 * remote polling entirely. `app.ts` passes the same resolver it wires into
	 * the filesystem/pull-request managers.
	 */
	resolveRemoteRuntime?: () => Promise<RemoteRuntimeResolverLike>;
	/** Remote poll cadence. Defaults to the poller's own default; tests shorten it. */
	remotePollIntervalMs?: number;
}

interface PendingBatch {
	/** Any `.git/*` event seen during this debounce window. */
	hasGitDir: boolean;
	/** Worktree-relative paths accumulated during this debounce window. */
	paths: Set<string>;
}

interface WatchedWorkspace {
	workspaceId: string;
	worktreePath: string;
	gitDir: string;
	watcher: FSWatcher;
	disposeWorktreeWatch: () => void;
}

/**
 * Watches git state for all workspaces in the host-service DB and emits a
 * coalesced `changed` signal when anything that could affect `git status`
 * output happens. Auto-discovers new workspaces and drops removed ones every
 * 30s.
 *
 * Two sources feed into the same debounced emit per workspace:
 *
 * 1. `.git/` directory (via `node:fs.watch`) — catches commits, staging,
 *    branch switches, fetches — anything that writes git metadata, including
 *    operations from an external terminal.
 * 2. Worktree root (via `@superset/workspace-fs` watcher manager) — catches
 *    working-tree file edits that change `git status` output. The underlying
 *    watcher honors `DEFAULT_IGNORE_PATTERNS`, which excludes `.git/`,
 *    `node_modules/`, `dist/`, etc. — exactly the paths that don't affect
 *    `git status`, so we don't waste refetches on them. Subscription is
 *    multiplexed by `FsWatcherManager` per absolute path, so this shares the
 *    underlying native watcher with any client-owned `fs:watch` subscriptions.
 *
 * Consumers therefore only need to subscribe to `git:changed` for refetch
 * purposes — no separate client-side debounce over `fs:events`.
 *
 * Remote workspaces (`runtime_kind === 'remote'`) have no host-side worktree or
 * `.git/` to watch, so the two local sources above are skipped for them. A
 * `RemoteWatchPoller` instead polls the live runtime on an interval and emits
 * the same `git:changed` (via `onChanged`) plus a coarse `fs:events`-style
 * signal (via `onFsChanged`) when cheap signatures diverge. Polling only runs
 * while a workspace is actively observed (`observeRemote`) so idle sandboxes are
 * never woken when no `/events` client is connected.
 */
export class GitWatcher {
	private readonly db: HostDb;
	private readonly filesystem: WorkspaceFilesystemManager;
	private readonly listeners = new Set<GitChangedListener>();
	private readonly fsListeners = new Set<FsChangedListener>();
	private readonly watched = new Map<string, WatchedWorkspace>();
	private readonly debounceTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly pendingBatches = new Map<string, PendingBatch>();
	private rescanTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private readonly remotePoller: RemoteWatchPoller | null;
	/** Remote workspace ids the latest rescan saw. Bounds `observeRemote`. */
	private readonly remoteWorkspaceIds = new Set<string>();
	/** Remote ids currently requested as observed by connected clients. */
	private readonly observedRemoteIds = new Set<string>();

	constructor(
		db: HostDb,
		filesystem: WorkspaceFilesystemManager,
		options: GitWatcherOptions = {},
	) {
		this.db = db;
		this.filesystem = filesystem;
		this.remotePoller = options.resolveRemoteRuntime
			? new RemoteWatchPoller({
					resolveRuntime: options.resolveRemoteRuntime,
					emit: {
						gitChanged: (workspaceId) => this.emitGitChanged({ workspaceId }),
						fsChanged: (workspaceId) => this.emitFsChanged({ workspaceId }),
					},
					...(options.remotePollIntervalMs !== undefined
						? { intervalMs: options.remotePollIntervalMs }
						: {}),
				})
			: null;
	}

	start(): void {
		void this.rescan();
		this.rescanTimer = setInterval(
			() => void this.rescan(),
			RESCAN_INTERVAL_MS,
		);
	}

	onChanged(listener: GitChangedListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Subscribe to coarse remote fs-change signals. The EventBus broadcasts these
	 * as an `fs:events` overflow so the renderer's Files tree does a full refresh.
	 * Only the remote poller emits here; local fs activity rides `git:changed`.
	 */
	onFsChanged(listener: FsChangedListener): () => void {
		this.fsListeners.add(listener);
		return () => {
			this.fsListeners.delete(listener);
		};
	}

	/**
	 * Begin polling a remote workspace while a client observes it. No-op for
	 * unknown ids, non-remote ids, or when no remote resolver is configured —
	 * keeps polling bounded to known remote rows that someone is watching.
	 */
	observeRemote(workspaceId: string): void {
		if (this.closed || !this.remotePoller) return;
		this.observedRemoteIds.add(workspaceId);
		if (this.remoteWorkspaceIds.has(workspaceId)) {
			this.remotePoller.observe(workspaceId);
		}
	}

	/** Stop polling a remote workspace once no client observes it. */
	unobserveRemote(workspaceId: string): void {
		this.observedRemoteIds.delete(workspaceId);
		this.remotePoller?.unobserve(workspaceId);
	}

	close(): void {
		this.closed = true;
		if (this.rescanTimer) {
			clearInterval(this.rescanTimer);
			this.rescanTimer = null;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this.pendingBatches.clear();
		for (const entry of this.watched.values()) {
			entry.watcher.close();
			entry.disposeWorktreeWatch();
		}
		this.watched.clear();
		this.remotePoller?.close();
		this.remoteWorkspaceIds.clear();
		this.observedRemoteIds.clear();
	}

	private getOrCreateBatch(workspaceId: string): PendingBatch {
		let batch = this.pendingBatches.get(workspaceId);
		if (!batch) {
			batch = { hasGitDir: false, paths: new Set() };
			this.pendingBatches.set(workspaceId, batch);
		}
		return batch;
	}

	private markGitDirDirty(workspaceId: string): void {
		this.getOrCreateBatch(workspaceId).hasGitDir = true;
		this.scheduleFlush(workspaceId);
	}

	private addWorktreePaths(workspaceId: string, paths: Iterable<string>): void {
		const batch = this.getOrCreateBatch(workspaceId);
		for (const path of paths) {
			if (path) batch.paths.add(path);
		}
		this.scheduleFlush(workspaceId);
	}

	private scheduleFlush(workspaceId: string): void {
		const existing = this.debounceTimers.get(workspaceId);
		if (existing) clearTimeout(existing);
		this.debounceTimers.set(
			workspaceId,
			setTimeout(() => {
				this.debounceTimers.delete(workspaceId);
				const batch = this.pendingBatches.get(workspaceId);
				this.pendingBatches.delete(workspaceId);
				if (!batch) return;
				const event: GitChangedEvent =
					batch.hasGitDir || batch.paths.size === 0
						? { workspaceId }
						: { workspaceId, paths: [...batch.paths] };
				this.emitGitChanged(event);
			}, DEBOUNCE_MS),
		);
	}

	private emitGitChanged(event: GitChangedEvent): void {
		for (const listener of this.listeners) {
			// Isolate per-listener throws so one bad subscriber can't skip siblings.
			// Other escapes fall through to the process-level net.
			try {
				listener(event);
			} catch (error) {
				console.error("[git-watcher:listener] threw — contained", { error });
			}
		}
	}

	private emitFsChanged(event: FsChangedEvent): void {
		for (const listener of this.fsListeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("[git-watcher:fs-listener] threw — contained", { error });
			}
		}
	}

	private async rescan(): Promise<void> {
		if (this.closed) return;

		let rows: Array<{
			id: string;
			worktreePath: string;
			runtimeKind: string;
		}>;
		try {
			rows = this.db
				.select({
					id: workspaces.id,
					worktreePath: workspaces.worktreePath,
					runtimeKind: workspaces.runtimeKind,
				})
				.from(workspaces)
				.all();
		} catch {
			return;
		}

		const currentIds = new Set(rows.map((r) => r.id));

		// Remove watchers for workspaces that no longer exist
		for (const [id, entry] of this.watched) {
			if (!currentIds.has(id)) {
				entry.watcher.close();
				entry.disposeWorktreeWatch();
				this.watched.delete(id);
			}
		}

		this.reconcileRemote(rows);

		// Add watchers for new LOCAL workspaces. Remote rows have no host-side
		// worktree (`worktreePath === ""`) or `.git/` to watch — `git rev-parse`
		// in `watchWorkspace` would run against `''` and skip every cycle — so they
		// are handled by the remote poller instead.
		for (const row of rows) {
			if (row.runtimeKind === "remote") continue;
			if (this.watched.has(row.id)) continue;
			await this.watchWorkspace(row.id, row.worktreePath);
		}
	}

	/**
	 * Sync `remoteWorkspaceIds` to the latest rows and (re)start polling for any
	 * remote workspace a client is observing. Dropping a row stops its poll.
	 */
	private reconcileRemote(
		rows: Array<{ id: string; runtimeKind: string }>,
	): void {
		if (!this.remotePoller) return;
		const nextRemoteIds = new Set(
			rows.filter((r) => r.runtimeKind === "remote").map((r) => r.id),
		);

		for (const id of this.remoteWorkspaceIds) {
			if (!nextRemoteIds.has(id)) this.remotePoller.unobserve(id);
		}
		this.remoteWorkspaceIds.clear();
		for (const id of nextRemoteIds) {
			this.remoteWorkspaceIds.add(id);
			if (this.observedRemoteIds.has(id)) this.remotePoller.observe(id);
		}
	}

	private async watchWorkspace(
		workspaceId: string,
		worktreePath: string,
	): Promise<void> {
		if (this.closed) return;

		let gitDir: string;
		try {
			const { stdout } = await execFileAsync(
				"git",
				["rev-parse", "--git-dir"],
				{ cwd: worktreePath },
			);
			gitDir = stdout.trim();
			// If relative, resolve against worktree path
			if (!gitDir.startsWith("/")) {
				gitDir = `${worktreePath}/${gitDir}`;
			}
		} catch {
			// Not a git repo or path doesn't exist — skip
			return;
		}

		if (this.closed || this.watched.has(workspaceId)) return;

		// Start the worktree watch first so we have a dispose handle to capture
		// in the .git watcher's error handler closure. This avoids a race where
		// the error handler could fire before `this.watched.set(...)` runs.
		const disposeWorktreeWatch = this.startWorktreeWatch(
			workspaceId,
			worktreePath,
		);

		let watcher: FSWatcher;
		try {
			watcher = watch(gitDir, { recursive: true }, () => {
				this.markGitDirDirty(workspaceId);
			});
		} catch {
			// fs.watch failed (e.g. directory doesn't exist)
			disposeWorktreeWatch();
			return;
		}

		watcher.on("error", () => {
			// Watcher died — clean up so rescan can re-add
			disposeWorktreeWatch();
			this.watched.delete(workspaceId);
			watcher.close();
		});

		this.watched.set(workspaceId, {
			workspaceId,
			worktreePath,
			gitDir,
			watcher,
			disposeWorktreeWatch,
		});
	}

	/**
	 * Subscribe to worktree fs events via the shared workspace-fs watcher
	 * manager. Each batch of events feeds into the debounced flush, contributing
	 * worktree-relative paths that get carried in the emitted `git:changed`
	 * event. Bursts collapse into a single event per workspace per debounce
	 * window.
	 */
	private startWorktreeWatch(
		workspaceId: string,
		worktreePath: string,
	): () => void {
		let disposed = false;
		let iterator: AsyncIterator<{ events: FsWatchEvent[] }> | null = null;

		try {
			const service = this.filesystem.getServiceForWorkspace(workspaceId);
			const stream = service.watchPath({
				absolutePath: worktreePath,
				recursive: true,
			});
			iterator = stream[Symbol.asyncIterator]();
		} catch (error) {
			console.error("[git-watcher] failed to start worktree watch:", {
				workspaceId,
				error,
			});
			return () => {};
		}

		const worktreePrefix = worktreePath.endsWith("/")
			? worktreePath
			: `${worktreePath}/`;

		const toRelative = (absolutePath: string): string | null => {
			if (absolutePath === worktreePath) return null;
			if (!absolutePath.startsWith(worktreePrefix)) return null;
			const relative = absolutePath.slice(worktreePrefix.length);
			// Defensive: ignore anything inside .git/ — the dedicated .git watcher
			// handles those and the worktree fs watcher's default ignore patterns
			// already exclude it, but a rare leak shouldn't pollute the paths list.
			if (relative === ".git" || relative.startsWith(".git/")) return null;
			return relative;
		};

		void (async () => {
			try {
				while (!disposed && iterator) {
					const next = await iterator.next();
					if (disposed || next.done) return;

					const relativePaths: string[] = [];
					for (const event of next.value.events) {
						const rel = toRelative(event.absolutePath);
						if (rel) relativePaths.push(rel);
						if (event.oldAbsolutePath) {
							const oldRel = toRelative(event.oldAbsolutePath);
							if (oldRel) relativePaths.push(oldRel);
						}
					}

					if (relativePaths.length > 0) {
						this.addWorktreePaths(workspaceId, relativePaths);
					} else {
						this.getOrCreateBatch(workspaceId);
						this.scheduleFlush(workspaceId);
					}
				}
			} catch (error) {
				if (!disposed) {
					console.error("[git-watcher] worktree watch stream failed:", {
						workspaceId,
						error,
					});
				}
			}
		})();

		return () => {
			disposed = true;
			void iterator?.return?.().catch(() => {});
			iterator = null;
		};
	}
}
