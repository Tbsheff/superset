import { ToggleGroup, ToggleGroupItem } from "@superset/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useEffect, useRef, useState } from "react";
import { Columns2, FoldVertical, Pin, Rows2 } from "lucide-react";
import type { DiffViewMode } from "shared/changes-types";
import type { FileViewerMode } from "shared/tabs-types";
import { PaneToolbarActions } from "../../../components";
import type { SplitOrientation } from "../../../hooks";

interface FileViewerToolbarProps {
	fileName: string;
	filePath: string;
	isDirty: boolean;
	viewMode: FileViewerMode;
	/** If false, this is a preview pane (italic name, can be replaced) */
	isPinned: boolean;
	/** Show Rendered tab (for markdown/images) */
	hasRenderedMode: boolean;
	/** Show Changes tab (when file has diff) */
	hasDiff: boolean;
	splitOrientation: SplitOrientation;
	diffViewMode: DiffViewMode;
	hideUnchangedRegions: boolean;
	onViewModeChange: (value: string) => void;
	onDiffViewModeChange: (mode: DiffViewMode) => void;
	onToggleHideUnchangedRegions: () => void;
	onSplitPane: (e: React.MouseEvent) => void;
	/** Pin this pane (convert from preview to permanent) */
	onPin: () => void;
	onClosePane: (e: React.MouseEvent) => void;
}

export function FileViewerToolbar({
	fileName,
	filePath,
	isDirty,
	viewMode,
	isPinned,
	hasRenderedMode,
	hasDiff,
	splitOrientation,
	diffViewMode,
	hideUnchangedRegions,
	onViewModeChange,
	onDiffViewModeChange,
	onToggleHideUnchangedRegions,
	onSplitPane,
	onPin,
	onClosePane,
}: FileViewerToolbarProps) {
	const [copied, setCopied] = useState(false);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		},
		[],
	);

	const handleCopyPath = () => {
		navigator.clipboard.writeText(filePath);
		setCopied(true);
		if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="flex h-full w-full items-center justify-between bg-muted/15 px-3">
			<div className="flex min-w-0 items-center gap-2">
				<Tooltip open={copied ? true : undefined}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleCopyPath}
							className={cn(
								"truncate font-mono text-xs text-muted-foreground/80 hover:text-foreground transition-colors text-left",
								!isPinned && "italic",
							)}
						>
							{isDirty && <span className="text-amber-500 mr-1">●</span>}
							{fileName}
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						{copied ? "Copied!" : "Click to copy path"}
					</TooltipContent>
				</Tooltip>
			</div>
			<div className="flex items-center gap-1 bg-muted/15 rounded-md px-1">
				<ToggleGroup
					type="single"
					value={viewMode}
					onValueChange={onViewModeChange}
					size="sm"
					className="h-6 bg-muted/30 rounded-md"
				>
					{hasRenderedMode && (
						<ToggleGroupItem
							value="rendered"
							className="h-6 px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:font-medium data-[state=on]:shadow-sm"
						>
							Rendered
						</ToggleGroupItem>
					)}
					<ToggleGroupItem
						value="raw"
						className="h-6 px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:font-medium data-[state=on]:shadow-sm"
					>
						Raw
					</ToggleGroupItem>
					{hasDiff && (
						<ToggleGroupItem
							value="diff"
							className="h-6 px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:font-medium data-[state=on]:shadow-sm"
						>
							Changes
						</ToggleGroupItem>
					)}
				</ToggleGroup>
				{viewMode === "diff" && (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() =>
										onDiffViewModeChange(
											diffViewMode === "side-by-side"
												? "inline"
												: "side-by-side",
										)
									}
									className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
								>
									{diffViewMode === "side-by-side" ? (
										<Columns2 className="size-3.5" />
									) : (
										<Rows2 className="size-3.5" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{diffViewMode === "side-by-side"
									? "Switch to inline diff"
									: "Switch to side by side diff"}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={onToggleHideUnchangedRegions}
									className={cn(
										"rounded p-0.5 transition-colors hover:text-muted-foreground",
										hideUnchangedRegions
											? "text-foreground"
											: "text-muted-foreground/50",
									)}
								>
									<FoldVertical className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{hideUnchangedRegions
									? "Show all lines"
									: "Hide unchanged regions"}
							</TooltipContent>
						</Tooltip>
					</>
				)}
				<PaneToolbarActions
					splitOrientation={splitOrientation}
					onSplitPane={onSplitPane}
					onClosePane={onClosePane}
					leadingActions={
						!isPinned ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={onPin}
										className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
									>
										<Pin className="size-3.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									Pin (keep open)
								</TooltipContent>
							</Tooltip>
						) : null
					}
				/>
			</div>
		</div>
	);
}
