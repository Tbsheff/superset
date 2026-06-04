import { describe, expect, test } from "bun:test";
import {
	createWorkspaceRuntimeRegistry,
	type WorkspaceRuntimeKind,
} from "./registry";
import { type RemotePtyTransport, RemoteWorkspaceRuntime } from "./remote";

function stubTransport(): RemotePtyTransport {
	return {
		onData: () => ({ dispose: () => {} }),
		start: async () => {},
		write: async () => {},
		signalInterrupt: async () => {},
		resize: async () => undefined,
		onExit: () => {},
		kill: async () => {},
	};
}

describe("WorkspaceRuntimeRegistry routing", () => {
	test("routes runtimeKind==='remote' workspaces to the RemoteWorkspaceRuntime", () => {
		let factoryCalls = 0;
		const kinds: Record<string, WorkspaceRuntimeKind> = {
			"ws-remote": "remote",
		};
		const registry = createWorkspaceRuntimeRegistry({
			resolveRuntimeKind: (id) => kinds[id] ?? "local",
			remoteTransportFactory: () => {
				factoryCalls++;
				return stubTransport();
			},
		});

		const runtime = registry.getForWorkspaceId("ws-remote");
		expect(runtime).toBeInstanceOf(RemoteWorkspaceRuntime);
		// Resolving the runtime alone must not eagerly build a transport; that only
		// happens on createOrAttach.
		expect(factoryCalls).toBe(0);
	});

	test("caches a single RemoteWorkspaceRuntime across remote workspaces", () => {
		const registry = createWorkspaceRuntimeRegistry({
			resolveRuntimeKind: () => "remote",
			remoteTransportFactory: () => stubTransport(),
		});
		const a = registry.getForWorkspaceId("ws-a");
		const b = registry.getForWorkspaceId("ws-b");
		expect(a).toBe(b);
		expect(a).toBeInstanceOf(RemoteWorkspaceRuntime);
	});

	test("throws when a remote workspace is requested without a transport factory", () => {
		const registry = createWorkspaceRuntimeRegistry({
			resolveRuntimeKind: () => "remote",
		});
		expect(() => registry.getForWorkspaceId("ws-remote")).toThrow(
			/remoteTransportFactory/,
		);
	});

	test("consults the resolver with the requested workspaceId", () => {
		// A throwing resolver proves getForWorkspaceId routes through the resolver
		// before constructing any runtime — letting us assert the routing decision
		// without triggering the local branch's daemon-backed side effects.
		const seen: string[] = [];
		const registry = createWorkspaceRuntimeRegistry({
			resolveRuntimeKind: (id) => {
				seen.push(id);
				throw new Error("resolver-called");
			},
			remoteTransportFactory: () => stubTransport(),
		});
		expect(() => registry.getForWorkspaceId("ws-42")).toThrow(
			"resolver-called",
		);
		expect(seen).toEqual(["ws-42"]);
	});
});
