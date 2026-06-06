export const KANBAN_POSITION_GAP = 1000;

/** Position for appending after the current max (or the first card on an empty column). */
export function endPosition(positions: number[]): number {
	return (
		(positions.length > 0 ? Math.max(...positions) : 0) + KANBAN_POSITION_GAP
	);
}

export interface PositionedCard {
	card: { id: string; position: number };
}

/**
 * Fractional drop position so a card lands where it was dropped — between the two
 * siblings at the target slot (midpoint), or at the head/tail. The dragged card
 * is excluded from the sibling list so a within-column reorder computes against
 * its neighbours, not its own old slot. `orderedCards` must be sorted by position.
 */
export function computeDropPosition(
	orderedCards: PositionedCard[],
	overCardId: string | null,
	draggedCardId: string,
): number {
	const siblings = orderedCards.filter(
		(item) => item.card.id !== draggedCardId,
	);
	let index = siblings.length;
	if (overCardId && overCardId !== draggedCardId) {
		const found = siblings.findIndex((item) => item.card.id === overCardId);
		if (found !== -1) index = found;
	}

	const prev = index > 0 ? siblings[index - 1].card.position : null;
	const next = index < siblings.length ? siblings[index].card.position : null;

	if (prev != null && next != null) return (prev + next) / 2;
	if (prev != null) return prev + KANBAN_POSITION_GAP;
	if (next != null) return next - KANBAN_POSITION_GAP;
	return KANBAN_POSITION_GAP;
}
