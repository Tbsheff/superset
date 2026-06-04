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
	/**
	 * Runs a one-shot command to completion inside the runtime and returns its
	 * captured stdout/stderr/exit code — the request/response counterpart to
	 * `startShell`'s long-lived PTY. Optional because a runtime that only serves
	 * interactive shells can omit it; consumers that need scripted output (status
	 * probes, file ops, search) call it and fall back to the host-side worktree
	 * when absent. A non-zero exit is returned, not thrown.
	 */
	exec?(command: string, opts?: ExecOptions): Promise<ExecResult>;
	/**
	 * The runtime's raw filesystem verbs, used by the host-side
	 * `DaytonaFsService` to back the Files tab/editor for a remote workspace.
	 * Mirrors the Daytona SDK fs surface (paths are sandbox-relative, resolved
	 * against the user home). Optional because a local runtime has a host-side
	 * worktree the existing `FsHostService` already serves; only a runtime with
	 * no host worktree (Daytona) implements it.
	 */
	runtimeFs?(): RuntimeFsApi;
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

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
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

/** Metadata for a single file/dir entry, mirroring the Daytona SDK `FileInfo`. */
export interface RuntimeFileInfo {
	name: string;
	isDir: boolean;
	size: number;
	/** Octal-ish mode string from the runtime (e.g. "-rw-r--r--" or "0644"). */
	mode: string;
	/** RFC3339 modification time. */
	modTime: string;
	permissions: string;
}

/** One content-search hit, mirroring the Daytona SDK `Match`. */
export interface RuntimeFsMatch {
	/** Sandbox-relative file path of the hit. */
	file: string;
	line: number;
	content: string;
}

/**
 * The raw filesystem verbs a `WorkspaceRuntime` exposes for host-side file
 * browsing/editing. All paths are sandbox-relative (resolved against the user
 * home, where the repo lives under the runtime workdir). Mirrors the subset of
 * the Daytona SDK fs API the `DaytonaFsService` needs.
 */
export interface RuntimeFsApi {
	listFiles(path: string): Promise<RuntimeFileInfo[]>;
	getFileDetails(path: string): Promise<RuntimeFileInfo>;
	downloadFile(path: string): Promise<Buffer>;
	uploadFile(content: Buffer, path: string): Promise<void>;
	createFolder(path: string, mode: string): Promise<void>;
	deleteFile(path: string, recursive?: boolean): Promise<void>;
	moveFiles(source: string, destination: string): Promise<void>;
	/** Recursive copy (the SDK has no copy verb; backed by `cp -r` via exec). */
	copyFiles(source: string, destination: string): Promise<void>;
	/** Name-pattern (glob) search; returns sandbox-relative file paths. */
	searchFiles(path: string, pattern: string): Promise<string[]>;
	/** Content search; returns per-line hits with sandbox-relative file paths. */
	findFiles(path: string, pattern: string): Promise<RuntimeFsMatch[]>;
}
