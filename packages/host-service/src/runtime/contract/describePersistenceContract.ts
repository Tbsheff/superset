import { describe, expect, test } from "bun:test";
import {
	descriptorHasWritableFilesystem,
	descriptorRetainsDiskOnStop,
} from "../descriptors/index.ts";
import { mutateFs } from "./mutateFs.ts";
import {
	CONTRACT_SHELL_COMMANDS,
	type ContractContext,
	defaultWorkspacePlan,
} from "./types.ts";

/**
 * The stop+reconnect round-trip, keyed off `descriptor.onStop`:
 *   - keep-disk / keep-disk-and-memory ⇒ a file written before stop PERSISTS
 *     after reconnect, and status is running or stopped-but-resumable.
 *   - discard-only ⇒ the file written before stop is GONE after reconnect (the
 *     load-bearing discard signal; the reconnected instance may legitimately be
 *     running again, just with a fresh disk).
 * The assertion branches on the descriptor so an adapter that lies about its
 * persistence fails here.
 */
export function describePersistenceContract(ctx: ContractContext): void {
	const plan = () => ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-persist");

	describe("persistence contract", () => {
		test("stop+reconnect preserves or loses FS per the descriptor's onStop", async () => {
			const adapter = await ctx.makeAdapter();
			const keepsDisk = descriptorRetainsDiskOnStop(adapter.descriptor);
			const writable = descriptorHasWritableFilesystem(adapter.descriptor);

			const handle = await adapter.createInstance(plan());
			const externalId = handle.externalId;
			const path = "contract-persist.txt";
			if (writable) {
				await mutateFs(
					handle,
					adapter.descriptor,
					CONTRACT_SHELL_COMMANDS.write(path, "persist-me"),
				);
				expect((await handle.getDiff()).statusPorcelain).toContain(path);
			}

			await handle.stop({ kind: "stop", keepDisk: keepsDisk });
			const reconnected = await adapter.reconnect(externalId);
			const status = await reconnected.getStatus();

			if (keepsDisk) {
				const resumable =
					status.kind === "running" ||
					(status.kind === "stopped" && status.resumable);
				expect(resumable).toBe(true);
				if (writable) {
					expect((await reconnected.getDiff()).statusPorcelain).toContain(path);
				}
			} else {
				// A discard provider never advertises a resumable stopped instance.
				if (status.kind === "stopped") {
					expect(status.resumable).toBe(false);
				}
				if (writable) {
					expect((await reconnected.getDiff()).statusPorcelain).not.toContain(
						path,
					);
				}
			}
		});
	});
}
