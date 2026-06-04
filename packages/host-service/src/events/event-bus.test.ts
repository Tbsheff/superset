import { describe, expect, it } from "bun:test";
import type { DetectedPort } from "@superset/port-scanner";
import type { HostDb } from "../db";
import { portManager } from "../ports/port-manager";
import type { WorkspaceFilesystemManager } from "../runtime/filesystem";
import { EventBus } from "./event-bus";
import type { GitWatcher } from "./git-watcher";

function createEventBus(): EventBus {
	return new EventBus({
		db: {} as unknown as HostDb,
		filesystem: {
			resolveWorkspaceRoot: () => "/tmp/missing-workspace",
		} as unknown as WorkspaceFilesystemManager,
		gitWatcher: {
			onChanged: () => () => {},
			onFsChanged: () => () => {},
			observeRemote: () => {},
			unobserveRemote: () => {},
		} as unknown as GitWatcher,
	});
}

describe("EventBus port events", () => {
	it("broadcasts port changes from the shared port manager and removes listeners on close", () => {
		const eventBus = createEventBus();
		const sentMessages: string[] = [];
		const socket = {
			readyState: 1,
			send(data: string) {
				sentMessages.push(data);
			},
			close() {},
		};
		const port: DetectedPort = {
			port: 5173,
			pid: 123,
			processName: "vite",
			terminalId: "terminal-1",
			workspaceId: "workspace-1",
			detectedAt: 1_700_000_000_000,
			address: "127.0.0.1",
		};

		eventBus.handleOpen(socket);
		eventBus.start();
		eventBus.start();
		portManager.emit("port:add", port);

		expect(sentMessages).toHaveLength(1);
		const message = JSON.parse(sentMessages[0] ?? "{}");
		expect(message).toMatchObject({
			type: "port:changed",
			workspaceId: "workspace-1",
			eventType: "add",
			port,
			label: null,
		});
		expect(typeof message.occurredAt).toBe("number");

		portManager.emit("port:remove", port);
		expect(sentMessages).toHaveLength(2);
		expect(JSON.parse(sentMessages[1] ?? "{}")).toMatchObject({
			type: "port:changed",
			workspaceId: "workspace-1",
			eventType: "remove",
			port,
			label: null,
		});

		eventBus.close();
		portManager.emit("port:add", port);
		expect(sentMessages).toHaveLength(2);
	});
});

interface FakeGitWatcher {
	watcher: GitWatcher;
	emitFs: (workspaceId: string) => void;
	observed: string[];
	unobserved: string[];
}

function createFakeGitWatcher(): FakeGitWatcher {
	let fsListener: ((event: { workspaceId: string }) => void) | null = null;
	const observed: string[] = [];
	const unobserved: string[] = [];
	const watcher = {
		onChanged: () => () => {},
		onFsChanged: (listener: (event: { workspaceId: string }) => void) => {
			fsListener = listener;
			return () => {
				fsListener = null;
			};
		},
		observeRemote: (id: string) => observed.push(id),
		unobserveRemote: (id: string) => unobserved.push(id),
	} as unknown as GitWatcher;
	return {
		watcher,
		emitFs: (workspaceId: string) => fsListener?.({ workspaceId }),
		observed,
		unobserved,
	};
}

function createSocket(sink: string[]) {
	return {
		readyState: 1,
		send: (data: string) => sink.push(data),
		close() {},
	};
}

describe("EventBus remote fs liveness", () => {
	it("broadcasts an fs overflow when the watcher signals a remote fs change", () => {
		const fake = createFakeGitWatcher();
		const eventBus = new EventBus({
			db: {} as unknown as HostDb,
			filesystem: {
				resolveWorkspaceRoot: () => "",
				getServiceForWorkspace: () => ({
					watchPath: () => ({
						[Symbol.asyncIterator]: () => ({
							next: async () => ({ value: undefined, done: true }),
							return: async () => ({ value: undefined, done: true }),
						}),
					}),
				}),
			} as unknown as WorkspaceFilesystemManager,
			gitWatcher: fake.watcher,
		});
		const sent: string[] = [];
		const socket = createSocket(sent);
		eventBus.handleOpen(socket);
		eventBus.start();

		fake.emitFs("ws-1");
		const message = JSON.parse(sent.at(-1) ?? "{}");
		expect(message).toMatchObject({
			type: "fs:events",
			workspaceId: "ws-1",
			events: [{ kind: "overflow" }],
		});

		eventBus.close();
	});

	it("observes a remote workspace once per fs:watch refcount and unobserves on cleanup", () => {
		const fake = createFakeGitWatcher();
		const eventBus = new EventBus({
			db: {} as unknown as HostDb,
			filesystem: {
				resolveWorkspaceRoot: () => "",
				getServiceForWorkspace: () => ({
					watchPath: () => ({
						[Symbol.asyncIterator]: () => ({
							next: async () => ({ value: undefined, done: true }),
							return: async () => ({ value: undefined, done: true }),
						}),
					}),
				}),
			} as unknown as WorkspaceFilesystemManager,
			gitWatcher: fake.watcher,
		});
		eventBus.start();

		const socketA = createSocket([]);
		const socketB = createSocket([]);
		eventBus.handleOpen(socketA);
		eventBus.handleOpen(socketB);

		const watch = JSON.stringify({ type: "fs:watch", workspaceId: "ws-1" });
		eventBus.handleMessage(socketA, watch);
		eventBus.handleMessage(socketB, watch);
		// Two clients watching, but the poll starts only once.
		expect(fake.observed).toEqual(["ws-1"]);
		expect(fake.unobserved).toEqual([]);

		eventBus.handleClose(socketA);
		// Still one watcher left — must not stop polling yet.
		expect(fake.unobserved).toEqual([]);

		eventBus.handleClose(socketB);
		expect(fake.unobserved).toEqual(["ws-1"]);

		eventBus.close();
	});
});
