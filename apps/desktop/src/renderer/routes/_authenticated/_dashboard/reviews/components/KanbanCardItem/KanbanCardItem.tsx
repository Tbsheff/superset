import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@superset/ui/utils";
import { LuX } from "react-icons/lu";
import { PRIcon } from "renderer/screens/main/components/PRIcon";
import type { KanbanCardWithPR } from "../../hooks/useKanbanBoard";
import { prIconState } from "../../utils/reviewStatus";
import { ChecksBadge, DiffStat, ReviewDecisionBadge } from "../ReviewBadges";

interface KanbanCardItemProps {
	item: KanbanCardWithPR;
	onOpen: (prId: string) => void;
	onRemove: (cardId: string) => void;
	overlay?: boolean;
}

export function KanbanCardItem({
	item,
	onOpen,
	onRemove,
	overlay,
}: KanbanCardItemProps) {
	const { card, pr, repository } = item;
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: card.id,
		data: { type: "card", card },
		disabled: overlay,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: dnd-kit drag handle needs a div, not a button
		<div
			ref={setNodeRef}
			style={style}
			{...attributes}
			{...listeners}
			role="button"
			tabIndex={0}
			onClick={() => pr && onOpen(pr.id)}
			onKeyDown={(event) => {
				if ((event.key === "Enter" || event.key === " ") && pr) {
					event.preventDefault();
					onOpen(pr.id);
				}
			}}
			className={cn(
				"group flex cursor-grab flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors active:cursor-grabbing hover:border-border-strong",
				isDragging && "opacity-40",
				overlay && "cursor-grabbing shadow-lg ring-1 ring-border",
			)}
		>
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<PRIcon
					state={pr ? prIconState(pr) : "open"}
					className="size-3.5 shrink-0"
				/>
				<span className="truncate">{repository?.fullName ?? "—"}</span>
				{pr ? (
					<span className="ml-auto shrink-0 font-mono tabular-nums">
						#{pr.prNumber}
					</span>
				) : null}
				<button
					type="button"
					aria-label="Remove from board"
					onClick={(event) => {
						event.stopPropagation();
						onRemove(card.id);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					className="ml-1 hidden rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:block"
				>
					<LuX className="size-3" />
				</button>
			</div>

			<p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
				{pr?.title ?? "Pull request unavailable"}
			</p>

			{pr ? (
				<div className="flex items-center gap-3">
					<ReviewDecisionBadge decision={pr.reviewDecision} />
					<ChecksBadge status={pr.checksStatus} />
					<DiffStat
						additions={pr.additions}
						deletions={pr.deletions}
						changedFiles={pr.changedFiles}
						className="ml-auto"
					/>
				</div>
			) : null}
		</div>
	);
}
