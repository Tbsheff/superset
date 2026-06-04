import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAllWorkspaceRuntimeKinds,
	clearWorkspaceRuntimeKind,
	getWorkspaceOrganizationId,
	resolveWorkspaceRuntimeKind,
	setWorkspaceLocal,
	setWorkspaceRemote,
} from "./workspaceRuntimeBindingStore";

afterEach(() => {
	clearAllWorkspaceRuntimeKinds();
});

describe("workspaceRuntimeBindingStore", () => {
	test("defaults unknown workspaces to local", () => {
		expect(resolveWorkspaceRuntimeKind("never-seen")).toBe("local");
		expect(getWorkspaceOrganizationId("never-seen")).toBeNull();
	});

	test("records a remote binding with its organizationId", () => {
		setWorkspaceRemote("ws-1", "org-7");
		expect(resolveWorkspaceRuntimeKind("ws-1")).toBe("remote");
		expect(getWorkspaceOrganizationId("ws-1")).toBe("org-7");
	});

	test("local binding carries no organizationId", () => {
		setWorkspaceLocal("ws-2");
		expect(resolveWorkspaceRuntimeKind("ws-2")).toBe("local");
		expect(getWorkspaceOrganizationId("ws-2")).toBeNull();
	});

	test("a later local binding overrides an earlier remote one", () => {
		setWorkspaceRemote("ws-3", "org-1");
		setWorkspaceLocal("ws-3");
		expect(resolveWorkspaceRuntimeKind("ws-3")).toBe("local");
		expect(getWorkspaceOrganizationId("ws-3")).toBeNull();
	});

	test("clearing a binding reverts it to the local default", () => {
		setWorkspaceRemote("ws-4", "org-2");
		clearWorkspaceRuntimeKind("ws-4");
		expect(resolveWorkspaceRuntimeKind("ws-4")).toBe("local");
		expect(getWorkspaceOrganizationId("ws-4")).toBeNull();
	});
});
