import { describe, expect, test } from "bun:test";
import { descriptorHasWritableFilesystem } from "../descriptors/index.ts";
import { mutateFs } from "./mutateFs.ts";
import {
	CONTRACT_SHELL_COMMANDS,
	type ContractContext,
	defaultWorkspacePlan,
} from "./types.ts";

/**
 * Asserts getDiff() and getDiff({ staged: true }) both return the RuntimeDiff
 * shape AND reflect files mutated through the handle: an unstaged write appears
 * in the unstaged diff; after STAGE it appears in the staged diff. This is the
 * contract Phase D's diff-collector and Phase F's Daytona adapter must satisfy
 * unchanged.
 */
export function describeDiffContract(ctx: ContractContext): void {
	const plan = () => ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-diff");

	describe("diff contract", () => {
		test("getDiff and getDiff({staged:true}) both return RuntimeDiff", async () => {
			const adapter = await ctx.makeAdapter();
			const handle = await adapter.createInstance(plan());
			const unstaged = await handle.getDiff();
			const staged = await handle.getDiff({ staged: true });
			expect(typeof unstaged.statusPorcelain).toBe("string");
			expect(typeof unstaged.unifiedPatch).toBe("string");
			expect(typeof staged.statusPorcelain).toBe("string");
			expect(typeof staged.unifiedPatch).toBe("string");
		});

		test("staged vs unstaged diff reflects what the handle mutated", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorHasWritableFilesystem(adapter.descriptor)) return;
			const handle = await adapter.createInstance(plan());
			const path = "contract-diff.txt";
			await mutateFs(
				handle,
				adapter.descriptor,
				CONTRACT_SHELL_COMMANDS.write(path, "diff-body"),
			);

			const unstaged = await handle.getDiff();
			expect(unstaged.unifiedPatch).toContain("diff-body");

			await mutateFs(
				handle,
				adapter.descriptor,
				CONTRACT_SHELL_COMMANDS.stage(path),
			);
			const staged = await handle.getDiff({ staged: true });
			expect(staged.statusPorcelain).toContain(path);
		});
	});
}
