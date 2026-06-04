import {
	type DetectedPort,
	parseStaticPortsConfig,
} from "@superset/port-scanner";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "../../../db/schema";
import { portManager } from "../../../ports/port-manager";
import { getLabelsForWorkspace } from "../../../ports/static-ports";
import { buildRemoteRuntimeResolver } from "../../../runtime/exec";
import type { WorkspaceRuntime } from "../../../runtime/seam";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";

export interface EnrichedPort extends DetectedPort {
	label: string | null;
}

export type PortEvent =
	| { type: "add"; port: DetectedPort }
	| { type: "remove"; port: DetectedPort };

const getAllInputSchema = z.object({
	workspaceIds: z.array(z.string()).min(1),
});

/** Sandbox-relative path to the per-repo port labels (mirrors local). */
const REMOTE_PORTS_FILE = "workspace/.superset/ports.json";

function getRuntimeKindsByWorkspace(
	ctx: HostServiceContext,
	workspaceIds: Set<string>,
): Map<string, string> {
	const rows = ctx.db.query.workspaces.findMany().sync();
	const kinds = new Map<string, string>();
	for (const row of rows) {
		if (workspaceIds.has(row.id)) kinds.set(row.id, row.runtimeKind);
	}
	return kinds;
}

async function resolveRemoteRuntime(
	ctx: HostServiceContext,
	workspaceId: string,
): Promise<WorkspaceRuntime> {
	const resolver = ctx.getRemoteRuntimeResolver
		? await ctx.getRemoteRuntimeResolver()
		: await buildRemoteRuntimeResolver(ctx);
	return resolver.resolve(workspaceId);
}

/**
 * Best-effort `port → label` map read from `.superset/ports.json` INSIDE the
 * sandbox. The file is an optional label hint, so any miss (no fs verb, missing
 * file, parse error) degrades to no labels rather than failing the port list.
 */
async function loadRemoteLabels(
	runtime: WorkspaceRuntime,
): Promise<Map<number, string>> {
	const labels = new Map<number, string>();
	const fs = runtime.runtimeFs?.();
	if (!fs) return labels;
	try {
		const content = (await fs.downloadFile(REMOTE_PORTS_FILE)).toString(
			"utf-8",
		);
		const parsed = parseStaticPortsConfig(content);
		if (parsed.ports) {
			for (const port of parsed.ports) labels.set(port.port, port.label);
		}
	} catch {
		// No labels file in the sandbox — return whatever we have.
	}
	return labels;
}

/**
 * Maps a remote workspace's in-sandbox listener scan to the `EnrichedPort`
 * shape the renderer expects. There is no host terminal session backing these
 * ports, so `terminalId` is empty and `detectedAt` is the scan time; the badge
 * keys on `${terminalId}:${port}`, which stays unique per workspace.
 */
async function getRemotePorts(
	runtime: WorkspaceRuntime,
	workspaceId: string,
): Promise<EnrichedPort[]> {
	if (!runtime.listPorts) return [];
	const [scanned, labels] = await Promise.all([
		runtime.listPorts(),
		loadRemoteLabels(runtime),
	]);
	const detectedAt = Date.now();
	return scanned.map((info) => ({
		port: info.port,
		pid: info.pid ?? 0,
		processName: info.processName ?? "",
		terminalId: "",
		workspaceId,
		detectedAt,
		address: info.address ?? "",
		label: labels.get(info.port) ?? null,
	}));
}

