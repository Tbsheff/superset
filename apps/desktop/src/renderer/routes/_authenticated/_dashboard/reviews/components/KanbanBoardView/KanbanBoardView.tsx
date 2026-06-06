import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Spinner } from "@superset/ui/spinner";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useKanbanActions } from "../../hooks/useKanbanActions";
import {
	type KanbanCardWithPR,
	useKanbanBoard,
} from "../../hooks/useKanbanBoard";
import { computeDropPosition, endPosition } from "../../utils/kanbanPosition";
import { AddPullRequestButton } from "../AddPullRequestButton";
import { KanbanCardItem } from "../KanbanCardItem";
import { KanbanColumnView } from "../KanbanColumnView";

export function KanbanBoardView() {
	const navigate = useNavigate();
	const { board, columns, placedPullRequestIds, isReady } = useKanbanBoard();
	const actions = useKanbanActions();
	const [activeCard, setActiveCard] = useState<KanbanCardWithPR | null>(null);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const cardsById = useMemo(() => {
		const map = new Map<string, KanbanCardWithPR>();
		for (const column of columns) {
			for (const item of column.cards) map.set(item.card.id, item);
		}
		return map;
	}, [columns]);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			setActiveCard(cardsById.get(event.active.id as string) ?? null);
		},
		[cardsById],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveCard(null);
			const { active, over } = event;
			if (!over || over.id === active.id) return;

			const cardId = active.id as string;
			const overData = over.data.current;
			const overCardId =
				overData?.type === "card" ? (overData.card.id as string) : null;
			const targetColumnId =
				overData?.type === "column"
					? (overData.columnId as string)
					: overData?.type === "card"
						? (overData.card.columnId as string)
						: null;
			if (!targetColumnId) return;

			const item = cardsById.get(cardId);
			if (!item) return;

			const targetColumn = columns.find(
				(column) => column.column.id === targetColumnId,
			);
			if (!targetColumn) return;

			const position = computeDropPosition(
				targetColumn.cards,
				overCardId,
				cardId,
			);

			// Skip the true no-op (same column, same slot); reordering within a
			// column and any cross-column move both fall through to persist.
			if (
				item.card.columnId === targetColumnId &&
				item.card.position === position
			) {
				return;
			}

			actions.moveCard(cardId, targetColumnId, position);
		},
		[cardsById, columns, actions],
	);

	const handleAdd = useCallback(
		(githubPullRequestId: string) => {
			if (!board) return;
			const firstColumn = columns[0];
			if (!firstColumn) return;
			actions.addCard({
				boardId: board.id,
				columnId: firstColumn.column.id,
				githubPullRequestId,
				position: endPosition(firstColumn.cards.map((c) => c.card.position)),
			});
		},
		[board, columns, actions],
	);

	const handleOpen = useCallback(
		(prId: string) => navigate({ to: "/reviews/$prId", params: { prId } }),
		[navigate],
	);

	if (!board) {
		return (
			<div className="flex flex-1 items-center justify-center">
				{isReady ? (
					<span className="text-sm text-muted-foreground">
						Setting up your team board…
					</span>
				) : (
					<Spinner className="size-5 text-muted-foreground" />
				)}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 px-4 py-2">
				<AddPullRequestButton
					placedPullRequestIds={placedPullRequestIds}
					onAdd={handleAdd}
				/>
			</div>

			<DndContext
				sensors={sensors}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragCancel={() => setActiveCard(null)}
			>
				<div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-3">
					{columns.map((column) => (
						<KanbanColumnView
							key={column.column.id}
							column={column}
							onOpen={handleOpen}
							onRemove={actions.removeCard}
						/>
					))}
				</div>

				<DragOverlay dropAnimation={null}>
					{activeCard ? (
						<div className="w-[284px]">
							<KanbanCardItem
								item={activeCard}
								onOpen={() => {}}
								onRemove={() => {}}
								overlay
							/>
						</div>
					) : null}
				</DragOverlay>
			</DndContext>
		</div>
	);
}
