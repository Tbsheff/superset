/**
 * Production wiring of the remote workspace runtime (desktop main).
 *
 * Constructs the process registry singleton with the runtime-kind resolver and
 * the host-service-backed remote PTY transport factory. The transport resolves
 * its connection through the host-service coordinator: a remote workspace's
 * recorded organizationId selects the coordinator's `{ port, secret }`
 * connection, which becomes the loopback origin the transport opens its PTY
 * WebSocket against.
 *
 * Call once during app boot, before any consumer touches the registry, so the
 * singleton is built with these deps rather than the always-local default.
 */

import { getHostServiceCoordinator } from "main/lib/host-service-coordinator";
import {
	createWorkspaceRuntimeRegistryDeps,
	getWorkspaceOrganizationId,
	type HostServiceRemoteConnection,
} from "./binding";
import { getWorkspaceRuntimeRegistry } from "./registry";

function resolveHostServiceConnection(
	workspaceId: string,
): HostServiceRemoteConnection | null {
	const organizationId = getWorkspaceOrganizationId(workspaceId);
	if (!organizationId) return null;
	const connection = getHostServiceCoordinator().getConnection(organizationId);
	if (!connection) return null;
	return {
		origin: `http://127.0.0.1:${connection.port}`,
		secret: connection.secret,
	};
}

let initialized = false;

/**
 * Build the registry singleton with remote wiring. Idempotent: the registry
 * caches its first construction, so a second call is a no-op.
 */
export function initRemoteWorkspaceRuntime(): void {
	if (initialized) return;
	initialized = true;
	getWorkspaceRuntimeRegistry(
		createWorkspaceRuntimeRegistryDeps({
			resolveConnection: resolveHostServiceConnection,
		}),
	);
}
