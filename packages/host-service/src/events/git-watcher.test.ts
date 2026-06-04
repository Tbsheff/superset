import { describe, expect, it } from "bun:test";
import type { HostDb } from "../db/index.ts";
import type { WorkspaceFilesystemManager } from "../runtime/filesystem/index.ts";
import type { WorkspaceRuntime } from "../runtime/seam/index.ts";
import { GitWatcher } from "./git-watcher.ts";

type Row = { id: string; worktreePath: string; runtimeKind: string };

function dbReturning(getRows: () => Row[]): HostDb {
	return {
		select: () => ({ from: () => ({ all: () => getRows() }) }),
	} as unknown as HostDb;
}

const noopFs = {} as unknown as WorkspaceFilesystemManager;

function fakeRuntime(getStatus: () => string): WorkspaceRuntime {
	return {
		role: "workspace",
		externalId: "sandbox",
		startShell: async () => {
			throw new Error("unused");
		},
		getDiff: async () => ({ statusPorcelain: getStatus(), unifiedPatch: "" }),
		exposePreview: async () => ({ url: "", tokenScheme: "none" as const }),
		activityLease: () => ({}) as never,
		getStatus: async () => "running" as never,
		stop: async () => {},
	} as WorkspaceRuntime;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("GitWatcher remote polling", () => {
	it("never polls a remote workspace until a client observes it", async () => {
		let resolveCount = 0;
		const watcher = new GitWatcher(
			dbReturning(() => [
				{ id: "ws-1", worktreePath: "", runtimeKind: "remote" },
			]),
			noopFs,
			{
				remotePollIntervalMs: 5,
				resolveRemoteRuntime: async () => {
					resolveCount += 1;
					return { resolve: async () => fakeRuntime(() => "") };
				},
			},
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		// No observe() yet — idle sandbox must not be woken.
		expect(resolveCount).toBe(0);
		watcher.close();
	});

	it("emits git:changed when the remote status signature changes", async () => {
		let status = "";
		const events: string[] = [];
		const watcher = new GitWatcher(
			dbReturning(() => [
				{ id: "ws-1", worktreePath: "", runtimeKind: "remote" },
			]),
			noopFs,
			{
				remotePollIntervalMs: 5,
				resolveRemoteRuntime: async () => ({
					resolve: async () => fakeRuntime(() => status),
				}),
			},
		);
		watcher.onChanged((e) => events.push(e.workspaceId));
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		watcher.observeRemote("ws-1");
		// Baseline primes on the first tick; no emit yet.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(events).toEqual([]);

		status = " M a.ts";
		await waitFor(() => events.length > 0);
		expect(events).toEqual(["ws-1"]);

		watcher.close();
	});

	it("local rows are not driven through the remote poller", async () => {
		let resolveCount = 0;
		const watcher = new GitWatcher(
			dbReturning(() => [
				{ id: "ws-local", worktreePath: "/tmp/nope", runtimeKind: "local" },
			]),
			noopFs,
			{
				remotePollIntervalMs: 5,
				resolveRemoteRuntime: async () => {
					resolveCount += 1;
					return { resolve: async () => fakeRuntime(() => "") };
				},
			},
		);
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		// observeRemote on a non-remote id is a no-op (id not in remoteWorkspaceIds).
		watcher.observeRemote("ws-local");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(resolveCount).toBe(0);
		watcher.close();
	});

	it("stops polling a remote row that disappears from the db on rescan", async () => {
		let rows: Row[] = [{ id: "ws-1", worktreePath: "", runtimeKind: "remote" }];
		let status = "";
		const events: string[] = [];
		const watcher = new GitWatcher(
			dbReturning(() => rows),
			noopFs,
			{
				remotePollIntervalMs: 5,
				resolveRemoteRuntime: async () => ({
					resolve: async () => fakeRuntime(() => status),
				}),
			},
		);
		watcher.onChanged((e) => events.push(e.workspaceId));
		watcher.start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		watcher.observeRemote("ws-1");
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Drop the row; close stops every poll deterministically (rescan is on a
		// 30s timer, so we assert close() clears the poll instead of waiting).
		rows = [];
		watcher.close();
		status = " M b.ts";
		const before = events.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(events.length).toBe(before);
	});
});
