import { describe, expect, test } from "bun:test";
import { descriptorSupportsRole } from "../descriptors/index.ts";
import { describeActivityLeaseContract } from "./describeActivityLeaseContract.ts";
import { describeDiffContract } from "./describeDiffContract.ts";
import { describeFilesystemContract } from "./describeFilesystemContract.ts";
import { describePersistenceContract } from "./describePersistenceContract.ts";
import { describePtyContract } from "./describePtyContract.ts";
import { type ContractContext, defaultWorkspacePlan } from "./types.ts";

const NORMALIZED_STATUS_KINDS = new Set([
	"creating",
	"running",
	"stopped",
	"destroyed",
	"failed",
]);

/**
 * The single entry point. Reads adapter.descriptor and dispatches to the five
 * sub-contracts; each sub-contract gates itself on what the descriptor CLAIMS
 * and cross-checks behavior against the claim, so a PTY-only abstraction cannot
 * masquerade as general — "fails when reality contradicts the descriptor".
 */
export function describeRuntimeProviderContract(ctx: ContractContext): void {
	describe(`RuntimeAdapter contract: ${ctx.name}`, () => {
		const plan = () =>
			ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-structural");

		describe("structural invariants", () => {
			test("descriptor advertises the workspace role", async () => {
				const adapter = await ctx.makeAdapter();
				expect(descriptorSupportsRole(adapter.descriptor, "workspace")).toBe(
					true,
				);
			});

			test("createInstance({role:'workspace'}) yields the workspace handle surface", async () => {
				const adapter = await ctx.makeAdapter();
				const handle = await adapter.createInstance(plan());
				expect(handle.role).toBe("workspace");
				expect(typeof handle.startShell).toBe("function");
				expect(typeof handle.getDiff).toBe("function");
				expect(typeof handle.exposePreview).toBe("function");
				expect(typeof handle.activityLease).toBe("function");
				expect(typeof handle.getStatus).toBe("function");
				expect(typeof handle.stop).toBe("function");
			});

			test("getStatus returns a NormalizedRuntimeStatus, never a raw provider string", async () => {
				const adapter = await ctx.makeAdapter();
				const handle = await adapter.createInstance(plan());
				const status = await adapter.getStatus(handle.externalId);
				expect(NORMALIZED_STATUS_KINDS.has(status.kind)).toBe(true);
			});

			test("destroy(id,'delete') is idempotent", async () => {
				const adapter = await ctx.makeAdapter();
				const handle = await adapter.createInstance(plan());
				await adapter.destroy(handle.externalId, { kind: "delete" });
				// Second call must not throw.
				await adapter.destroy(handle.externalId, { kind: "delete" });
			});
		});

		describePtyContract(ctx);
		describeFilesystemContract(ctx);
		describePersistenceContract(ctx);
		describeActivityLeaseContract(ctx);
		describeDiffContract(ctx);
	});
}
