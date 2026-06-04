import type { ShellHandle } from "../seam/index.ts";

export interface DrainedShell {
	data: string;
	exit: { exitCode: number; signal?: number } | null;
}

/**
 * Collect everything a shell emits until it exits (or until `timeoutMs`).
 * Resolves with the concatenated data plus the exit info. Used by the contract
 * suite to observe a streaming-command runtime's log output and exit code
 * without depending on a particular event-shape — only the seam's onData/onExit.
 */
export function drainShell(
	shell: ShellHandle,
	timeoutMs = 1000,
): Promise<DrainedShell> {
	return new Promise<DrainedShell>((resolve) => {
		let data = "";
		let settled = false;
		const dataSub = shell.onData((chunk) => {
			data += chunk;
		});
		const finish = (exit: DrainedShell["exit"]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			dataSub.dispose();
			exitSub.dispose();
			resolve({ data, exit });
		};
		const exitSub = shell.onExit((info) => finish(info));
		const timer = setTimeout(() => finish(null), timeoutMs);
	});
}
