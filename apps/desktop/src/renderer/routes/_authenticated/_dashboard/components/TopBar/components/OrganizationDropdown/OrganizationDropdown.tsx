import { COMPANY } from "@superset/shared/constants";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { Bug, Github, Keyboard } from "lucide-react";
import { FaDiscord, FaXTwitter } from "react-icons/fa6";
import {
	HiChevronUpDown,
	HiOutlineBookOpen,
	HiOutlineChatBubbleLeftRight,
	HiOutlineCog6Tooth,
	HiOutlineEnvelope,
} from "react-icons/hi2";
import { useHotkeyText } from "renderer/stores/hotkeys";

export function OrganizationDropdown() {
	const navigate = useNavigate();
	const settingsHotkey = useHotkeyText("OPEN_SETTINGS");
	const shortcutsHotkey = useHotkeyText("SHOW_HOTKEYS");

	function openExternal(url: string): void {
		window.open(url, "_blank");
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="no-drag flex items-center gap-1.5 h-6 px-1.5 rounded border border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border transition-all duration-150 ease-out focus:outline-none focus:ring-1 focus:ring-ring"
					aria-label="Menu"
				>
					<span className="text-xs font-medium truncate max-w-32">
						Superset
					</span>
					<HiChevronUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuItem
					onSelect={() => navigate({ to: "/settings/account" })}
				>
					<HiOutlineCog6Tooth className="h-4 w-4" />
					<span>Settings</span>
					{settingsHotkey !== "Unassigned" && (
						<DropdownMenuShortcut>{settingsHotkey}</DropdownMenuShortcut>
					)}
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				{/* Help & Support */}
				<DropdownMenuItem onClick={() => openExternal(COMPANY.DOCS_URL)}>
					<HiOutlineBookOpen className="h-4 w-4" />
					Documentation
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => navigate({ to: "/settings/keyboard" })}
				>
					<Keyboard className="h-4 w-4" />
					Keyboard Shortcuts
					{shortcutsHotkey !== "Unassigned" && (
						<DropdownMenuShortcut>{shortcutsHotkey}</DropdownMenuShortcut>
					)}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => openExternal(COMPANY.REPORT_ISSUE_URL)}
				>
					<Bug className="h-4 w-4" />
					Report Issue
				</DropdownMenuItem>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<HiOutlineChatBubbleLeftRight className="h-4 w-4" />
						Contact Us
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent sideOffset={8} className="w-56">
						<DropdownMenuItem onClick={() => openExternal(COMPANY.GITHUB_URL)}>
							<Github className="h-4 w-4" />
							GitHub
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openExternal(COMPANY.DISCORD_URL)}>
							<FaDiscord className="h-4 w-4" />
							Discord
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openExternal(COMPANY.X_URL)}>
							<FaXTwitter className="h-4 w-4" />X
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openExternal(COMPANY.MAIL_TO)}>
							<HiOutlineEnvelope className="h-4 w-4" />
							Email Founders
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
