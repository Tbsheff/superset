import { describe, expect, test } from "bun:test";
import { descriptorHasWritableFilesystem } from "../descriptors/index.ts";
import { mutateFs } from "./mutateFs.ts";
import {
	CONTRACT_SHELL_COMMANDS,
	type ContractContext,
	defaultWorkspacePlan,
} from "./types.ts";

/**
 * Asserts the runtime's filesystem behavior matches `descriptor.filesystem`.
 * When the descriptor advertises `read-write-list`, a file written through the
 * runtime's execution surface must show up in `getDiff()`; the diff shape is the
 * seam's RuntimeDiff. When it advertises only `none`, the write must NOT appear —
 * an adapter that lies about its FS support fails here.
 */
export function describeFilesystemContract(ctx: ContractContext): void {
	const plan = () => ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-fs");

	describe("filesystem contract", () => {
		test("getDiff returns the RuntimeDiff shape", async () => {
			const adapter = await ctx.makeAdapter();
			const handle = await adapter.createInstance(plan());
			const diff = await handle.getDiff();
			expect(typeof diff.statusPorcelain).toBe("string");
			expect(typeof diff.unifiedPatch).toBe("string");
		});

		test("a written file is observable via getDiff per the FS facet", async () => {
			const adapter = await ctx.makeAdapter();
			const writable = descriptorHasWritableFilesystem(adapter.descriptor);
			const handle = await adapter.createInstance(plan());
			const path = "contract-fs.txt";
			await mutateFs(
				handle,
				adapter.descriptor,
				CONTRACT_SHELL_COMMANDS.write(path, "hello-fs"),
			);
			const diff = await handle.getDiff();
			if (writable) {
				expect(diff.statusPorcelain).toContain(path);
				expect(diff.unifiedPatch).toContain("hello-fs");
			} else {
				expect(diff.statusPorcelain).not.toContain(path);
			}
		});
	});
}
