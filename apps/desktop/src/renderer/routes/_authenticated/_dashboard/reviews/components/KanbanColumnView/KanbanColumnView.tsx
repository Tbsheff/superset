import { useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@superset/ui/utils";
import type { KanbanColumnWithCards } from "../../hooks/useKanbanBoard";
import { KanbanCardItem } from "../KanbanCardItem";

interface KanbanColumnViewProps {
	column: KanbanColumnWithCards;
	onOpen: (prId: string) => void;
	onRemove: (cardId: string) => void;
}

export function KanbanColumnView({
	column,
	onOpen,
	onRemove,
}: KanbanColumnViewProps) {
	const { setNodeRef, isOver } = useDroppable({
		id: `column-${column.column.id}`,
		data: { type: "column", columnId: column.column.id },
	});

	const cardIds = column.cards.map((item) => item.card.id);

	return (
		<div className="flex w-[300px] shrink-0 flex-col rounded-lg bg-muted/30">
			<div className="flex items-center gap-2 px-3 py-2.5">
				<span className="text-sm font-medium text-foreground">
					{column.column.name}
				</span>
				<span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
					{column.cards.length}
				</span>
			</div>

			<div
				ref={setNodeRef}
				className={cn(
					"flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto rounded-md p-2 transition-colors",
					isOver && "bg-accent/20 ring-1 ring-accent/40",
				)}
			>
				<SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
					{column.cards.map((item) => (
						<KanbanCardItem
							key={item.card.id}
							item={item}
							onOpen={onOpen}
							onRemove={onRemove}
						/>
					))}
				</SortableContext>
				{column.cards.length === 0 ? (
					<p className="px-1 py-6 text-center text-xs text-muted-foreground/60">
						Drop a PR here
					</p>
				) : null}
			</div>
		</div>
	);
}
