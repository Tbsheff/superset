import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useWorkspaceTransactionsStore } from "renderer/stores/workspace-creates";
import { WorkspaceCreateErrorState } from "./components/WorkspaceCreateErrorState";
import { WorkspaceCreatingState } from "./components/WorkspaceCreatingState";
import { WorkspaceHostIncompatibleState } from "./components/WorkspaceHostIncompatibleState";
import { WorkspaceNotFoundState } from "./components/WorkspaceNotFoundState";
import { useRemoteHostStatus } from "./hooks/useRemoteHostStatus";
import { WorkspaceProvider } from "./providers/WorkspaceProvider";

/**
 * How long after a create we keep showing the "creating" state for a workspace
 * whose server row hasn't synced yet, before treating it as genuinely missing.
 * Generous because the create already succeeded server-side — this only covers
 * Electric/Neon replication lag, and the creating state offers its own reload
 * escape hatch after 30s.
 */
const PENDING_SYNC_GRACE_MS = 10 * 60 * 1000;

export const Route = createFileRoute("/_authenticated/_dashboard/v2-workspace")(
	{
		component: V2WorkspaceLayout,
	},
);

function V2WorkspaceLayout() {
	const matchRoute = useMatchRoute();
	const workspaceMatch = matchRoute({
		to: "/v2-workspace/$workspaceId",
	});
	const workspaceId =
		workspaceMatch !== false ? workspaceMatch.workspaceId : null;
	const collections = useCollections();
	const { ensureWorkspaceInSidebar } = useDashboardSidebarState();
	const pendingTransaction = useWorkspaceTransactionsStore((state) =>
		workspaceId ? (state.byWorkspaceId[workspaceId] ?? null) : null,
	);
	const clearWorkspaceTransaction = useWorkspaceTransactionsStore(
		(state) => state.clear,
	);
	const isCreatePending = pendingTransaction?.type === "insert";

	const { data: workspaces, isReady } = useLiveQuery(
		(q) =>
			q
				.from({ v2Workspaces: collections.v2Workspaces })
				.where(({ v2Workspaces }) => eq(v2Workspaces.id, workspaceId ?? "")),
		[collections, workspaceId],
	);
	const { data: failedEntries } = useLiveQuery(
		(q) =>
			q
				.from({ failed: collections.failedWorkspaceCreates })
				.where(({ failed }) => eq(failed.id, workspaceId ?? "")),
		[collections, workspaceId],
	);
	// Local state is written the moment a create starts (writeWorkspacePaneLayout)
	// and removed on delete/failure. Its presence without a synced v2_workspaces
	// row means "created, awaiting sync" — used below to keep showing the creating
	// state (instead of "not found") when Electric lags the new row's txid.
	const { data: localStateEntries } = useLiveQuery(
		(q) =>
			q
				.from({ localState: collections.v2WorkspaceLocalState })
				.where(({ localState }) =>
					eq(localState.workspaceId, workspaceId ?? ""),
				),
		[collections, workspaceId],
	);
	const workspace = workspaces?.[0] ?? null;
	const failedEntry = failedEntries?.[0] ?? null;
	const localState = localStateEntries?.[0] ?? null;
	const localStateCreatedAtMs = localState
		? new Date(localState.createdAt).getTime()
		: 0;
	// A just-created workspace whose row hasn't synced yet is "provisioning", not
	// "not found". Bound it so a stale local-state row (e.g. a workspace deleted
	// on another device) still falls through to not-found after the window.
	const awaitingFirstSync =
		isCreatePending ||
		(!!localState &&
			Date.now() - localStateCreatedAtMs < PENDING_SYNC_GRACE_MS);

	useEffect(() => {
		if (workspace?.$synced === true && pendingTransaction?.type === "insert") {
			clearWorkspaceTransaction(workspace.id);
		}
	}, [clearWorkspaceTransaction, pendingTransaction, workspace]);

	const lastEnsuredWorkspaceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspace || lastEnsuredWorkspaceIdRef.current === workspace.id)
			return;
		lastEnsuredWorkspaceIdRef.current = workspace.id;
		ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
	}, [ensureWorkspaceInSidebar, workspace]);

	const hostStatus = useRemoteHostStatus(workspace);

	if (!workspaceId || !workspaces || (!workspace && !isReady)) {
		return <div className="flex h-full w-full" />;
	}

	if (!workspace) {
		if (failedEntry) {
			return <WorkspaceCreateErrorState entry={failedEntry} />;
		}
		// Created but the row hasn't streamed in yet (Electric/Neon lag): keep
		// showing "creating" rather than a false "not found", using the name/branch
		// snapshotted on the local-state row at create time.
		if (awaitingFirstSync) {
			return (
				<WorkspaceCreatingState
					name={localState?.name}
					branch={localState?.branch}
					startedAt={localState ? localStateCreatedAtMs : undefined}
				/>
			);
		}
		return <WorkspaceNotFoundState workspaceId={workspaceId} />;
	}

	if (isCreatePending) {
		return (
			<WorkspaceCreatingState
				name={workspace.name}
				branch={workspace.branch}
				startedAt={new Date(workspace.createdAt).getTime()}
			/>
		);
	}

	if (hostStatus.status === "incompatible") {
		return (
			<WorkspaceHostIncompatibleState
				hostName={hostStatus.hostName}
				hostVersion={hostStatus.hostVersion}
				minVersion={hostStatus.minVersion}
			/>
		);
	}
	if (hostStatus.status === "loading") {
		return <div className="flex h-full w-full" />;
	}

	return (
		<WorkspaceProvider workspace={workspace}>
			<Outlet />
		</WorkspaceProvider>
	);
}
