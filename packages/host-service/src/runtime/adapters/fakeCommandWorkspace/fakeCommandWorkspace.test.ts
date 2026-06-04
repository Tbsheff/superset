import { describeRuntimeProviderContract } from "../../contract/index.ts";
import { createFakeCommandWorkspaceAdapter } from "./fakeCommandWorkspace.ts";

// A shared mutable clock so ctx.advanceClock() targets whatever adapter
// ctx.makeAdapter() most recently produced — each sub-contract makes its own
// adapter, and the activity-lease contract needs to cross the hard cap on it.
let clock = 0;

describeRuntimeProviderContract({
	name: "fake-command-workspace",
	makeAdapter: () => {
		clock = 0;
		return createFakeCommandWorkspaceAdapter({ now: () => clock });
	},
	workspacePlan: () => ({
		role: "workspace",
		workspaceId: "fake-command",
		repo: { cloneUrl: "https://example.test/contract.git", ref: "main" },
	}),
	advanceClock: (ms) => {
		clock += ms;
	},
});
