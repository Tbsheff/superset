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
 * Phase 3 (devcontainer):
 * - If the workspace's project has a remoteHostId + ready sandboxState, use DevcontainerTerminalRuntime
 *
 * Future behavior (cloud readiness):
 * - Per-workspace selection based on workspace metadata (cloudWorkspaceId, etc.)
 * - Local + cloud workspaces can coexist
 */

import { projects, remoteHosts, workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { DevcontainerTerminalRuntime } from "../devcontainer/devcontainer-terminal-runtime";
import { LocalWorkspaceRuntime } from "./local";
import {
	getSshConnectionManager,
	type SshHostConfig,
} from "./ssh-connection-manager";
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
 * (Phase 3) Returns DevcontainerTerminalRuntime when the workspace's project has a remoteHostId + ready container.
 */
class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private localRuntime: LocalWorkspaceRuntime | null = null;
	private sshRuntimes = new Map<string, SshWorkspaceRuntime>();
	private devcontainerRuntimes = new Map<string, WorkspaceRuntime>();

	/**
	 * Get the runtime for a specific workspace.
	 *
	 * Looks up remoteHostId and projectId from local-db. If the workspace's
	 * project has a remoteHostId + ready sandboxState (Phase 3), returns a
	 * DevcontainerTerminalRuntime. If the workspace itself has a remoteHostId,
	 * returns a cached SshWorkspaceRuntime for that host. Otherwise returns
	 * the local runtime.
	 */
	getForWorkspaceId(workspaceId: string): WorkspaceRuntime {
		console.log("[registry] getForWorkspaceId:", workspaceId);
		// Look up workspace to check for remote host assignment
		const workspace = localDb
			.select({
				remoteHostId: workspaces.remoteHostId,
				projectId: workspaces.projectId,
			})
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();

		// Effective remote host ID — may come from project (devcontainer) or workspace directly
		let effectiveRemoteHostId: string | null = workspace?.remoteHostId ?? null;

		// Phase 3 - Route to DevcontainerTerminalRuntime when project has remoteHostId + ready container
		if (workspace?.projectId) {
			try {
				const project = localDb
					.select()
					.from(projects)
					.where(eq(projects.id, workspace.projectId))
					.get();

				console.log(
					"[registry] Checking devcontainer: sandboxState=",
					project?.sandboxState?.substring(0, 50),
				);

				if (project?.remoteHostId && project.sandboxState) {
					// Project has a remote host — use it as the effective host for SSH fallthrough too
					effectiveRemoteHostId = project.remoteHostId;

					const state = JSON.parse(project.sandboxState);
					if (state.status === "ready" && state.containerId) {
						const cached = this.devcontainerRuntimes.get(project.id);
						if (cached) {
							console.log(
								"[registry] Returning cached DevcontainerTerminalRuntime for project:",
								project.id,
							);
							// Update SSH client if connection was re-established (e.g. after app restart)
							const currentClient = getSshConnectionManager().getConnection(project.remoteHostId);
							if (currentClient && cached.terminal instanceof DevcontainerTerminalRuntime) {
								cached.terminal.updateClient(currentClient);
							}
							return cached;
						}

						const manager = getSshConnectionManager();
						const client = manager.getConnection(project.remoteHostId);
						console.log("[registry] SSH client available:", !!client);

						if (client) {
							const projectSlug =
								project.name
									?.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/^-|-$/g, "") || "repo";
							const terminalRuntime = new DevcontainerTerminalRuntime(client, {
								containerId: state.containerId,
								workDir: `/workspaces/${projectSlug}`,
								remoteUser: "vscode",
							});
							const runtime: WorkspaceRuntime = {
								id: `devcontainer:${project.id}`,
								terminal: terminalRuntime,
								capabilities: { terminal: terminalRuntime.capabilities },
							};
							this.devcontainerRuntimes.set(project.id, runtime);
							console.log(
								"[registry] Returning DevcontainerTerminalRuntime for project:",
								project.id,
							);
							return runtime;
						}

						// No SSH client yet — trigger a background connect so the next call succeeds.
						// Fall through to SshWorkspaceRuntime below (which also connects via the
						// shared SshConnectionManager, so by the time createOrAttach runs the
						// connection will be established and subsequent calls will hit devcontainer routing).
						console.log(
							"[registry] No SSH client for devcontainer — triggering background connect and falling through to SSH runtime",
						);
						const hostRecord = localDb
							.select()
							.from(remoteHosts)
							.where(eq(remoteHosts.id, project.remoteHostId))
							.get();
						if (hostRecord?.hostname && hostRecord.username) {
							const hostConfig: SshHostConfig = {
								id: hostRecord.id,
								hostname: hostRecord.hostname,
								port: hostRecord.port ?? 22,
								username: hostRecord.username,
								authMethod:
									(hostRecord.authMethod as "key" | "agent" | "password") ??
									"agent",
								privateKeyPath: hostRecord.privateKeyPath ?? undefined,
								defaultCwd: hostRecord.defaultCwd ?? undefined,
							};
							manager.connect(hostConfig).catch((err) => {
								console.log(
									"[registry] Background SSH connect failed:",
									err.message,
								);
							});
						}
						// effectiveRemoteHostId is already set to project.remoteHostId above —
						// fall through to SSH runtime routing below
					}
				}
			} catch (err) {
				console.log(
					"[registry] Error in devcontainer routing, falling through:",
					err,
				);
				// Fall through to existing remoteHostId / local logic
			}
		}

		if (!effectiveRemoteHostId) {
			console.log("[registry] No remoteHostId — falling back to local runtime");
			return this.getDefault();
		}

		console.log(
			"[registry] Found effectiveRemoteHostId:",
			effectiveRemoteHostId,
		);

		// Check cache first
		const cached = this.sshRuntimes.get(effectiveRemoteHostId);
		if (cached) {
			return cached;
		}

		// Look up host config
		const host = localDb
			.select()
			.from(remoteHosts)
			.where(eq(remoteHosts.id, effectiveRemoteHostId))
			.get();

		console.log("[registry] Host config:", JSON.stringify(host));

		if (!host || !host.hostname || !host.username) {
			console.log(
				"[registry] Incomplete host config — falling back to local runtime",
			);
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
