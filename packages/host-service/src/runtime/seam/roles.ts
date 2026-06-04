import type { ActivityLease } from "./activity-lease.ts";
import type { CleanupMode } from "./cleanup.ts";
import type { ExecutionSurface } from "./facets.ts";
import type { NormalizedRuntimeStatus } from "./status.ts";

export type RuntimeRole = "workspace"; // single-member union for v1; grows additively

/**
 * Reconciled WorkspaceRuntime — the host-service runtime *handle* returned by
 * createInstance({ role: "workspace" }). This is the EXECUTION boundary
 * (shell + diff + preview + lifecycle), distinct from the desktop terminal
 * boundary in apps/desktop/src/main/lib/workspace-runtime/types.ts.
 *
 * See plans/runtime-provider-phase0-reconciliation.md: this sits BELOW the
 * host-service capability managers, not as a third registry. The adapters
 * implement this handle.
 */
export interface WorkspaceRuntime {
	readonly role: "workspace";
	readonly externalId: string; // provider id/name for reconnect; "" for not-yet-created
	startShell(opts: StartShellOptions): Promise<ShellHandle>;
	getDiff(opts?: GetDiffOptions): Promise<RuntimeDiff>;
	/**
	 * Per-file before/after CONTENT for one path, mirroring the local
	 * `collectFileDiff` projection so the Changes view renders byte-identically
	 * for remote and local. Optional because `getDiff` (whole-workspace
	 * status + patch) is the only required diff verb; a runtime that can't serve
	 * per-file content (or whose worktree lives host-side) omits this and the
	 * caller falls back to the local worktree path.
	 */
	getFileContents?(req: FileContentsRequest): Promise<FileContentsResult>;
	/**
	 * Exports the workspace's outstanding work as a single git patch (binary-safe
	 * bytes), collected INSIDE the runtime. The host applies + pushes it with a
	 * single-repo-scoped token that never enters the runtime (see
	 * `runtime/git/push-remote-patch`). Optional because only a runtime with no
	 * host-side worktree (e.g. Daytona) needs it; a local runtime pushes its own
	 * worktree directly and omits this.
	 */
	exportPatch?(): Promise<Buffer>;
	exposePreview(port: number): Promise<PreviewBinding>;
	activityLease(): ActivityLease;
	getStatus(): Promise<NormalizedRuntimeStatus>;
	stop(mode: CleanupMode): Promise<void>;
}

export type RuntimeHandleFor<R extends RuntimeRole> = R extends "workspace"
	? WorkspaceRuntime
	: never;

export interface StartShellOptions {
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
}

export interface ShellHandle {
	readonly surface: ExecutionSurface;
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

/**
 * Which revision pair a per-file content diff compares. Mirrors the local
 * `git.getDiff` categories (`runtime/git/diff-collector`) so a remote runtime
 * resolves the same before/after content the local endpoint does.
 */
export type FileContentsCategory =
	| "against-base"
	| "staged"
	| "unstaged"
	| "commit";

export interface FileContentsRequest {
	/** Worktree-relative path. */
	path: string;
	category: FileContentsCategory;
	baseBranch?: string;
	commitHash?: string;
	fromHash?: string;
}

export interface FileContentsResult {
	oldFile: { name: string; contents: string };
	newFile: { name: string; contents: string };
}

export interface PreviewBinding {
	url: string;
	tokenScheme: "standard" | "signed" | "none";
}
