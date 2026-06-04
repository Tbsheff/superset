import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useState } from "react";
import { LuExternalLink, LuLoaderCircle, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { navigateToV2Workspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { STROKE_WIDTH } from "renderer/screens/main/components/WorkspaceSidebar/constants";
import { useDashboardSidebarPortKill } from "../../hooks/useDashboardSidebarPortKill";
import type { DashboardSidebarPort } from "../../hooks/useDashboardSidebarPortsData";

/**
 * Resolves the URL to open for a port. A remote workspace's dev server isn't on
 * the host network, so the host-service `exposePreview` mints a tokenized origin
 * for it; local workspaces resolve to `http://localhost:port`. Falls back to
 * localhost if the host URL or procedure is unavailable.
 */
async function resolvePreviewUrl(port: DashboardSidebarPort): Promise<string> {
	const fallback = `http://localhost:${port.port}`;
	if (!port.hostUrl) return fallback;
	try {
		const result = await getHostServiceClientByUrl(
			port.hostUrl,
		).ports.exposePreview.mutate({
			workspaceId: port.workspaceId,
			port: port.port,
		});
		return result.url || fallback;
	} catch {
		return fallback;
	}
}

interface DashboardSidebarPortBadgeProps {
	port: DashboardSidebarPort;
}

export function DashboardSidebarPortBadge({
	port,
}: DashboardSidebarPortBadgeProps) {
	const navigate = useNavigate();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const { isPending, killPort } = useDashboardSidebarPortKill();
	const [isResolvingPreview, setIsResolvingPreview] = useState(false);
	const canOpenInBrowser =
		port.hostType === "local-device" || Boolean(port.hostUrl);
	const hostLabel =
		port.hostType === "local-device" ? "Local device" : "Remote host";

	const handleWorkspaceClick = () => {
		void navigateToV2Workspace(port.workspaceId, navigate, {
			search: {
				terminalId: port.terminalId,
				focusRequestId: crypto.randomUUID(),
			},
		});
	};

	const handleOpenInBrowser = (event: MouseEvent<HTMLButtonElement>) => {
		if (!canOpenInBrowser || isResolvingPreview) return;

		// Hardcoded modifier rule — this is an explicit "open in browser"
		// affordance, not a configurable file row, so it shouldn't pick up
		// whatever the user mapped sidebar files to.
		const openInSystemBrowser = event.metaKey || event.ctrlKey;
		const openUrlTarget = event.shiftKey ? "new-tab" : "current-tab";
		if (openInSystemBrowser && openUrl.isPending) return;

		setIsResolvingPreview(true);
		void resolvePreviewUrl(port)
			.then((url) => {
				if (openInSystemBrowser) {
					openUrl.mutate(url);
					return;
				}
				return navigateToV2Workspace(port.workspaceId, navigate, {
					search: {
						openUrl: url,
						openUrlTarget,
						openUrlRequestId: crypto.randomUUID(),
					},
				});
			})
			.finally(() => setIsResolvingPreview(false));
	};

	const handleClose = () => {
		if (isPending) return;
		void killPort(port);
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className={cn(
						"group relative mb-1 inline-flex max-w-full items-center gap-1 rounded-md",
						"bg-primary/10 text-xs text-primary transition-colors hover:bg-primary/20",
						isPending && "opacity-70",
					)}
				>
					<button
						type="button"
						onClick={handleWorkspaceClick}
						className="flex max-w-40 min-w-0 items-center gap-1 rounded-md px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						{port.label ? (
							<>
								<span className="min-w-0 truncate">{port.label}</span>
								<span className="shrink-0 font-mono font-normal text-muted-foreground">
									{port.port}
								</span>
							</>
						) : (
							<span className="font-mono text-muted-foreground">
								{port.port}
							</span>
						)}
					</button>
					{canOpenInBrowser && (
						<button
							type="button"
							onClick={handleOpenInBrowser}
							disabled={openUrl.isPending || isResolvingPreview}
							aria-busy={isResolvingPreview}
							aria-label={`Open ${port.label || `port ${port.port}`} in browser`}
							className="text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
						>
							{isResolvingPreview ? (
								<LuLoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={STROKE_WIDTH}
								/>
							) : (
								<LuExternalLink
									className="size-3.5"
									strokeWidth={STROKE_WIDTH}
								/>
							)}
						</button>
					)}
					<button
						type="button"
						onClick={handleClose}
						disabled={isPending}
						aria-busy={isPending}
						aria-label={`Close ${port.label || `port ${port.port}`}`}
						className="pr-1 text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-70 group-hover:opacity-100"
					>
						{isPending ? (
							<LuLoaderCircle
								className="size-3.5 animate-spin"
								strokeWidth={STROKE_WIDTH}
							/>
						) : (
							<LuX className="size-3.5" strokeWidth={STROKE_WIDTH} />
						)}
					</button>
				</div>
			</TooltipTrigger>
			<TooltipContent side="top" sideOffset={6} showArrow={false}>
				<div className="space-y-1 text-xs">
					{port.label && <div className="font-medium">{port.label}</div>}
					<div
						className={`font-mono ${port.label ? "text-muted-foreground" : "font-medium"}`}
					>
						localhost:{port.port}
					</div>
					<div className="text-muted-foreground">{hostLabel}</div>
					{(port.processName || port.pid != null) && (
						<div className="text-muted-foreground">
							{port.processName}
							{port.pid != null && ` (pid ${port.pid})`}
						</div>
					)}
					{!canOpenInBrowser && (
						<div className="text-[10px] text-muted-foreground/70">
							Browser open unavailable from this device
						</div>
					)}
					<div className="text-[10px] text-muted-foreground/70">
						Click to open workspace
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
