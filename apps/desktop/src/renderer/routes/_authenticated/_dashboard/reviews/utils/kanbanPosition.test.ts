import { describe, expect, it } from "bun:test";
import {
	computeDropPosition,
	endPosition,
	KANBAN_POSITION_GAP,
	type PositionedCard,
} from "./kanbanPosition";

const cards = (...positions: number[]): PositionedCard[] =>
	positions.map((position, index) => ({
		card: { id: `c${index}`, position },
	}));

describe("endPosition", () => {
	it("starts at the gap for an empty column", () => {
		expect(endPosition([])).toBe(KANBAN_POSITION_GAP);
	});
	it("appends after the current max", () => {
		expect(endPosition([1000, 3000, 2000])).toBe(3000 + KANBAN_POSITION_GAP);
	});
});

describe("computeDropPosition", () => {
	it("returns the gap when dropping into an empty column", () => {
		expect(computeDropPosition([], null, "x")).toBe(KANBAN_POSITION_GAP);
	});

	it("appends to the end when dropped on the column (no over card)", () => {
		const ordered = cards(1000, 2000);
		expect(computeDropPosition(ordered, null, "dragged")).toBe(
			2000 + KANBAN_POSITION_GAP,
		);
	});

	it("inserts at the head when dropped on the first card", () => {
		const ordered = cards(1000, 2000); // ids c0, c1
		expect(computeDropPosition(ordered, "c0", "dragged")).toBe(
			1000 - KANBAN_POSITION_GAP,
		);
	});

	it("inserts at the midpoint between two cards", () => {
		const ordered = cards(1000, 2000, 3000); // c0,c1,c2
		// dropping onto c1 inserts before it → between c0 (1000) and c1 (2000).
		expect(computeDropPosition(ordered, "c1", "dragged")).toBe(1500);
	});

	it("excludes the dragged card so a within-column reorder uses real neighbours", () => {
		// Reorder c0 (pos 1000) to just before c2 (pos 3000): siblings become
		// [c1@2000, c2@3000]; dropping on c2 → midpoint of c1 and c2 = 2500.
		const ordered = cards(1000, 2000, 3000); // c0,c1,c2
		expect(computeDropPosition(ordered, "c2", "c0")).toBe(2500);
	});

	it("never returns the over-card's own slot when it equals the dragged card", () => {
		const ordered = cards(1000, 2000); // c0,c1
		// over === dragged → treated as append among the remaining sibling.
		expect(computeDropPosition(ordered, "c0", "c0")).toBe(
			2000 + KANBAN_POSITION_GAP,
		);
	});
});
