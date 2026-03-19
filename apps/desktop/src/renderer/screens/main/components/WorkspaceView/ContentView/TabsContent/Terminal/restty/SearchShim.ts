import type { RenderState } from "restty/internal";

export type SearchOptions = {
	caseSensitive?: boolean;
	regex?: boolean;
};

export type SearchMatch = {
	row: number;
	col: number;
	length: number;
};

export type SearchResult = {
	row: number;
	col: number;
	length: number;
	matchIndex: number;
	totalMatches: number;
};

/**
 * Extracts visible text from a restty RenderState and provides
 * string/regex search with match navigation.
 *
 * Operates on the current viewport snapshot — scrollback search
 * can be added later via WASM scroll APIs.
 */
export class SearchShim {
	private getRenderState: () => RenderState | null;
	private matches: SearchMatch[] = [];
	private currentIndex = -1;
	private lastTerm = "";
	private lastOptions: SearchOptions = {};

	constructor(getRenderState: () => RenderState | null) {
		this.getRenderState = getRenderState;
	}

	get matchCount(): number {
		return this.matches.length;
	}

	get currentMatchIndex(): number {
		return this.currentIndex;
	}

	get allMatches(): readonly SearchMatch[] {
		return this.matches;
	}

	findNext(term: string, options?: SearchOptions): SearchResult | null {
		if (!term) {
			this.clearSearch();
			return null;
		}

		const optionsChanged =
			term !== this.lastTerm ||
			options?.caseSensitive !== this.lastOptions.caseSensitive ||
			options?.regex !== this.lastOptions.regex;

		if (optionsChanged) {
			this.rebuildMatches(term, options);
		}

		if (this.matches.length === 0) return null;

		this.currentIndex =
			this.currentIndex < this.matches.length - 1 ? this.currentIndex + 1 : 0;

		return this.currentResult();
	}

	findPrevious(term: string, options?: SearchOptions): SearchResult | null {
		if (!term) {
			this.clearSearch();
			return null;
		}

		const optionsChanged =
			term !== this.lastTerm ||
			options?.caseSensitive !== this.lastOptions.caseSensitive ||
			options?.regex !== this.lastOptions.regex;

		if (optionsChanged) {
			this.rebuildMatches(term, options);
		}

		if (this.matches.length === 0) return null;

		this.currentIndex =
			this.currentIndex > 0 ? this.currentIndex - 1 : this.matches.length - 1;

		return this.currentResult();
	}

	clearSearch(): void {
		this.matches = [];
		this.currentIndex = -1;
		this.lastTerm = "";
		this.lastOptions = {};
	}

	// -- internal --

	private rebuildMatches(term: string, options?: SearchOptions): void {
		this.lastTerm = term;
		this.lastOptions = { ...options };
		this.matches = [];
		this.currentIndex = -1;

		const state = this.getRenderState();
		if (!state?.codepoints) return;

		const {
			rows,
			cols,
			codepoints,
			graphemeOffset,
			graphemeLen,
			graphemeBuffer,
		} = state;

		for (let row = 0; row < rows; row++) {
			const rowText = this.extractRowText(
				row,
				cols,
				codepoints,
				graphemeOffset,
				graphemeLen,
				graphemeBuffer,
			);

			this.findMatchesInRow(row, rowText, term, options);
		}
	}

	/**
	 * Extract text for a single row, handling grapheme clusters.
	 *
	 * Each cell in the grid stores a single codepoint. Multi-codepoint
	 * graphemes (emoji ZWJ sequences, combining marks) use the grapheme
	 * side-tables: graphemeOffset[cell] gives the start index into
	 * graphemeBuffer, and graphemeLen[cell] gives the number of codepoints.
	 *
	 * A codepoint of 0 means an empty/padding cell (e.g. the trailing
	 * cell of a wide character) — we skip those to avoid injecting
	 * null characters into the search text.
	 */
	private extractRowText(
		row: number,
		cols: number,
		codepoints: Uint32Array,
		graphemeOffset: Uint32Array | null,
		graphemeLen: Uint32Array | null,
		graphemeBuffer: Uint32Array | null,
	): string {
		const base = row * cols;
		let text = "";

		for (let col = 0; col < cols; col++) {
			const idx = base + col;
			const cp = codepoints[idx]!;

			// Check for multi-codepoint grapheme cluster
			if (
				graphemeOffset &&
				graphemeLen &&
				graphemeBuffer &&
				graphemeLen[idx]! > 0
			) {
				const offset = graphemeOffset[idx]!;
				const len = graphemeLen[idx]!;
				for (let g = 0; g < len; g++) {
					text += String.fromCodePoint(graphemeBuffer[offset + g]!);
				}
			} else if (cp !== 0) {
				text += String.fromCodePoint(cp);
			}
		}

		// Trim trailing whitespace to avoid matching spaces that are
		// just empty cells at the end of a row
		return text.trimEnd();
	}

	private findMatchesInRow(
		row: number,
		rowText: string,
		term: string,
		options?: SearchOptions,
	): void {
		const caseSensitive = options?.caseSensitive ?? false;
		const useRegex = options?.regex ?? false;

		if (useRegex) {
			this.findRegexMatches(row, rowText, term, caseSensitive);
		} else {
			this.findStringMatches(row, rowText, term, caseSensitive);
		}
	}

	private findStringMatches(
		row: number,
		rowText: string,
		term: string,
		caseSensitive: boolean,
	): void {
		const haystack = caseSensitive ? rowText : rowText.toLowerCase();
		const needle = caseSensitive ? term : term.toLowerCase();

		if (!needle) return;

		let offset = 0;
		while (true) {
			const idx = haystack.indexOf(needle, offset);
			if (idx === -1) break;

			this.matches.push({
				row,
				col: idx,
				length: needle.length,
			});

			// Advance by 1 to find overlapping matches
			offset = idx + 1;
		}
	}

	private findRegexMatches(
		row: number,
		rowText: string,
		term: string,
		caseSensitive: boolean,
	): void {
		let re: RegExp;
		try {
			re = new RegExp(term, caseSensitive ? "g" : "gi");
		} catch {
			// Invalid regex — treat as no matches
			return;
		}

		let match: RegExpExecArray | null = re.exec(rowText);
		while (match !== null) {
			if (match[0].length === 0) {
				// Avoid infinite loop on zero-length matches
				re.lastIndex++;
				match = re.exec(rowText);
				continue;
			}

			this.matches.push({
				row,
				col: match.index,
				length: match[0].length,
			});
			match = re.exec(rowText);
		}
	}

	private currentResult(): SearchResult {
		const m = this.matches[this.currentIndex]!;
		return {
			...m,
			matchIndex: this.currentIndex,
			totalMatches: this.matches.length,
		};
	}
}
