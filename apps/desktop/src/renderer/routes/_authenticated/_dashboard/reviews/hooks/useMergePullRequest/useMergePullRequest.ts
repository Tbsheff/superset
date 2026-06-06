import { toast } from "@superset/ui/sonner";
import { useMutation } from "@tanstack/react-query";
import { useHostUrl } from "renderer/hooks/host-service/useHostTargetUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

export type MergeMethod = "merge" | "squash" | "rebase";

interface MergeInput {
	owner: string;
	repo: string;
	pullNumber: number;
	mergeMethod: MergeMethod;
}

/**
 * Merges a PR through the host-service. GitHub then emits a `pull_request.closed`
 * webhook (merged=true) which flows back through Electric into the synced row.
 * The triage board re-buckets the PR into "Merged" on its own (it derives the
 * bucket from `mergedAt`); the team kanban is manually curated, so its card
 * stays in place but its icon/badges refresh from the synced row.
 */
export function useMergePullRequest(onMerged?: () => void) {
	const hostUrl = useHostUrl(null);

	return useMutation({
		mutationFn: async (input: MergeInput) => {
			if (!hostUrl) throw new Error("No host available to merge with");
			const client = getHostServiceClientByUrl(hostUrl);
			return client.github.mergePR.mutate(input);
		},
		onSuccess: (result) => {
			toast.success(
				result.merged ? "Pull request merged." : "Merge submitted.",
			);
			onMerged?.();
		},
		onError: (error) => {
			toast.error("Merge failed", {
				description: error instanceof Error ? error.message : String(error),
			});
		},
	});
}
