import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";

export function SettingsButton() {
	const navigate = useNavigate();

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => navigate({ to: "/settings/account" })}
					aria-label="Open settings"
					className="no-drag"
				>
					<Settings className="size-5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom" sideOffset={8}>
				<HotkeyTooltipContent label="Open settings" hotkeyId="OPEN_SETTINGS" />
			</TooltipContent>
		</Tooltip>
	);
}
