import { useQuery } from "@tanstack/react-query";
import { useHostUrl } from "renderer/hooks/host-service/useHostTargetUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";

/**
 * The authenticated GitHub login of the current user, resolved via the
 * host-service `github.getUser` (octokit `users.getAuthenticated`). Used to
 * power the "My open PRs" / "Needs my review" triage views, since the synced
 * `githubPullRequests` rows key authorship on a GitHub login, not a Superset
 * user id. Cached aggressively — a login effectively never changes.
 */
export function useViewerLogin(): string | null {
	const hostUrl = useHostUrl(null);

	const { data } = useQuery({
		queryKey: ["github-viewer-login", hostUrl],
		queryFn: async () => {
			if (!hostUrl) return null;
			const client = getHostServiceClientByUrl(hostUrl);
			const user = await client.github.getUser.query();
			return user.login ?? null;
		},
		enabled: !!hostUrl,
		staleTime: 60 * 60_000,
		gcTime: 24 * 60 * 60_000,
		retry: false,
	});

	return data ?? null;
}
