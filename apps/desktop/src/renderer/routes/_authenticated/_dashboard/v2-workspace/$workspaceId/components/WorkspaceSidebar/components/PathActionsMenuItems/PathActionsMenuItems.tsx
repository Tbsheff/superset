import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "@superset/ui/context-menu";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Clipboard, Copy, FolderOpen } from "lucide-react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useIsRemoteWorkspace } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useIsRemoteWorkspace";

interface PathActionsMenuItemsProps {
	absolutePath: string;
	relativePath?: string;
	menuType?: "context" | "dropdown";
	workspaceId?: string;
}

export function PathActionsMenuItems({
	absolutePath,
	relativePath,
	menuType = "context",
	workspaceId,
}: PathActionsMenuItemsProps) {
	const { copyToClipboard } = useCopyToClipboard();
	// Remote workspaces have no host file to reveal; Copy actions still apply.
	const isRemote = useIsRemoteWorkspace(workspaceId);

	const handleCopy = (path: string, successMessage: string) => {
		toast.promise(copyToClipboard(path), {
			success: successMessage,
			error: (err: unknown) =>
				`Failed to copy path: ${err instanceof Error ? err.message : "Unknown error"}`,
		});
	};

	const handleRevealInFinder = async () => {
		try {
			await electronTrpcClient.external.openInFinder.mutate(absolutePath);
		} catch (error) {
			toast.error(
				`Failed to reveal in Finder: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	if (menuType === "dropdown") {
		return (
			<>
				{!isRemote && (
					<>
						<DropdownMenuItem onSelect={handleRevealInFinder}>
							<FolderOpen />
							Reveal in Finder
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem
					onSelect={() => handleCopy(absolutePath, "Path copied")}
				>
					<Clipboard />
					Copy Path
				</DropdownMenuItem>
				{relativePath && (
					<DropdownMenuItem
						onSelect={() => handleCopy(relativePath, "Relative path copied")}
					>
						<Copy />
						Copy Relative Path
					</DropdownMenuItem>
				)}
			</>
		);
	}

	return (
		<>
			{!isRemote && (
				<>
					<ContextMenuItem onSelect={handleRevealInFinder}>
						<FolderOpen />
						Reveal in Finder
					</ContextMenuItem>
					<ContextMenuSeparator />
				</>
			)}
			<ContextMenuItem onSelect={() => handleCopy(absolutePath, "Path copied")}>
				<Clipboard />
				Copy Path
			</ContextMenuItem>
			{relativePath && (
				<ContextMenuItem
					onSelect={() => handleCopy(relativePath, "Relative path copied")}
				>
					<Copy />
					Copy Relative Path
				</ContextMenuItem>
			)}
		</>
	);
}
