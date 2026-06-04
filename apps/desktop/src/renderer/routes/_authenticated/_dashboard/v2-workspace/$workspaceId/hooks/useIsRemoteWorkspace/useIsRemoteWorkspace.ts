import { workspaceTrpc } from "@superset/workspace-client";

// Remote (Daytona) workspaces run their shell and filesystem in a sandbox, so
// host-only affordances (external editor, Reveal in Finder, OS-file drag-drop)
// don't apply. The workspace page resolves this query before mounting children,
// so reading it here is cache-hot (staleTime keeps it from refetching).
export function useIsRemoteWorkspace(workspaceId: string | undefined): boolean {
	return (
		workspaceTrpc.workspace.get.useQuery(
			{ id: workspaceId ?? "" },
			{ staleTime: Number.POSITIVE_INFINITY, enabled: Boolean(workspaceId) },
		).data?.runtimeKind === "remote"
	);
}
