import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import {
	Expand,
	File,
	GitCompareArrows,
	Shrink,
	X,
} from "lucide-react";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	RightSidebarTab,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { ChangeCategory, ChangedFile } from "shared/changes-types";
import { useScrollContext } from "../ChangesContent";
import { ChangesView } from "./ChangesView";
import { FilesView } from "./FilesView";

function TabButton({
	isActive,
	onClick,
	icon,
	label,
	compact,
}: {
	isActive: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	compact?: boolean;
}) {
	if (compact) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={onClick}
						className={cn(
							"flex items-center justify-center shrink-0 h-7 my-1 w-10 rounded-md transition-all",
							isActive
								? "text-foreground bg-accent/60 border-b-2 border-primary"
								: "text-muted-foreground/70 hover:text-muted-foreground hover:bg-accent/30",
						)}
					>
						{icon}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					{label}
				</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex items-center gap-2 shrink-0 px-3 h-8 my-1 rounded-md transition-all text-sm",
				isActive
					? "text-foreground bg-accent/60 border-b-2 border-primary"
					: "text-muted-foreground/70 hover:text-muted-foreground hover:bg-accent/30",
			)}
		>
			{icon}
			{label}
		</button>
	);
}

export function RightSidebar() {
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const worktreePath = workspace?.worktreePath;
	const currentMode = useSidebarStore((s) => s.currentMode);
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const rightSidebarTab = useSidebarStore((s) => s.rightSidebarTab);
	const setRightSidebarTab = useSidebarStore((s) => s.setRightSidebarTab);
	const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);
	const setMode = useSidebarStore((s) => s.setMode);
	const sidebarWidth = useSidebarStore((s) => s.sidebarWidth);
	const isExpanded = currentMode === SidebarMode.Changes;
	const compactTabs = sidebarWidth < 250;
	const showChangesTab = !!worktreePath;

	const handleExpandToggle = () => {
		setMode(isExpanded ? SidebarMode.Tabs : SidebarMode.Changes);
	};

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const trpcUtils = electronTrpc.useUtils();
	const { scrollToFile } = useScrollContext();

	const invalidateFileContent = useCallback(
		(absolutePath: string) => {
			if (!worktreePath) return;

			Promise.all([
				trpcUtils.changes.readWorkingFile.invalidate({
					worktreePath,
					absolutePath,
				}),
				trpcUtils.changes.getFileContents.invalidate({
					worktreePath,
					absolutePath,
				}),
			]).catch((error) => {
				console.error(
					"[RightSidebar/invalidateFileContent] Failed to invalidate file content queries:",
					{ worktreePath, absolutePath, error },
				);
			});
		},
		[worktreePath, trpcUtils],
	);

	const handleFileOpenPane = useCallback(
		(file: ChangedFile, category: ChangeCategory, commitHash?: string) => {
			if (!workspaceId || !worktreePath) return;
			const absolutePath = toAbsoluteWorkspacePath(worktreePath, file.path);
			addFileViewerPane(workspaceId, {
				filePath: absolutePath,
				diffCategory: category,
				fileStatus: file.status,
				commitHash,
				oldPath: file.oldPath
					? toAbsoluteWorkspacePath(worktreePath, file.oldPath)
					: undefined,
			});
			invalidateFileContent(absolutePath);
		},
		[workspaceId, worktreePath, addFileViewerPane, invalidateFileContent],
	);

	const handleFileScrollTo = useCallback(
		(file: ChangedFile, category: ChangeCategory, commitHash?: string) => {
			scrollToFile(file, category, commitHash, worktreePath);
		},
		[scrollToFile, worktreePath],
	);

	const handleFileOpen =
		workspaceId && worktreePath
			? isExpanded
				? handleFileScrollTo
				: handleFileOpenPane
			: undefined;

	return (
		<aside className="h-full flex flex-col overflow-hidden">
			<div className="flex items-center bg-tertiary shrink-0 h-9 border-b border-border/25">
				<div className="flex items-center gap-0.5 px-1 h-full">
					{showChangesTab && (
						<TabButton
							isActive={isSidebarOpen && rightSidebarTab === RightSidebarTab.Changes}
							onClick={() => setRightSidebarTab(RightSidebarTab.Changes)}
							icon={<GitCompareArrows className="size-3.5" />}
							label="Changes"
							compact={compactTabs}
						/>
					)}
					<TabButton
						isActive={rightSidebarTab === RightSidebarTab.Files}
						onClick={() => setRightSidebarTab(RightSidebarTab.Files)}
						icon={<File className="size-3.5" />}
						label="Files"
						compact={compactTabs}
					/>
				</div>
				<div className="flex-1" />
				<div className="flex items-center h-9 pr-2 gap-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleExpandToggle}
								className="size-6 p-0"
								title={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
							>
								{isExpanded ? (
									<Shrink className="size-3.5" />
								) : (
									<Expand className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
								hotkeyId="TOGGLE_EXPAND_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={toggleSidebar}
								className="size-6 p-0"
								title="Close sidebar"
							>
								<X className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label="Close sidebar"
								hotkeyId="TOGGLE_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
				</div>
			</div>
			{showChangesTab && (
				<div
					className={
						rightSidebarTab === RightSidebarTab.Changes
							? "flex-1 min-h-0 flex flex-col overflow-hidden"
							: "hidden"
					}
				>
					<ChangesView
						onFileOpen={handleFileOpen}
						isExpandedView={isExpanded}
						isActive={isSidebarOpen && rightSidebarTab === RightSidebarTab.Changes}
					/>
				</div>
			)}
			<div
				className={
					rightSidebarTab === RightSidebarTab.Changes && showChangesTab
						? "hidden"
						: "flex-1 min-h-0 flex flex-col overflow-hidden"
				}
			>
				<FilesView />
			</div>
		</aside>
	);
}
