import type { RuntimeDiff } from "../../seam/index.ts";

interface FileState {
	working: string | null;
	staged: string | null;
	committed: string | null;
}

/**
 * Minimal in-memory working tree with a staging area, enough to back the
 * filesystem/diff/persistence contracts. It is NOT a git implementation — it
 * tracks working vs staged vs committed content per path and renders a
 * git-shaped porcelain status + unified patch so the fakes satisfy the same
 * RuntimeDiff contract the real (Phase D) collector will.
 */
export class InMemoryFs {
	private files = new Map<string, FileState>();

	private ensure(path: string): FileState {
		let state = this.files.get(path);
		if (!state) {
			state = { working: null, staged: null, committed: null };
			this.files.set(path, state);
		}
		return state;
	}

	write(path: string, contents: string): void {
		this.ensure(path).working = contents;
	}

	remove(path: string): void {
		const state = this.files.get(path);
		if (state) state.working = null;
	}

	stage(path: string): void {
		const state = this.ensure(path);
		state.staged = state.working;
	}

	snapshot(): Map<string, FileState> {
		const copy = new Map<string, FileState>();
		for (const [path, state] of this.files) {
			copy.set(path, { ...state });
		}
		return copy;
	}

	restore(snapshot: Map<string, FileState>): void {
		this.files = new Map();
		for (const [path, state] of snapshot) {
			this.files.set(path, { ...state });
		}
	}

	clear(): void {
		this.files = new Map();
	}

	diff(staged: boolean): RuntimeDiff {
		const statusLines: string[] = [];
		const patchParts: string[] = [];

		for (const [path, state] of [...this.files].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			const before = staged
				? state.committed
				: (state.staged ?? state.committed);
			const after = staged ? state.staged : state.working;
			if (before === after) continue;

			const code =
				before === null ? "A " : after === null ? "D " : staged ? "M " : " M";
			statusLines.push(`${code} ${path}`);
			patchParts.push(renderUnifiedPatch(path, before, after));
		}

		return {
			statusPorcelain: statusLines.join("\n"),
			unifiedPatch: patchParts.join("\n"),
		};
	}
}

function renderUnifiedPatch(
	path: string,
	before: string | null,
	after: string | null,
): string {
	const header = `diff --git a/${path} b/${path}`;
	const beforeLines = before === null ? [] : before.split("\n");
	const afterLines = after === null ? [] : after.split("\n");
	const body = [
		...beforeLines.map((line) => `-${line}`),
		...afterLines.map((line) => `+${line}`),
	].join("\n");
	return `${header}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${body}`;
}
