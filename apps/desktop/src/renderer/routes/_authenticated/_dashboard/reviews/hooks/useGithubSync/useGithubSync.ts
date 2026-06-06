import { toast } from "@superset/ui/sonner";
import { useMutation } from "@tanstack/react-query";
import { env } from "renderer/env.renderer";
import { authClient, getAuthToken } from "renderer/lib/auth-client";
import { MOCK_ORG_ID } from "shared/constants";

/**
 * Triggers a one-shot GitHub backfill for the active org. In production PR data
 * is kept current by webhooks, so this is a best-effort "pull now" — the sync
 * endpoint is dev-only and returns 403 in prod, which we surface as an info
 * toast rather than an error. Fresh rows propagate back through Electric.
 */
export function useGithubSync() {
	const { data: session } = authClient.useSession();
	const organizationId = env.SKIP_ENV_VALIDATION
		? MOCK_ORG_ID
		: session?.session?.activeOrganizationId;

	return useMutation({
		mutationFn: async () => {
			if (!organizationId) throw new Error("No active organization");
			const token = getAuthToken();
			const response = await fetch(
				`${env.NEXT_PUBLIC_API_URL}/api/github/sync`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ organizationId }),
				},
			);

			if (response.status === 403) {
				return { handledByWebhooks: true as const };
			}
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(body?.error ?? `Sync failed (${response.status})`);
			}
			return (await response.json()) as {
				success: boolean;
				repositoriesCount: number;
			};
		},
		onSuccess: (result) => {
			if ("handledByWebhooks" in result) {
				toast.info("Pull requests stay in sync automatically.");
				return;
			}
			toast.success(`Synced ${result.repositoriesCount} repositories.`);
		},
		onError: (error) => {
			toast.error("Pull request sync failed", {
				description: error instanceof Error ? error.message : String(error),
			});
		},
	});
}
