/**
 * Workspace Runtime Module
 *
 * This module provides the workspace-scoped runtime abstraction.
 * Use getWorkspaceRuntimeRegistry() to get the registry and select
 * the appropriate runtime for a workspace.
 *
 * Example usage:
 * ```typescript
 * const registry = getWorkspaceRuntimeRegistry();
 * const runtime = registry.getForWorkspaceId(workspaceId);
 * const result = await runtime.terminal.createOrAttach(params);
 * ```
 */

export { LocalWorkspaceRuntime } from "./local";
export {
	createWorkspaceRuntimeRegistry,
	getWorkspaceRuntimeRegistry,
	resetWorkspaceRuntimeRegistry,
	type WorkspaceRuntimeKind,
	type WorkspaceRuntimeKindResolver,
	type WorkspaceRuntimeRegistryDeps,
} from "./registry";
export {
	type RemotePtyTransport,
	type RemotePtyTransportFactory,
	RemoteWorkspaceRuntime,
} from "./remote";
export type {
	TerminalCapabilities,
	TerminalEventSource,
	TerminalManagement,
	TerminalRuntime,
	TerminalSessionOperations,
	TerminalWorkspaceOperations,
	WorkspaceRuntime,
	WorkspaceRuntimeId,
	WorkspaceRuntimeRegistry,
} from "./types";
