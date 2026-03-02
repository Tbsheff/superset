import { quote } from "shell-quote";
import type { ResttyAdapter } from "./restty/ResttyAdapter";

export function shellEscapePaths(paths: string[]): string {
	return quote(paths);
}

export function scrollToBottom(adapter: ResttyAdapter): void {
	adapter.scrollToBottom();
}
