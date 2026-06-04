/**
 * Workspace Runtime Binding Store (desktop main)
 *
 * The registry's `WorkspaceRuntimeKindResolver` is synchronous and runs inside
 * `getForWorkspaceId`, so it must not touch the network or the host-service db
 * (the authoritative `workspaces.runtimeKind` lives host-side). This module is
 * the desktop-main mirror of that column: a process-scoped in-memory map that
 * main populates whenever it learns a workspace's binding, and reads back
 * synchronously to route terminal ops.
 *
 * Unknown workspaces default to "local", preserving the pre-remote behavior —
 * a workspace is only treated as remote once main has explicitly recorded a
 * remote binding for it.
 */

import type {
	WorkspaceRuntimeKind,
	WorkspaceRuntimeKindResolver,
} from "../registry";

/**
 * A recorded binding. A remote workspace also carries the organizationId so the
 * transport factory can resolve the right host-service connection (the
 * coordinator keys connections by org, not workspace). A local binding carries
 * none — discriminant + boundary refinement, not loose optional fields.
 */
type WorkspaceRuntimeBinding =
	| { kind: "local" }
	| { kind: "remote"; organizationId: string };

const bindings = new Map<string, WorkspaceRuntimeBinding>();

/** Mark a workspace as local-execution (the default). */
export function setWorkspaceLocal(workspaceId: string): void {
	bindings.set(workspaceId, { kind: "local" });
}

/**
 * Mark a workspace as remote-execution, recording the organizationId whose
 * host-service hosts its sandbox. Called by main when it learns a workspace's
 * host-service binding is `runtimeKind === "remote"`.
 */
export function setWorkspaceRemote(
	workspaceId: string,
	organizationId: string,
): void {
	bindings.set(workspaceId, { kind: "remote", organizationId });
}

/** Forget a single workspace's binding (e.g. on workspace deletion). */
export function clearWorkspaceRuntimeKind(workspaceId: string): void {
	bindings.delete(workspaceId);
}

/** Forget every recorded binding. Intended for teardown and tests. */
export function clearAllWorkspaceRuntimeKinds(): void {
	bindings.clear();
}

/**
 * The organizationId a remote workspace runs in, or null for local/unknown
 * workspaces. The transport factory's `resolveConnection` uses this to pick the
 * coordinator connection.
 */
export function getWorkspaceOrganizationId(workspaceId: string): string | null {
	const binding = bindings.get(workspaceId);
	return binding?.kind === "remote" ? binding.organizationId : null;
}

/**
 * The synchronous resolver the registry consults. Defaults to "local" for
 * workspaces main has never recorded, so the absence of a binding can never
 * accidentally route a workspace to the remote runtime.
 */
export const resolveWorkspaceRuntimeKind: WorkspaceRuntimeKindResolver = (
	workspaceId,
): WorkspaceRuntimeKind => bindings.get(workspaceId)?.kind ?? "local";
