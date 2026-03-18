/**
 * SSH Workspace Runtime
 *
 * Provides the WorkspaceRuntime interface for SSH-backed workspaces.
 * Terminal sessions are opened over SSH channels to a remote host.
 */

import type { SshHostConfig } from "./ssh-connection-manager";
import { SshTerminalRuntime } from "./ssh-terminal-runtime";
import type {
	TerminalRuntime,
	WorkspaceRuntime,
	WorkspaceRuntimeId,
} from "./types";

export class SshWorkspaceRuntime implements WorkspaceRuntime {
	readonly id: WorkspaceRuntimeId;
	readonly terminal: TerminalRuntime;
	readonly capabilities: WorkspaceRuntime["capabilities"];

	constructor(hostConfig: SshHostConfig) {
		this.id = `ssh:${hostConfig.id}`;
		this.terminal = new SshTerminalRuntime(hostConfig);
		this.capabilities = {
			terminal: this.terminal.capabilities,
		};
	}
}
