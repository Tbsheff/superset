import {
	descriptorSupportsExecution,
	type ProviderDescriptor,
} from "../descriptors/index.ts";
import type { WorkspaceRuntime } from "../seam/index.ts";
import { drainShell } from "./drainShell.ts";

/**
 * Mutate a runtime's filesystem using whichever execution surface the descriptor
 * advertises, so the FS/diff/persistence contracts work against BOTH a pty and a
 * streaming-command runtime without leaking a write method onto the seam:
 *   - pty            ⇒ open an interactive shell and write the command to stdin.
 *   - streaming-command ⇒ run the command non-interactively, passing it via the
 *     `CONTRACT_CMD` env key (interactive stdin is rejected by such runtimes).
 *
 * `command` is one line of the contract shell grammar (see types.ts).
 */
export async function mutateFs(
	handle: WorkspaceRuntime,
	descriptor: ProviderDescriptor,
	command: string,
): Promise<void> {
	if (descriptorSupportsExecution(descriptor, "streaming-command")) {
		const shell = await handle.startShell({ env: { CONTRACT_CMD: command } });
		await drainShell(shell, 200);
		await shell.kill();
		return;
	}
	const shell = await handle.startShell({});
	shell.write(command);
	await drainShell(shell, 100);
	await shell.kill();
}
