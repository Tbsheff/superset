/**
 * Workspace Runtime Registry
 *
 * Process-scoped registry for workspace runtime providers.
 * The registry is cached for the lifetime of the process.
 *
 * Current behavior:
 * - Workspaces whose host-service binding is `runtimeKind === "remote"` route to
 *   the `RemoteWorkspaceRuntime` (host-service-backed sandbox terminals).
 * - All other workspaces route to the `LocalWorkspaceRuntime` (local daemon).
 * - Runtime instances are cached per kind for the lifetime of the process.
 */

import { LocalWorkspaceRuntime } from "./local";
import {
	type RemotePtyTransportFactory,
	RemoteWorkspaceRuntime,
} from "./remote";
import type { WorkspaceRuntime, WorkspaceRuntimeRegistry } from "./types";

// =============================================================================
// Runtime Kind Resolution
// =============================================================================

/** The desktop-side mirror of the host-service `runtimeKind` discriminant. */
export type WorkspaceRuntimeKind = "local" | "remote";

/**
 * Classifies a workspace as local or remote. The registry calls this
 * synchronously inside `getForWorkspaceId`, so it must not do async I/O; callers
 * back it with an in-memory map or cached binding lookup. Defaults to "local"
 * when no resolver is configured, preserving the pre-remote behavior.
 */
export type WorkspaceRuntimeKindResolver = (
	workspaceId: string,
) => WorkspaceRuntimeKind;

export interface WorkspaceRuntimeRegistryDeps {
	/** Decides which runtime a workspace uses; defaults to always-local. */
	resolveRuntimeKind?: WorkspaceRuntimeKindResolver;
	/**
	 * Builds the remote PTY transport for a (workspace, pane). Required to serve
	 * remote workspaces; if a workspace resolves to "remote" without it, the
	 * registry throws rather than silently falling back to local.
	 */
	remoteTransportFactory?: RemotePtyTransportFactory;
}

// =============================================================================
// Registry Implementation
// =============================================================================

class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private localRuntime: LocalWorkspaceRuntime | null = null;
	private remoteRuntime: RemoteWorkspaceRuntime | null = null;

	private readonly resolveRuntimeKind: WorkspaceRuntimeKindResolver;
	private readonly remoteTransportFactory?: RemotePtyTransportFactory;

	constructor(deps: WorkspaceRuntimeRegistryDeps = {}) {
		this.resolveRuntimeKind = deps.resolveRuntimeKind ?? (() => "local");
		this.remoteTransportFactory = deps.remoteTransportFactory;
	}

	/**
	 * Get the runtime for a specific workspace.
	 *
	 * Routes `runtimeKind === "remote"` workspaces to the cached
	 * `RemoteWorkspaceRuntime`; everything else uses the local daemon runtime.
	 */
	getForWorkspaceId(workspaceId: string): WorkspaceRuntime {
		if (this.resolveRuntimeKind(workspaceId) === "remote") {
			return this.getRemote();
		}
		return this.getDefault();
	}

	/**
	 * Get the default runtime (for global/legacy endpoints).
	 *
	 * Returns the local runtime, lazily initialized and cached for the lifetime
	 * of the process.
	 */
	getDefault(): WorkspaceRuntime {
		if (!this.localRuntime) {
			this.localRuntime = new LocalWorkspaceRuntime();
		}
		return this.localRuntime;
	}

	private getRemote(): RemoteWorkspaceRuntime {
		if (!this.remoteTransportFactory) {
			throw new Error(
				"WorkspaceRuntimeRegistry: a remote workspace was requested but no remoteTransportFactory is configured",
			);
		}
		if (!this.remoteRuntime) {
			this.remoteRuntime = new RemoteWorkspaceRuntime(
				this.remoteTransportFactory,
			);
		}
		return this.remoteRuntime;
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

let registryInstance: WorkspaceRuntimeRegistry | null = null;

/**
 * Get the workspace runtime registry.
 *
 * The registry is process-scoped and cached. Callers should capture it once
 * (e.g., when creating a tRPC router) and use it for the lifetime of the router.
 *
 * The first call may pass deps (runtime-kind resolver + remote transport
 * factory); later calls return the same instance and ignore their argument.
 */
export function getWorkspaceRuntimeRegistry(
	deps?: WorkspaceRuntimeRegistryDeps,
): WorkspaceRuntimeRegistry {
	if (!registryInstance) {
		registryInstance = new DefaultWorkspaceRuntimeRegistry(deps);
	}
	return registryInstance;
}

/**
 * Create a fresh registry without touching the process singleton.
 * Intended for tests that need to inject a resolver / transport factory.
 */
export function createWorkspaceRuntimeRegistry(
	deps: WorkspaceRuntimeRegistryDeps = {},
): WorkspaceRuntimeRegistry {
	return new DefaultWorkspaceRuntimeRegistry(deps);
}

/**
 * Reset the registry (for testing only).
 * This should not be called in production code.
 */
export function resetWorkspaceRuntimeRegistry(): void {
	registryInstance = null;
}
