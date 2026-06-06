import { useQuery } from "@tanstack/react-query";
import { useHostUrl } from "renderer/hooks/host-service/useHostTargetUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

interface UsePullRequestDiffParams {
	owner: string | null;
	repo: string | null;
	pullNumber: number | null;
}

/**
 * Fetches the full unified diff for a PR in a single request (host-service
 * `github.getPRDiff`, the `diff` media type). The string is handed straight to
 * @pierre/diffs `<PatchDiff>`, which parses + virtualizes it off the main thread.
 */
export function usePullRequestDiff({
	owner,
	repo,
	pullNumber,
}: UsePullRequestDiffParams) {
	const hostUrl = useHostUrl(null);
	const enabled = !!hostUrl && !!owner && !!repo && pullNumber != null;

	return useQuery({
		queryKey: ["pull-request-diff", hostUrl, owner, repo, pullNumber],
		queryFn: async () => {
			if (!hostUrl || !owner || !repo || pullNumber == null) return null;
			const client = getHostServiceClientByUrl(hostUrl);
			return client.github.getPRDiff.query({ owner, repo, pullNumber });
		},
		enabled,
		staleTime: 60_000,
		gcTime: 10 * 60_000,
		retry: false,
	});
}
