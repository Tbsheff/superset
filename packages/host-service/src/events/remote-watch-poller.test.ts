import { describe, expect, it } from "bun:test";
import type {
	RuntimeDiff,
	RuntimeFileInfo,
	WorkspaceRuntime,
} from "../runtime/seam/index.ts";
import {
	type RemoteRuntimeResolverLike,
	RemoteWatchPoller,
} from "./remote-watch-poller.ts";

function fileInfo(name: string, overrides: Partial<RuntimeFileInfo> = {}) {
	return {
		name,
		isDir: false,
		size: 0,
		mode: "0644",
		modTime: "2026-01-01T00:00:00Z",
		permissions: "rw-r--r--",
		...overrides,
	} satisfies RuntimeFileInfo;
}

function fakeRuntime(opts: {
	statusPorcelain: () => string;
	listFiles?: () => RuntimeFileInfo[];
}): WorkspaceRuntime {
	return {
		role: "workspace",
		externalId: "sandbox-1",
		startShell: async () => {
			throw new Error("not used");
		},
		getDiff: async (): Promise<RuntimeDiff> => ({
			statusPorcelain: opts.statusPorcelain(),
			unifiedPatch: "",
		}),
		runtimeFs: opts.listFiles
			? () =>
					({
						listFiles: async () => opts.listFiles?.() ?? [],
					}) as unknown as ReturnType<
						NonNullable<WorkspaceRuntime["runtimeFs"]>
					>
			: undefined,
		exposePreview: async () => ({ url: "", tokenScheme: "none" as const }),
		activityLease: () => ({}) as never,
		getStatus: async () => "running" as never,
		stop: async () => {},
	} as WorkspaceRuntime;
}

function resolverFor(runtime: WorkspaceRuntime): RemoteRuntimeResolverLike {
	return { resolve: async () => runtime };
}

async function flush(): Promise<void> {
	// Let the poller's primed tick (an async chain) settle.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RemoteWatchPoller", () => {
	it("emits git:changed only when the status signature changes", async () => {
		let status = "";
		const gitEvents: string[] = [];
		const poller = new RemoteWatchPoller({
			resolveRuntime: async () =>
				resolverFor(fakeRuntime({ statusPorcelain: () => status })),
			emit: {
				gitChanged: (id) => gitEvents.push(id),
				fsChanged: () => {},
			},
			intervalMs: 1,
		});

		poller.observe("ws-1");
		await flush();
		expect(gitEvents).toEqual([]); // first tick primes the baseline

		status = " M file.ts";
		await flush();
		expect(gitEvents).toEqual(["ws-1"]);

		// Stable status: no further emits.
		const before = gitEvents.length;
		await flush();
		expect(gitEvents.length).toBe(before);

		poller.close();
	});

	it("emits fs change when the root listing signature changes", async () => {
		let files = [fileInfo("a.ts")];
		const fsEvents: string[] = [];
		const poller = new RemoteWatchPoller({
			resolveRuntime: async () =>
				resolverFor(
					fakeRuntime({
						statusPorcelain: () => "",
						listFiles: () => files,
					}),
				),
			emit: {
				gitChanged: () => {},
				fsChanged: (id) => fsEvents.push(id),
			},
			intervalMs: 1,
		});

		poller.observe("ws-1");
		await flush();
		expect(fsEvents).toEqual([]);

		files = [fileInfo("a.ts"), fileInfo("b.ts")];
		await flush();
		expect(fsEvents).toEqual(["ws-1"]);

		poller.close();
	});

	it("stops polling after unobserve and clears timers on close", async () => {
		let resolveCount = 0;
		const poller = new RemoteWatchPoller({
			resolveRuntime: async () => {
				resolveCount += 1;
				return resolverFor(fakeRuntime({ statusPorcelain: () => "" }));
			},
			emit: { gitChanged: () => {}, fsChanged: () => {} },
			intervalMs: 1,
		});

		poller.observe("ws-1");
		await flush();
		poller.unobserve("ws-1");
		const countAfterUnobserve = resolveCount;
		await flush();
		await flush();
		expect(resolveCount).toBe(countAfterUnobserve);

		poller.close();
	});

	it("swallows resolve/runtime errors and keeps polling", async () => {
		let fail = true;
		const gitEvents: string[] = [];
		let status = "";
		const poller = new RemoteWatchPoller({
			resolveRuntime: async () => {
				if (fail) throw new Error("sandbox not live");
				return resolverFor(fakeRuntime({ statusPorcelain: () => status }));
			},
			emit: {
				gitChanged: (id) => gitEvents.push(id),
				fsChanged: () => {},
			},
			intervalMs: 1,
		});

		poller.observe("ws-1");
		await flush();
		expect(gitEvents).toEqual([]);

		fail = false; // recovers; baseline primes
		await flush();
		status = "?? new.ts";
		await flush();
		expect(gitEvents).toEqual(["ws-1"]);

		poller.close();
	});
});
