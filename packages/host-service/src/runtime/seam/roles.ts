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

export interface PreviewBinding {
	url: string;
	tokenScheme: "standard" | "signed" | "none";
}
