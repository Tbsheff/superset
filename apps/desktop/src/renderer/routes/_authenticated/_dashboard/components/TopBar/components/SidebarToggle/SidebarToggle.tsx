import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { PanelLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";
import { useWorkspaceSidebarStore } from "renderer/stores";

export function SidebarToggle() {
	const isCollapsed = useWorkspaceSidebarStore((s) => s.isCollapsed);
	const toggleCollapsed = useWorkspaceSidebarStore((s) => s.toggleCollapsed);
	const collapsed = isCollapsed();

	const getToggleIcon = (isHovering: boolean) => {
		if (collapsed) {
			return isHovering ? (
				<PanelLeftOpen className="size-4" strokeWidth={1.5} />
			) : (
				<PanelLeft className="size-4" strokeWidth={1.5} />
			);
		}
		return isHovering ? (
			<PanelLeftClose className="size-4" strokeWidth={1.5} />
		) : (
			<PanelLeft className="size-4" strokeWidth={1.5} />
		);
	};

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={toggleCollapsed}
					className="no-drag group flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
				>
					<span className="group-hover:hidden">{getToggleIcon(false)}</span>
					<span className="hidden group-hover:block">
						{getToggleIcon(true)}
					</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="right">
				<HotkeyTooltipContent
					label="Toggle sidebar"
					hotkeyId="TOGGLE_WORKSPACE_SIDEBAR"
				/>
			</TooltipContent>
		</Tooltip>
	);
}
