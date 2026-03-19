/**
 * Click-to-move cursor for restty terminals.
 *
 * Translates mouse clicks into arrow key escape sequences to reposition
 * the cursor on the current prompt line.
 */

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = "\x1b[C";
const ARROW_LEFT = "\x1b[D";

export function setupClickToMoveCursor(opts: {
	container: HTMLElement;
	getCellDimensions: () => { width: number; height: number } | null;
	getCursorPosition: () => { col: number; row: number } | null;
	sendInput: (data: string) => void;
	isAlternateScreen: () => boolean;
}): () => void {
	const handleClick = (event: MouseEvent) => {
		// Don't interfere with full-screen apps (vim, less, etc.)
		if (opts.isAlternateScreen()) return;

		if (event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return;

		const cellDims = opts.getCellDimensions();
		if (!cellDims || cellDims.width <= 0 || cellDims.height <= 0) return;

		const cursorPos = opts.getCursorPosition();
		if (!cursorPos) return;

		const rect = opts.container.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		const clickCol = Math.floor(x / cellDims.width);
		const clickRow = Math.floor(y / cellDims.height);

		const deltaX = clickCol - cursorPos.col;
		const deltaY = clickRow - cursorPos.row;

		if (deltaX === 0 && deltaY === 0) return;

		let sequences = "";

		if (deltaY < 0) {
			sequences += ARROW_UP.repeat(-deltaY);
		} else if (deltaY > 0) {
			sequences += ARROW_DOWN.repeat(deltaY);
		}

		if (deltaX < 0) {
			sequences += ARROW_LEFT.repeat(-deltaX);
		} else if (deltaX > 0) {
			sequences += ARROW_RIGHT.repeat(deltaX);
		}

		if (sequences) {
			opts.sendInput(sequences);
		}
	};

	opts.container.addEventListener("click", handleClick);

	return () => {
		opts.container.removeEventListener("click", handleClick);
	};
}
