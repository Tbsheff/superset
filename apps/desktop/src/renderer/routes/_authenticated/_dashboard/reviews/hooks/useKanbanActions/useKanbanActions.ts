import { toast } from "@superset/ui/sonner";
import { useCallback, useMemo } from "react";
import { env } from "renderer/env.renderer";
import { authClient } from "renderer/lib/auth-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { MOCK_ORG_ID } from "shared/constants";

interface OptimisticTransaction {
	isPersisted: { promise: Promise<unknown> };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return "The change was rolled back.";
}

export function useKanbanActions() {
	const collections = useCollections();
	const { data: session } = authClient.useSession();

	const organizationId = env.SKIP_ENV_VALIDATION
		? MOCK_ORG_ID
		: (session?.session?.activeOrganizationId ?? null);
	const userId = session?.user?.id ?? null;

	const run = useCallback(
		(failureTitle: string, mutation: () => OptimisticTransaction) => {
			try {
				const transaction = mutation();
				void transaction.isPersisted.promise.catch((error) => {
					console.error(`[reviews:kanban] ${failureTitle}:`, error);
					toast.error(failureTitle, { description: errorMessage(error) });
				});
				return transaction;
			} catch (error) {
				console.error(`[reviews:kanban] ${failureTitle}:`, error);
				toast.error(failureTitle, { description: errorMessage(error) });
				return null;
			}
		},
		[],
	);

	return useMemo(
		() => ({
			addCard: (params: {
				boardId: string;
				columnId: string;
				githubPullRequestId: string;
				position: number;
			}) => {
				if (!organizationId) {
					toast.error("No active organization");
					return null;
				}
				const now = new Date();
				return run("Failed to add pull request", () =>
					collections.kanbanCards.insert({
						id: crypto.randomUUID(),
						organizationId,
						boardId: params.boardId,
						columnId: params.columnId,
						githubPullRequestId: params.githubPullRequestId,
						position: params.position,
						createdByUserId: userId,
						deletedAt: null,
						createdAt: now,
						updatedAt: now,
					}),
				);
			},
			moveCard: (cardId: string, toColumnId: string, position: number) =>
				run("Failed to move card", () =>
					collections.kanbanCards.update(cardId, (draft) => {
						draft.columnId = toColumnId;
						draft.position = position;
					}),
				),
			removeCard: (cardId: string) =>
				run("Failed to remove card", () =>
					collections.kanbanCards.delete(cardId),
				),
		}),
		[collections, organizationId, userId, run],
	);
}
