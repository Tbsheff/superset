import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useState } from "react";
import { HiArrowDown } from "react-icons/hi2";
import { useHotkeyText } from "renderer/stores/hotkeys";
import type { ResttyAdapter } from "../restty/ResttyAdapter";
import { scrollToBottom } from "../utils";

interface ScrollToBottomButtonProps {
	adapter: ResttyAdapter | null;
}

export function ScrollToBottomButton({ adapter }: ScrollToBottomButtonProps) {
	const [isVisible, setIsVisible] = useState(false);
	const shortcutText = useHotkeyText("SCROLL_TO_BOTTOM");
	const showShortcut = shortcutText !== "Unassigned";

	const checkScrollPosition = useCallback(() => {
		if (!adapter) return;
		const isAtBottom = adapter.isAtBottom();
		setIsVisible(!isAtBottom);
	}, [adapter]);

	useEffect(() => {
		if (!adapter) return;

		checkScrollPosition();

		const writeDisposable = adapter.onWriteParsed(checkScrollPosition);
		const scrollDisposable = adapter.onScroll(checkScrollPosition);

		return () => {
			writeDisposable.dispose();
			scrollDisposable.dispose();
		};
	}, [adapter, checkScrollPosition]);

	const handleClick = () => {
		if (adapter) {
			scrollToBottom(adapter);
		}
	};

	return (
		<div
			className={cn(
				"absolute bottom-4 left-1/2 z-10 -translate-x-1/2 transition-all duration-200",
				isVisible
					? "translate-y-0 opacity-100"
					: "pointer-events-none translate-y-2 opacity-0",
			)}
		>
			<Tooltip delayDuration={500}>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={handleClick}
						className="flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<HiArrowDown className="size-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="left">
					Scroll to bottom{showShortcut && ` (${shortcutText})`}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
