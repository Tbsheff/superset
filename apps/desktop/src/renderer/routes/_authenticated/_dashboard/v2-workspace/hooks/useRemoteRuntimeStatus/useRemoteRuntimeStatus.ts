import type { SelectV2Workspace } from "@superset/db/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useWorkspaceHostTarget } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

/**
 * The cold-start phase the layout gates on. A remote workspace's Daytona sandbox
 * auto-stops when idle and archives after longer; opening it must resume it
 * before the terminal/Files panes (which assume a live sandbox) mount. Local
 * workspaces have no sandbox and are always `ready`.
 *
 *   - `ready`       : runtime is running (or workspace is local) — mount the Outlet.
 *   - `loading`     : still resolving the host or the first status probe.
 *   - `restarting`  : sandbox is being resumed (auto on open). `archived`
 *                     distinguishes the slow cold-storage restore from a fast resume.
 *   - `failed`      : resume errored or the host was unreachable; `retry` re-fires it.
 *   - `destroyed`   : the sandbox no longer exists provider-side; nothing to resume.
 */
export type RemoteRuntimePhase =
	| { phase: "ready" }
	| { phase: "loading" }
	| { phase: "restarting"; archived: boolean }
	| { phase: "failed"; reason: string; retry: () => void }
	| { phase: "destroyed" };

const RUNTIME_STATUS_STALE_MS = 5_000;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reports (and drives) the resume of a remote workspace's sandbox. Polls the
 * owning host-service's read-only `workspace.runtimeStatus` and, on detecting a
 * resumable stopped/archived sandbox, fires `workspace.resumeRuntime` exactly
 * once automatically — so returning to an idle workspace just works, with a
 * "waking" state instead of a hung terminal. A hard failure surfaces a manual
 * retry, since auto-resume can't recover one.
 *
 * The status query goes to the host that OWNS the sandbox (via
 * `useWorkspaceHostTarget`), which stays reachable while the sandbox itself is
 * cold — the sandbox is stopped, not the host-service.
 */
export function useRemoteRuntimeStatus(
	workspace: SelectV2Workspace | null,
): RemoteRuntimePhase {
	const isRemote = workspace?.runtimeKind === "remote";
	const workspaceId = workspace?.id ?? null;
	const hostTarget = useWorkspaceHostTarget(isRemote ? workspaceId : null);
	const hostUrl = hostTarget.status === "ready" ? hostTarget.url : null;
	const queryEnabled = isRemote && hostUrl != null && workspaceId != null;

	const statusQuery = useQuery({
		queryKey: ["remoteRuntimeStatus", workspaceId, hostUrl],
		queryFn: () =>
			getHostServiceClientByUrl(
				hostUrl as string,
			).workspace.runtimeStatus.query({ id: workspaceId as string }),
		enabled: queryEnabled,
		staleTime: RUNTIME_STATUS_STALE_MS,
		retry: 1,
	});

	const resumeMutation = useMutation({
		mutationFn: () =>
			getHostServiceClientByUrl(
				hostUrl as string,
			).workspace.resumeRuntime.mutate({ id: workspaceId as string }),
		onSuccess: () => {
			void statusQuery.refetch();
		},
	});

	const status = statusQuery.data;
	const isResumableCold = status?.kind === "stopped" && status.resumable;
	const archived = status?.kind === "stopped" && status.archived === true;

	// Auto-resume a cold sandbox once per cold detection. The ref re-arms when the
	// sandbox is confirmed running, so a later re-cold (idle stop while open) also
	// auto-resumes rather than stranding the user.
	const autoResumedFor = useRef<string | null>(null);
	useEffect(() => {
		if (status?.kind === "running") {
			autoResumedFor.current = null;
		}
	}, [status?.kind]);
	useEffect(() => {
		if (!queryEnabled || !workspaceId || !isResumableCold) return;
		if (autoResumedFor.current === workspaceId) return;
		if (resumeMutation.isPending) return;
		autoResumedFor.current = workspaceId;
		resumeMutation.mutate();
	}, [queryEnabled, workspaceId, isResumableCold, resumeMutation]);

	const retry = () => {
		resumeMutation.reset();
		resumeMutation.mutate();
	};

	if (!isRemote) return { phase: "ready" };
	if (
		hostTarget.status === "loading" ||
		hostTarget.status === "local-starting"
	) {
		return { phase: "loading" };
	}
	// Workspace not in the host's collection — existence is handled upstream in the
	// layout; don't block on the runtime gate here.
	if (hostTarget.status === "not-found") return { phase: "ready" };

	if (resumeMutation.isPending) return { phase: "restarting", archived };
	if (resumeMutation.isError) {
		return {
			phase: "failed",
			reason: describeError(resumeMutation.error),
			retry,
		};
	}
	if (statusQuery.isPending) return { phase: "loading" };
	if (statusQuery.isError) {
		return {
			phase: "failed",
			reason:
				"Couldn't reach the host to check the workspace sandbox. The host may be offline.",
			retry: () => {
				void statusQuery.refetch();
			},
		};
	}

	switch (status?.kind) {
		case "running":
			return { phase: "ready" };
		case "creating":
			return { phase: "restarting", archived: false };
		case "stopped":
			// Auto-resume effect fires; show the waking state meanwhile.
			return { phase: "restarting", archived };
		case "failed":
			return { phase: "failed", reason: status.reason, retry };
		case "destroyed":
			return { phase: "destroyed" };
		default:
			return { phase: "loading" };
	}
}
