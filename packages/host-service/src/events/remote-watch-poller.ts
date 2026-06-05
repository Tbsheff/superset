import type { WorkspaceRuntime } from "../runtime/seam/index.ts";

/**
 * Resolves the live `WorkspaceRuntime` for a remote workspace. Mirrors the
 * `RemoteRuntimeResolver` seam `app.ts` already builds (`getRemoteRuntimeResolver`)
 * so the watcher reconnects the same Daytona sandbox the exec/diff/fs paths use.
 * Kept narrow (one method) so unit tests inject a fake without the registry.
 */
export interface RemoteRuntimeResolverLike {
	resolve(workspaceId: string): Promise<WorkspaceRuntime>;
}

export interface RemoteWatchEmit {
	/** Broad git-state change for a workspace (no path list). */
	gitChanged(workspaceId: string): void;
	/** Coarse fs change for a workspace; renderer does a full tree refresh. */
	fsChanged(workspaceId: string): void;
}

export interface RemoteWatchPollerOptions {
	resolveRuntime: () => Promise<RemoteRuntimeResolverLike>;
	emit: RemoteWatchEmit;
	/** Poll cadence per remote workspace. Defaults to 4s. */
	intervalMs?: number;
	/**
	 * Resolves the sandbox-relative repo root (clone dir) to list for the fs
	 * signature, per workspace — the repo name differs across workspaces. Defaults
	 * to {@link DEFAULT_WORKDIR}.
	 */
	resolveWorkdir?: (workspaceId: string) => string;
}

const DEFAULT_INTERVAL_MS = 4_000;
const DEFAULT_WORKDIR = "workspace";

interface WorkspacePoll {
	timer: ReturnType<typeof setInterval>;
	gitSignature: string | null;
	fsSignature: string | null;
	/** Guards against overlapping ticks when a sandbox round-trip runs long. */
	inFlight: boolean;
}

/**
 * Per-remote-workspace poller that gives the renderer the same `git:changed` and
 * `fs:events` liveness it gets locally from `@parcel/watcher` + the `.git/`
 * watcher. Remote workspaces have no host-side worktree to watch, so on an
 * interval we resolve the live runtime and compare cheap signatures:
 *
 *   - git: `getDiff().statusPorcelain` (already remote-aware) — emits a broad
 *     `git:changed` (no paths) when the hash changes, exactly what
 *     `useGitStatus` invalidates on.
 *   - fs:  a SHALLOW listing of the repo root via `runtimeFs().listFiles` —
 *     emits a coarse fs signal when the root listing changes.
 *
 * fs liveness scope (v1): root-level only. Top-level file/dir create, delete,
 * and rename are detected; edits to files nested inside subdirectories are NOT
 * seen by the listing signature, but most of those also move `git status`
 * (tracked edits, untracked `??` entries), so the git poll covers them. Changes
 * to gitignored files inside subdirectories are the known blind spot. The
 * renderer treats the emitted signal as a full-tree refresh, so a single change
 * anywhere visible reconciles the whole tree.
 *
 * Polling is gated by the caller (`observe`/`unobserve`) so idle sandboxes are
 * never woken when no `/events` client is connected.
 */
export class RemoteWatchPoller {
	private readonly resolveRuntime: () => Promise<RemoteRuntimeResolverLike>;
	private readonly emit: RemoteWatchEmit;
	private readonly intervalMs: number;
	private readonly resolveWorkdir: (workspaceId: string) => string;
	private readonly polls = new Map<string, WorkspacePoll>();
	private closed = false;

	constructor(options: RemoteWatchPollerOptions) {
		this.resolveRuntime = options.resolveRuntime;
		this.emit = options.emit;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.resolveWorkdir = options.resolveWorkdir ?? (() => DEFAULT_WORKDIR);
	}

	/** Begin polling a remote workspace. No-op if already polling or closed. */
	observe(workspaceId: string): void {
		if (this.closed || this.polls.has(workspaceId)) return;
		const poll: WorkspacePoll = {
			timer: setInterval(() => {
				void this.tick(workspaceId);
			}, this.intervalMs),
			gitSignature: null,
			fsSignature: null,
			inFlight: false,
		};
		this.polls.set(workspaceId, poll);
		// Prime immediately so the first divergence after connect is caught fast
		// rather than one interval late.
		void this.tick(workspaceId);
	}

	/** Stop polling a workspace and clear its timer. */
	unobserve(workspaceId: string): void {
		const poll = this.polls.get(workspaceId);
		if (!poll) return;
		clearInterval(poll.timer);
		this.polls.delete(workspaceId);
	}

	/** Drop every poll. Idempotent. */
	close(): void {
		this.closed = true;
		for (const poll of this.polls.values()) {
			clearInterval(poll.timer);
		}
		this.polls.clear();
	}

	private async tick(workspaceId: string): Promise<void> {
		const poll = this.polls.get(workspaceId);
		if (!poll || poll.inFlight) return;
		poll.inFlight = true;
		try {
			const resolver = await this.resolveRuntime();
			const runtime = await resolver.resolve(workspaceId);
			// The workspace may have been unobserved while the resolve awaited.
			if (!this.polls.has(workspaceId)) return;

			await Promise.all([
				this.pollGit(workspaceId, runtime),
				this.pollFs(workspaceId, runtime),
			]);
		} catch {
			// Sandbox not live / transient round-trip failure. Swallow: the next
			// tick retries, and a dead workspace is dropped via `unobserve` from
			// the EventBus when its row disappears or all clients leave.
		} finally {
			const current = this.polls.get(workspaceId);
			if (current) current.inFlight = false;
		}
	}

	private async pollGit(
		workspaceId: string,
		runtime: WorkspaceRuntime,
	): Promise<void> {
		const diff = await runtime.getDiff();
		const signature = hash(diff.statusPorcelain);
		const poll = this.polls.get(workspaceId);
		if (!poll) return;
		if (poll.gitSignature === null) {
			poll.gitSignature = signature;
			return;
		}
		if (poll.gitSignature !== signature) {
			poll.gitSignature = signature;
			this.emit.gitChanged(workspaceId);
		}
	}

	private async pollFs(
		workspaceId: string,
		runtime: WorkspaceRuntime,
	): Promise<void> {
		const fs = runtime.runtimeFs?.();
		if (!fs) return;
		const entries = await fs.listFiles(this.resolveWorkdir(workspaceId));
		const signature = hash(
			entries
				.map((e) => `${e.name}:${e.isDir ? "d" : "f"}:${e.size}:${e.modTime}`)
				.sort()
				.join("\n"),
		);
		const poll = this.polls.get(workspaceId);
		if (!poll) return;
		if (poll.fsSignature === null) {
			poll.fsSignature = signature;
			return;
		}
		if (poll.fsSignature !== signature) {
			poll.fsSignature = signature;
			this.emit.fsChanged(workspaceId);
		}
	}
}

/** Small, fast non-crypto hash (FNV-1a) — collision risk is irrelevant here. */
function hash(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}