export const portsRouter = router({
	getAll: protectedProcedure
		.input(getAllInputSchema)
		.query(async ({ ctx, input }): Promise<EnrichedPort[]> => {
			const requestedWorkspaceIds = new Set(input.workspaceIds);
			const runtimeKinds = getRuntimeKindsByWorkspace(
				ctx,
				requestedWorkspaceIds,
			);
			const remoteWorkspaceIds = input.workspaceIds.filter(
				(id) => runtimeKinds.get(id) === "remote",
			);

			// Local arm: byte-for-byte the prior PortManager snapshot path.
			const resolveRoot = (workspaceId: string): string | null => {
				try {
					return ctx.runtime.filesystem.resolveWorkspaceRoot(workspaceId);
				} catch {
					return null;
				}
			};
			const labelsByWorkspace = new Map<
				string,
				ReturnType<typeof getLabelsForWorkspace>
			>();
			const localPorts = portManager
				.getAllPorts()
				.filter(
					(port) =>
						requestedWorkspaceIds.has(port.workspaceId) &&
						runtimeKinds.get(port.workspaceId) !== "remote",
				)
				.map((port) => {
					let labels = labelsByWorkspace.get(port.workspaceId);
					if (!labelsByWorkspace.has(port.workspaceId)) {
						labels = getLabelsForWorkspace(resolveRoot, port.workspaceId);
						labelsByWorkspace.set(port.workspaceId, labels);
					}
					return { ...port, label: labels?.get(port.port) ?? null };
				});

			if (remoteWorkspaceIds.length === 0) return localPorts;

			// Remote arm: scan each remote sandbox in-process. A single failed
			// resolve/scan yields no ports for that workspace, never the whole list.
			const remotePortGroups = await Promise.all(
				remoteWorkspaceIds.map(async (workspaceId) => {
					try {
						const runtime = await resolveRemoteRuntime(ctx, workspaceId);
						return await getRemotePorts(runtime, workspaceId);
					} catch {
						return [] as EnrichedPort[];
					}
				}),
			);
			return [...localPorts, ...remotePortGroups.flat()];
		}),

	/**
	 * Stream port add/remove events. tRPC v11 async iterators: the generator
	 * runs until the client disconnects (or an abort signal cancels it), at
	 * which point the `finally` block detaches emitter listeners.
	 *
	 * v1 streams LOCAL events only — remote sandbox ports are not yet event-fed
	 * (the watcher slice owns live remote events). The renderer also polls
	 * `getAll`, which covers remote ports on the fallback interval.
	 */
	subscribe: protectedProcedure
		.input(getAllInputSchema)
		.subscription(async function* ({ signal, input }) {
			const requestedWorkspaceIds = new Set(input.workspaceIds);
			const queue: PortEvent[] = [];
			let resolve: (() => void) | null = null;
			const wake = () => {
				resolve?.();
				resolve = null;
			};

			const onAdd = (port: DetectedPort) => {
				if (!requestedWorkspaceIds.has(port.workspaceId)) return;
				queue.push({ type: "add", port });
				wake();
			};
			const onRemove = (port: DetectedPort) => {
				if (!requestedWorkspaceIds.has(port.workspaceId)) return;
				queue.push({ type: "remove", port });
				wake();
			};

			portManager.on("port:add", onAdd);
			portManager.on("port:remove", onRemove);

			signal?.addEventListener("abort", wake);

			try {
				while (!signal?.aborted) {
					while (queue.length > 0) {
						const event = queue.shift();
						if (event) yield event;
					}
					await new Promise<void>((r) => {
						if (signal?.aborted) {
							r();
							return;
						}
						resolve = r;
					});
				}
			} finally {
				portManager.off("port:add", onAdd);
				portManager.off("port:remove", onRemove);
				signal?.removeEventListener("abort", wake);
			}
		}),

	/**
	 * Returns the URL the renderer should open for `port`. Local resolves to
	 * `http://localhost:port` (host network); remote mints a tokenized Daytona
	 * preview origin via the runtime. `tokenScheme` is forwarded so the caller
	 * knows whether the URL alone authenticates ("none") or needs a header
	 * ("standard"/"signed").
	 */
	exposePreview: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				port: z.number().int().positive(),
			}),
		)
		.mutation(
			async ({
				ctx,
				input,
			}): Promise<{
				url: string;
				tokenScheme: "standard" | "signed" | "none";
			}> => {
				const workspace = ctx.db.query.workspaces
					.findFirst({ where: eq(workspaces.id, input.workspaceId) })
					.sync();
				if (!workspace) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Workspace not found",
					});
				}
				if (workspace.runtimeKind !== "remote") {
					return {
						url: `http://localhost:${input.port}`,
						tokenScheme: "none",
					};
				}
				const runtime = await resolveRemoteRuntime(ctx, input.workspaceId);
				return runtime.exposePreview(input.port);
			},
		),

	kill: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				terminalId: z.string(),
				port: z.number().int().positive(),
			}),
		)
		.mutation(
			async ({ ctx, input }): Promise<{ success: boolean; error?: string }> => {
				const workspace = ctx.db.query.workspaces
					.findFirst({ where: eq(workspaces.id, input.workspaceId) })
					.sync();
				if (workspace?.runtimeKind === "remote") {
					try {
						const runtime = await resolveRemoteRuntime(ctx, input.workspaceId);
						if (!runtime.exec) {
							return {
								success: false,
								error: "Remote runtime cannot kill ports",
							};
						}
						const res = await runtime.exec(
							`kill $(lsof -t -i:${input.port}) 2>/dev/null || fuser -k ${input.port}/tcp 2>/dev/null`,
						);
						return { success: res.exitCode === 0 };
					} catch (error) {
						return {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}
				return portManager.killPort(input);
			},
		),
});
