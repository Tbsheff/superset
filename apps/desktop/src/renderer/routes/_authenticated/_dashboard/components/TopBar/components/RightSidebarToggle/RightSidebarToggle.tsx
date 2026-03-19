import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPanelRight } from "react-icons/lu";
import { useSidebarStore } from "renderer/stores";

export function RightSidebarToggle() {
	const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={toggleSidebar}
					className="no-drag flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
					aria-label="Toggle sidebar"
				>
					<LuPanelRight className="size-4" strokeWidth={1.5} />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">Toggle sidebar</TooltipContent>
		</Tooltip>
	);
}
