import { describeRuntimeProviderContract } from "../../contract/index.ts";
import type { GitFactory } from "../../git/types.ts";
import { DaytonaRuntimeAdapter } from "./adapter.ts";
import {
	FakeDaytonaSdk,
	FakeInstanceStore,
} from "./test-support/fake-sandbox.ts";
import type { TokenMinter } from "./types.ts";

/**
 * The descriptor-driven contract suite run against the Daytona adapter backed by
 * the deterministic in-memory fake SDK. It exercises the SAME assertions as the
 * local + fake-pty adapters: structural invariants, the pty execution surface,
 * filesystem-via-getDiff, the stop+reconnect keep-disk round-trip, the
 * refresh-activity lease, and the staged/unstaged diff surface. A descriptor that
 * lied about any of these would fail here.
 */
describeRuntimeProviderContract({
	name: "daytona (mocked sdk)",
	makeAdapter: () => {
		const sdk = new FakeDaytonaSdk();
		const store = new FakeInstanceStore();
		const mintRepoScopedToken: TokenMinter = async () => ({
			token: "ghs_contract_token",
			expiresAt: Date.now() + 3_600_000,
		});
		const git: GitFactory = (async () => {
			throw new Error("daytona contract: git factory must not be called");
		}) as unknown as GitFactory;
		return new DaytonaRuntimeAdapter({
			sdk,
			store,
			git,
			mintRepoScopedToken,
			now: () => Date.now(),
		});
	},
	workspacePlan: () => ({
		role: "workspace",
		workspaceId: "daytona-contract",
		repo: { cloneUrl: "https://github.com/superset/contract.git", ref: "main" },
	}),
});
