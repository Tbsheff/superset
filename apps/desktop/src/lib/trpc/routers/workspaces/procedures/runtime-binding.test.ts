import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAllWorkspaceRuntimeKinds,
	getWorkspaceOrganizationId,
	resolveWorkspaceRuntimeKind,
} from "main/lib/workspace-runtime";
import { applyRuntimeBinding } from "./runtime-binding";

afterEach(() => {
	clearAllWorkspaceRuntimeKinds();
});

describe("applyRuntimeBinding", () => {
	test("records a remote binding with its organizationId", () => {
		applyRuntimeBinding({
			workspaceId: "ws-remote",
			runtimeKind: "remote",
			organizationId: "org-42",
		});
		expect(resolveWorkspaceRuntimeKind("ws-remote")).toBe("remote");
		expect(getWorkspaceOrganizationId("ws-remote")).toBe("org-42");
	});

	test("a local binding carries no organizationId and overrides remote", () => {
		applyRuntimeBinding({
			workspaceId: "ws-flip",
			runtimeKind: "remote",
			organizationId: "org-1",
		});
		applyRuntimeBinding({ workspaceId: "ws-flip", runtimeKind: "local" });
		expect(resolveWorkspaceRuntimeKind("ws-flip")).toBe("local");
		expect(getWorkspaceOrganizationId("ws-flip")).toBeNull();
	});
});
