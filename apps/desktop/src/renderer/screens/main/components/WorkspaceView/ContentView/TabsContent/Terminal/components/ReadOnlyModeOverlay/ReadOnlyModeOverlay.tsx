import { Card } from "@superset/ui/card";
import { LuEye } from "react-icons/lu";

/**
 * Non-blocking badge shown when a terminal pane is driven by a streaming-command
 * runtime that has no interactive shell. Keystrokes are dropped (gated in
 * useTerminalLifecycle); this badge tells the user why.
 */
export function ReadOnlyModeOverlay() {
	return (
		<div className="pointer-events-none absolute right-2 top-2 z-10">
			<Card className="flex flex-row items-center gap-1.5 px-2 py-1">
				<LuEye className="size-3.5 text-muted-foreground" />
				<span className="text-xs text-muted-foreground select-text cursor-text">
					Read-only (log) — this runtime does not support an interactive shell
				</span>
			</Card>
		</div>
	);
}
