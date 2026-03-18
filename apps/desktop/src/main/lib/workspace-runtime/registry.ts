/**
 * Workspace Runtime Registry
 *
 * Process-scoped registry for workspace runtime providers.
 * The registry is cached for the lifetime of the process.
 *
 * Current behavior:
 * - Workspaces with a remoteHostId use SshWorkspaceRuntime (cached per host)
 * - Workspaces without remoteHostId use LocalWorkspaceRuntime
 *
 * Future behavior (cloud readiness):
 * - Per-workspace selection based on workspace metadata (cloudWorkspaceId, etc.)
 * - Local + cloud workspaces can coexist
 */

import { remoteHosts, workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { LocalWorkspaceRuntime } from "./local";
import { SshWorkspaceRuntime } from "./ssh-workspace-runtime";
import type { WorkspaceRuntime, WorkspaceRuntimeRegistry } from "./types";

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Default registry implementation.
 *
 * Returns LocalWorkspaceRuntime for workspaces without a remoteHostId.
 * Returns a cached SshWorkspaceRuntime for workspaces with a remoteHostId.
 */
class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private localRuntime: LocalWorkspaceRuntime | null = null;
	private sshRuntimes = new Map<string, SshWorkspaceRuntime>();

	/**
	 * Get the runtime for a specific workspace.
	 *
	 * Looks up remoteHostId from local-db. If set, returns a cached
	 * SshWorkspaceRuntime for that host. Otherwise returns local runtime.
	 */
	getForWorkspaceId(workspaceId: string): WorkspaceRuntime {
		console.log("[registry] getForWorkspaceId:", workspaceId);
		// Look up workspace to check for remote host assignment
		const workspace = localDb
			.select({ remoteHostId: workspaces.remoteHostId })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();

		if (!workspace?.remoteHostId) {
			console.log("[registry] Falling back to local runtime");
			return this.getDefault();
		}

		console.log("[registry] Found remoteHostId:", workspace.remoteHostId);

		// Check cache first
		const cached = this.sshRuntimes.get(workspace.remoteHostId);
		if (cached) {
			return cached;
		}

		// Look up host config
		const host = localDb
			.select()
			.from(remoteHosts)
			.where(eq(remoteHosts.id, workspace.remoteHostId))
			.get();

		console.log("[registry] Host config:", JSON.stringify(host));

		if (!host || !host.hostname || !host.username) {
			console.log("[registry] Falling back to local runtime");
			// Fallback to local if host config is incomplete
			return this.getDefault();
		}

		const runtime = new SshWorkspaceRuntime({
			id: host.id,
			hostname: host.hostname,
			port: host.port ?? 22,
			username: host.username,
			authMethod: (host.authMethod as "key" | "agent" | "password") ?? "agent",
			privateKeyPath: host.privateKeyPath ?? undefined,
			defaultCwd: host.defaultCwd ?? undefined,
		});

		this.sshRuntimes.set(host.id, runtime);
		console.log("[registry] Returning SSH runtime for host:", host.id);
		return runtime;
	}

	/**
	 * Get the default runtime (for global/legacy endpoints).
	 *
	 * Returns the local runtime, lazily initialized.
	 * The runtime instance is cached for the lifetime of the process.
	 */
	getDefault(): WorkspaceRuntime {
		if (!this.localRuntime) {
			this.localRuntime = new LocalWorkspaceRuntime();
		}
		return this.localRuntime;
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
 * This design allows:
 * 1. Stable runtime instances (no re-creation on each call)
 * 2. Consistent event wiring (same backend for all listeners)
 * 3. Future per-workspace selection (local vs cloud)
 */
export function getWorkspaceRuntimeRegistry(): WorkspaceRuntimeRegistry {
	if (!registryInstance) {
		registryInstance = new DefaultWorkspaceRuntimeRegistry();
	}
	return registryInstance;
}

/**
 * Reset the registry (for testing only).
 * This should not be called in production code.
 */
export function resetWorkspaceRuntimeRegistry(): void {
	registryInstance = null;
}
