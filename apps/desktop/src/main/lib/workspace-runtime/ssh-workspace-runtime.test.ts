import { describe, expect, mock, test } from "bun:test";

mock.module("./ssh-terminal-runtime", () => ({
	SshTerminalRuntime: class {
		capabilities = { persistent: false, coldRestore: false };
	},
}));

const { SshWorkspaceRuntime } = await import("./ssh-workspace-runtime");

const hostConfig = {
	id: "host-1",
	hostname: "example.com",
	port: 22,
	username: "user",
	authMethod: "agent" as const,
};

describe("SshWorkspaceRuntime", () => {
	test("id is prefixed with ssh:", () => {
		const runtime = new SshWorkspaceRuntime(hostConfig);
		expect(runtime.id).toBe("ssh:host-1");
	});

	test("capabilities.terminal.persistent is false", () => {
		const runtime = new SshWorkspaceRuntime(hostConfig);
		expect(runtime.capabilities.terminal.persistent).toBe(false);
	});

	test("capabilities.terminal.coldRestore is false", () => {
		const runtime = new SshWorkspaceRuntime(hostConfig);
		expect(runtime.capabilities.terminal.coldRestore).toBe(false);
	});

	test("terminal is an SshTerminalRuntime instance", async () => {
		const { SshTerminalRuntime } = await import("./ssh-terminal-runtime");
		const runtime = new SshWorkspaceRuntime(hostConfig);
		expect(runtime.terminal).toBeInstanceOf(SshTerminalRuntime);
	});
});
