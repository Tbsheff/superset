import type {
	SelectGithubPullRequest,
	SelectGithubRepository,
	SelectKanbanBoard,
	SelectKanbanCard,
	SelectKanbanColumn,
} from "@superset/db/schema";
import { and, eq, isNull } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef } from "react";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

export interface KanbanCardWithPR {
	card: SelectKanbanCard;
	pr: SelectGithubPullRequest | null;
	repository: SelectGithubRepository | null;
}

export interface KanbanColumnWithCards {
	column: SelectKanbanColumn;
	cards: KanbanCardWithPR[];
}

interface UseKanbanBoardResult {
	board: SelectKanbanBoard | null;
	columns: KanbanColumnWithCards[];
	/** PR ids already placed on the board (to filter the "add PR" picker). */
	placedPullRequestIds: Set<string>;
	isReady: boolean;
}

// Never matches a real uuid — used to make the board-scoped live queries return
// nothing until the board has loaded (and to keep them indexed by board_id).
const NO_BOARD = "";

export function useKanbanBoard(): UseKanbanBoardResult {
	const collections = useCollections();

	const { data: boardRows = [], isReady: boardsReady } = useLiveQuery(
		(q) =>
			q
				.from({ board: collections.kanbanBoards })
				.where(({ board }) => isNull(board.deletedAt))
				.select(({ board }) => ({ ...board })),
		[collections],
	);

	// The org's shared default board is the team-unscoped one. Provision it once
	// if absent — gated on readiness, server-idempotent, with a delayed retry so
	// a transient failure doesn't strand the view on "Setting up…".
	const board =
		boardRows.find((row) => row.teamId === null) ?? boardRows[0] ?? null;
	const seedInFlight = useRef(false);
	useEffect(() => {
		if (!boardsReady || board || seedInFlight.current) return;
		seedInFlight.current = true;
		let cancelled = false;
		// Idempotent mutation; retry on transient failure until the board syncs
		// in (which flips the `board` guard) or the view unmounts.
		const attempt = () => {
			apiTrpcClient.kanban.ensureDefaultBoard
				.mutate()
				.then(undefined, (error) => {
					console.error("[reviews] ensureDefaultBoard failed", error);
					if (!cancelled) window.setTimeout(attempt, 3000);
				});
		};
		attempt();
		return () => {
			cancelled = true;
		};
	}, [boardsReady, board]);

	const boardId = board?.id ?? null;

	const { data: columnRows = [], isReady: columnsReady } = useLiveQuery(
		(q) =>
			q
				.from({ column: collections.kanbanColumns })
				.where(({ column }) =>
					and(
						eq(column.boardId, boardId ?? NO_BOARD),
						isNull(column.deletedAt),
					),
				)
				.select(({ column }) => ({ ...column })),
		[collections, boardId],
	);

	const { data: cardRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ card: collections.kanbanCards })
				.where(({ card }) =>
					and(eq(card.boardId, boardId ?? NO_BOARD), isNull(card.deletedAt)),
				)
				.select(({ card }) => ({ ...card })),
		[collections, boardId],
	);

	const { data: prRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ pr: collections.githubPullRequests })
				.select(({ pr }) => ({ ...pr })),
		[collections],
	);

	const { data: repoRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ repo: collections.githubRepositories })
				.select(({ repo }) => ({ ...repo })),
		[collections],
	);

	const prById = useMemo(() => {
		const map = new Map<string, SelectGithubPullRequest>();
		for (const pr of prRows) map.set(pr.id, pr);
		return map;
	}, [prRows]);

	const repoById = useMemo(() => {
		const map = new Map<string, SelectGithubRepository>();
		for (const repo of repoRows) map.set(repo.id, repo);
		return map;
	}, [repoRows]);

	const placedPullRequestIds = useMemo(() => {
		const set = new Set<string>();
		for (const card of cardRows) set.add(card.githubPullRequestId);
		return set;
	}, [cardRows]);

	const columns = useMemo<KanbanColumnWithCards[]>(() => {
		if (!boardId) return [];

		const boardColumns = [...columnRows].sort(
			(a, b) => a.position - b.position,
		);

		const cardsByColumn = new Map<string, KanbanCardWithPR[]>();
		for (const column of boardColumns) cardsByColumn.set(column.id, []);

		for (const card of cardRows) {
			const bucket = cardsByColumn.get(card.columnId);
			if (!bucket) continue;
			const pr = prById.get(card.githubPullRequestId) ?? null;
			bucket.push({
				card,
				pr,
				repository: pr ? (repoById.get(pr.repositoryId) ?? null) : null,
			});
		}

		for (const bucket of cardsByColumn.values()) {
			bucket.sort((a, b) => a.card.position - b.card.position);
		}

		return boardColumns.map((column) => ({
			column,
			cards: cardsByColumn.get(column.id) ?? [],
		}));
	}, [boardId, columnRows, cardRows, prById, repoById]);

	return {
		board,
		columns,
		placedPullRequestIds,
		isReady: boardsReady && columnsReady,
	};
}
