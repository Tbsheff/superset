import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useRef } from "react";

interface ResizablePanelProps {
	/** The content to render inside the panel */
	children: React.ReactNode;
	/** Current width of the panel */
	width: number;
	/** Callback when width changes */
	onWidthChange: (width: number) => void;
	/** Whether the panel is currently being resized */
	isResizing: boolean;
	/** Callback when resizing state changes */
	onResizingChange: (isResizing: boolean) => void;
	/** Minimum allowed width (used for clamping and aria) */
	minWidth: number;
	/** Maximum allowed width (used for clamping and aria) */
	maxWidth: number;
	/** Which side the resize handle should be on */
	handleSide: "left" | "right";
	/** Additional className for the container */
	className?: string;
	/**
	 * If true, the component will clamp width between minWidth and maxWidth.
	 * If false, raw width values are passed to onWidthChange (useful when the
	 * consumer's setWidth handles clamping/snapping logic).
	 * @default true
	 */
	clampWidth?: boolean;
	/** Callback when the resize handle is double-clicked */
	onDoubleClickHandle?: () => void;
}

export function ResizablePanel({
	children,
	width,
	onWidthChange,
	isResizing,
	onResizingChange,
	minWidth,
	maxWidth,
	handleSide,
	className,
	clampWidth = true,
	onDoubleClickHandle,
}: ResizablePanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const latestWidthRef = useRef(width);
	const rafIdRef = useRef<number | null>(null);

	// Keep latestWidthRef in sync with prop when not dragging
	if (!isResizing) {
		latestWidthRef.current = width;
	}

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			startXRef.current = e.clientX;
			startWidthRef.current = width;
			onResizingChange(true);
		},
		[width, onResizingChange],
	);

	const handleMouseMove = useCallback(
		(e: MouseEvent) => {
			const delta = e.clientX - startXRef.current;
			const adjustedDelta = handleSide === "left" ? -delta : delta;
			const newWidth = startWidthRef.current + adjustedDelta;
			const finalWidth = clampWidth
				? Math.max(minWidth, Math.min(maxWidth, newWidth))
				: newWidth;
			latestWidthRef.current = finalWidth;

			if (rafIdRef.current !== null) return;
			rafIdRef.current = requestAnimationFrame(() => {
				rafIdRef.current = null;
				// Apply directly to DOM — bypasses React for smooth 60fps resize
				if (containerRef.current) {
					containerRef.current.style.width = `${latestWidthRef.current}px`;
				}
			});
		},
		[minWidth, maxWidth, handleSide, clampWidth],
	);

	const handleMouseUp = useCallback(() => {
		if (rafIdRef.current !== null) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		}
		// Commit final width to React state in a single update
		onWidthChange(latestWidthRef.current);
		onResizingChange(false);
	}, [onWidthChange, onResizingChange]);

	useEffect(() => {
		if (isResizing) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
		};
	}, [isResizing, handleMouseMove, handleMouseUp]);

	return (
		<div
			ref={containerRef}
			className={cn(
				"relative h-full shrink-0 overflow-hidden border-border/40",
				handleSide === "right" ? "border-r" : "border-l",
				className,
			)}
			style={{ width }}
		>
			{children}
			{/* biome-ignore lint/a11y/useSemanticElements: <hr> is not appropriate for interactive resize handles */}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-valuenow={width}
				aria-valuemin={minWidth}
				aria-valuemax={maxWidth}
				tabIndex={0}
				onMouseDown={handleMouseDown}
				onDoubleClick={onDoubleClickHandle}
				className={cn(
					"absolute top-0 w-5 h-full cursor-col-resize z-10",
					"after:absolute after:top-0 after:w-1 after:h-full after:transition-colors",
					"hover:after:bg-border focus:outline-none focus:after:bg-border",
					isResizing && "after:bg-border",
					handleSide === "left"
						? "-left-2 after:right-2"
						: "-right-2 after:left-2",
				)}
			/>
		</div>
	);
}
