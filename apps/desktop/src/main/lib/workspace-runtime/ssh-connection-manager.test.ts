import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Create a mock SSH client that simulates connection
function createMockSshClient() {
	const listeners = new Map<string, ((...args: any[]) => void)[]>();
	return {
		on: mock((event: string, cb: (...args: any[]) => void) => {
			const existing = listeners.get(event) || [];
			existing.push(cb);
			listeners.set(event, existing);
		}),
		connect: mock((_config: any) => {
			// Simulate successful connection asynchronously
			setTimeout(() => {
				const readyCbs = listeners.get("ready") || [];
				for (const cb of readyCbs) cb();
			}, 0);
		}),
		end: mock(() => {}),
		emit: (event: string, ...args: any[]) => {
			const cbs = listeners.get(event) || [];
			for (const cb of cbs) cb(...args);
		},
		_listeners: listeners,
	};
}

let mockClient: ReturnType<typeof createMockSshClient>;

mock.module("ssh2", () => ({
	Client: class {
		constructor() {
			Object.assign(this, mockClient);
		}
	},
}));

// Import after mock.module is registered
const { SshConnectionManager } = await import("./ssh-connection-manager");

const baseConfig = {
	id: "host-1",
	hostname: "example.com",
	port: 22,
	username: "user",
	authMethod: "agent" as const,
};

describe("SshConnectionManager", () => {
	let manager: InstanceType<typeof SshConnectionManager>;

	beforeEach(() => {
		mockClient = createMockSshClient();
		manager = new SshConnectionManager();
	});

	afterEach(() => {
		manager.disconnectAll();
	});

	test("getStatus returns disconnected for unknown host", () => {
		expect(manager.getStatus("unknown-host")).toBe("disconnected");
	});

	test("connect creates connection and resolves on ready", async () => {
		const client = await manager.connect(baseConfig);
		expect(client).toBeDefined();
		expect(mockClient.connect).toHaveBeenCalledTimes(1);
	});

	test("getConnection returns client after connect", async () => {
		await manager.connect(baseConfig);
		const conn = manager.getConnection(baseConfig.id);
		expect(conn).not.toBeNull();
	});

	test("getStatus returns connected after successful connect", async () => {
		await manager.connect(baseConfig);
		expect(manager.getStatus(baseConfig.id)).toBe("connected");
	});

	test("disconnect removes connection and cleans up", async () => {
		await manager.connect(baseConfig);
		manager.disconnect(baseConfig.id);
		expect(manager.getConnection(baseConfig.id)).toBeNull();
		expect(mockClient.end).toHaveBeenCalledTimes(1);
	});

	test("getConnection returns null after disconnect", async () => {
		await manager.connect(baseConfig);
		manager.disconnect(baseConfig.id);
		expect(manager.getConnection(baseConfig.id)).toBeNull();
	});

	test("disconnectAll clears all connections", async () => {
		const config2 = { ...baseConfig, id: "host-2" };

		// First connection
		await manager.connect(baseConfig);

		// Reset mock for second connection
		mockClient = createMockSshClient();
		await manager.connect(config2);

		manager.disconnectAll();

		expect(manager.getStatus(baseConfig.id)).toBe("disconnected");
		expect(manager.getStatus(config2.id)).toBe("disconnected");
	});

	test("connect reuses existing connected client", async () => {
		const client1 = await manager.connect(baseConfig);
		const client2 = await manager.connect(baseConfig);
		// Should be the same client object, connect not called again
		expect(client1).toBe(client2);
		expect(mockClient.connect).toHaveBeenCalledTimes(1);
	});

	test("emits status events on connect and disconnect", async () => {
		const statusEvents: string[] = [];
		manager.on(`status:${baseConfig.id}`, (status: string) => {
			statusEvents.push(status);
		});

		await manager.connect(baseConfig);
		manager.disconnect(baseConfig.id);

		expect(statusEvents).toContain("connecting");
		expect(statusEvents).toContain("connected");
		expect(statusEvents).toContain("disconnected");
	});
});
