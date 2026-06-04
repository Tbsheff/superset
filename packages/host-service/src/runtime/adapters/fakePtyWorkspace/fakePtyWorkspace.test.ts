import { describeRuntimeProviderContract } from "../../contract/index.ts";
import { createFakePtyWorkspaceAdapter } from "./fakePtyWorkspace.ts";

describeRuntimeProviderContract({
	name: "fake-pty-workspace",
	makeAdapter: () => createFakePtyWorkspaceAdapter(),
	workspacePlan: () => ({
		role: "workspace",
		workspaceId: "fake-pty",
		repo: { cloneUrl: "https://example.test/contract.git", ref: "main" },
	}),
});
