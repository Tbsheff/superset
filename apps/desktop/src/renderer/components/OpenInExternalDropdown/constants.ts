import type { ExternalApp } from "@superset/local-db";

// Icons served from the public directory (not inlined into the JS bundle).
// Public dir is apps/desktop/src/resources/public/, served at root "/".
const antigravityIcon = "/app-icons/antigravity.svg";
const appcodeIcon = "/app-icons/appcode.svg";
const clionIcon = "/app-icons/clion.svg";
const cursorIcon = "/app-icons/cursor.svg";
const datagripIcon = "/app-icons/datagrip.svg";
const finderIcon = "/app-icons/finder.png";
const fleetIcon = "/app-icons/fleet.svg";
const ghosttyIcon = "/app-icons/ghostty.svg";
const golandIcon = "/app-icons/goland.svg";
const intellijIcon = "/app-icons/intellij.svg";
const itermIcon = "/app-icons/iterm.png";
const phpstormIcon = "/app-icons/phpstorm.svg";
const pycharmIcon = "/app-icons/pycharm.svg";
const riderIcon = "/app-icons/rider.svg";
const rubymineIcon = "/app-icons/rubymine.svg";
const rustroverIcon = "/app-icons/rustrover.svg";
const sublimeIcon = "/app-icons/sublime.svg";
const terminalIcon = "/app-icons/terminal.png";
const vscodeIcon = "/app-icons/vscode.svg";
const vscodeInsidersIcon = "/app-icons/vscode-insiders.svg";
const warpIcon = "/app-icons/warp.png";
const webstormIcon = "/app-icons/webstorm.svg";
const windsurfIcon = "/app-icons/windsurf.svg";
const windsurfWhiteIcon = "/app-icons/windsurf-white.svg";
const xcodeIcon = "/app-icons/xcode.svg";
const zedIcon = "/app-icons/zed.png";

export interface OpenInExternalAppOption {
	id: ExternalApp;
	label: string;
	lightIcon: string;
	darkIcon: string;
	displayLabel?: string;
}

export const FINDER_OPTIONS: OpenInExternalAppOption[] = [
	{
		id: "finder",
		label: "Finder",
		lightIcon: finderIcon,
		darkIcon: finderIcon,
	},
];

export const IDE_OPTIONS: OpenInExternalAppOption[] = [
	{
		id: "cursor",
		label: "Cursor",
		lightIcon: cursorIcon,
		darkIcon: cursorIcon,
	},
	{
		id: "antigravity",
		label: "Antigravity",
		lightIcon: antigravityIcon,
		darkIcon: antigravityIcon,
	},
	{
		id: "windsurf",
		label: "Windsurf",
		lightIcon: windsurfIcon,
		darkIcon: windsurfWhiteIcon,
	},
	{ id: "zed", label: "Zed", lightIcon: zedIcon, darkIcon: zedIcon },
	{
		id: "sublime",
		label: "Sublime Text",
		lightIcon: sublimeIcon,
		darkIcon: sublimeIcon,
	},
	{ id: "xcode", label: "Xcode", lightIcon: xcodeIcon, darkIcon: xcodeIcon },
];

export const TERMINAL_OPTIONS: OpenInExternalAppOption[] = [
	{ id: "iterm", label: "iTerm", lightIcon: itermIcon, darkIcon: itermIcon },
	{ id: "warp", label: "Warp", lightIcon: warpIcon, darkIcon: warpIcon },
	{
		id: "terminal",
		label: "Terminal",
		lightIcon: terminalIcon,
		darkIcon: terminalIcon,
	},
	{
		id: "ghostty",
		label: "Ghostty",
		lightIcon: ghosttyIcon,
		darkIcon: ghosttyIcon,
	},
];

export const APP_OPTIONS: OpenInExternalAppOption[] = [
	...FINDER_OPTIONS,
	...IDE_OPTIONS,
	...TERMINAL_OPTIONS,
];

export const VSCODE_OPTIONS: OpenInExternalAppOption[] = [
	{
		id: "vscode",
		label: "Standard",
		lightIcon: vscodeIcon,
		darkIcon: vscodeIcon,
		displayLabel: "VS Code",
	},
	{
		id: "vscode-insiders",
		label: "Insiders",
		lightIcon: vscodeInsidersIcon,
		darkIcon: vscodeInsidersIcon,
		displayLabel: "VS Code Insiders",
	},
];

export const JETBRAINS_OPTIONS: OpenInExternalAppOption[] = [
	{
		id: "intellij",
		label: "IntelliJ IDEA",
		lightIcon: intellijIcon,
		darkIcon: intellijIcon,
	},
	{
		id: "webstorm",
		label: "WebStorm",
		lightIcon: webstormIcon,
		darkIcon: webstormIcon,
	},
	{
		id: "pycharm",
		label: "PyCharm",
		lightIcon: pycharmIcon,
		darkIcon: pycharmIcon,
	},
	{
		id: "phpstorm",
		label: "PhpStorm",
		lightIcon: phpstormIcon,
		darkIcon: phpstormIcon,
	},
	{
		id: "rubymine",
		label: "RubyMine",
		lightIcon: rubymineIcon,
		darkIcon: rubymineIcon,
	},
	{
		id: "goland",
		label: "GoLand",
		lightIcon: golandIcon,
		darkIcon: golandIcon,
	},
	{ id: "clion", label: "CLion", lightIcon: clionIcon, darkIcon: clionIcon },
	{ id: "rider", label: "Rider", lightIcon: riderIcon, darkIcon: riderIcon },
	{
		id: "datagrip",
		label: "DataGrip",
		lightIcon: datagripIcon,
		darkIcon: datagripIcon,
	},
	{
		id: "appcode",
		label: "AppCode",
		lightIcon: appcodeIcon,
		darkIcon: appcodeIcon,
	},
	{ id: "fleet", label: "Fleet", lightIcon: fleetIcon, darkIcon: fleetIcon },
	{
		id: "rustrover",
		label: "RustRover",
		lightIcon: rustroverIcon,
		darkIcon: rustroverIcon,
	},
];

const ALL_APP_OPTIONS: OpenInExternalAppOption[] = [
	...APP_OPTIONS,
	...VSCODE_OPTIONS,
	...JETBRAINS_OPTIONS,
];

export const getAppOption = (
	id: ExternalApp,
): OpenInExternalAppOption | undefined =>
	ALL_APP_OPTIONS.find((app) => app.id === id);
