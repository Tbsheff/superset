import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockConnect = mock(async () => ({}));
const mockDisconnect = mock(() => {});
const mockGetStatus = mock(() => "disconnected" as const);

mock.module("main/lib/workspace-runtime/ssh-connection-manager", () => ({
	getSshConnectionManager: () => ({
		connect: mockConnect,
		disconnect: mockDisconnect,
		getStatus: mockGetStatus,
	}),
}));

mock.module("uuid", () => ({
	v4: () => "test-uuid-123",
}));

const { createRemoteHostsRouter } = await import("./index");

beforeEach(() => {
	mockConnect.mockReset();
	mockDisconnect.mockReset();
	mockGetStatus.mockReset();
	mockGetStatus.mockImplementation(() => "disconnected" as const);
});

describe("createRemoteHostsRouter", () => {
	test("returns a defined router object", () => {
		const router = createRemoteHostsRouter();
		expect(router).toBeDefined();
	});

	test("router has list procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.list).toBeDefined();
	});

	test("router has get procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.get).toBeDefined();
	});

	test("router has create procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.create).toBeDefined();
	});

	test("router has update procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.update).toBeDefined();
	});

	test("router has delete procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.delete).toBeDefined();
	});

	test("router has testConnection procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.testConnection).toBeDefined();
	});

	test("router has connectionStatus procedure", () => {
		const router = createRemoteHostsRouter();
		expect(router._def.procedures.connectionStatus).toBeDefined();
	});

	test("all expected procedures are present in a single assertion", () => {
		const router = createRemoteHostsRouter();
		const procedures = Object.keys(router._def.procedures);
		expect(procedures).toContain("list");
		expect(procedures).toContain("get");
		expect(procedures).toContain("create");
		expect(procedures).toContain("update");
		expect(procedures).toContain("delete");
		expect(procedures).toContain("testConnection");
		expect(procedures).toContain("connectionStatus");
	});
});

describe("testConnection procedure", () => {
	test("calls connect with provided config and disconnects on success", async () => {
		mockConnect.mockResolvedValueOnce({} as any);

		const router = createRemoteHostsRouter();
		const procedure = router._def.procedures.testConnection;

		// Call the resolver directly by accessing the procedure's handler
		const resolver = (procedure._def as any).resolver;
		const result = await resolver({
			input: {
				hostname: "example.com",
				port: 22,
				username: "user",
				authMethod: "agent" as const,
			},
			ctx: {},
			path: "testConnection",
			type: "mutation",
		});

		expect(result).toEqual({ success: true, error: null });
		expect(mockConnect).toHaveBeenCalledTimes(1);
		expect(mockDisconnect).toHaveBeenCalledTimes(1);
	});

	test("returns error message when connect throws", async () => {
		mockConnect.mockRejectedValueOnce(new Error("Auth failed"));

		const router = createRemoteHostsRouter();
		const procedure = router._def.procedures.testConnection;
		const resolver = (procedure._def as any).resolver;

		const result = await resolver({
			input: {
				hostname: "example.com",
				port: 22,
				username: "user",
				authMethod: "key" as const,
				privateKeyPath: "/home/user/.ssh/id_rsa",
			},
			ctx: {},
			path: "testConnection",
			type: "mutation",
		});

		expect(result).toEqual({ success: false, error: "Auth failed" });
		// Should still disconnect test connection on failure
		expect(mockDisconnect).toHaveBeenCalledTimes(1);
	});

	test("returns generic error string for non-Error throws", async () => {
		mockConnect.mockRejectedValueOnce("string error");

		const router = createRemoteHostsRouter();
		const procedure = router._def.procedures.testConnection;
		const resolver = (procedure._def as any).resolver;

		const result = await resolver({
			input: {
				hostname: "example.com",
				username: "user",
				authMethod: "password" as const,
				password: "secret",
			},
			ctx: {},
			path: "testConnection",
			type: "mutation",
		});

		expect(result).toEqual({ success: false, error: "Connection failed" });
	});
});

describe("connectionStatus procedure", () => {
	test("returns status from ssh connection manager", () => {
		mockGetStatus.mockReturnValueOnce("connected" as any);

		const router = createRemoteHostsRouter();
		const procedure = router._def.procedures.connectionStatus;
		const resolver = (procedure._def as any).resolver;

		const result = resolver({
			input: "host-123",
			ctx: {},
			path: "connectionStatus",
			type: "query",
		});

		expect(result).toEqual({ status: "connected" });
		expect(mockGetStatus).toHaveBeenCalledTimes(1);
	});

	test("returns disconnected status by default", () => {
		const router = createRemoteHostsRouter();
		const procedure = router._def.procedures.connectionStatus;
		const resolver = (procedure._def as any).resolver;

		const result = resolver({
			input: "host-456",
			ctx: {},
			path: "connectionStatus",
			type: "query",
		});

		expect(result).toEqual({ status: "disconnected" });
	});
});
