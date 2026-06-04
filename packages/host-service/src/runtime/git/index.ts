export type {
	DiffCategory,
	FileDiffRequest,
	FileDiffResult,
	WorkspacePatch,
	WorkspacePatchOptions,
} from "./diff-collector";
export {
	collectFileDiff,
	collectWorkspacePatch,
} from "./diff-collector";
export { createGitFactory } from "./git";
export {
	applyPatch,
	assertSameRepoPushTarget,
	classifyPatch,
	type PatchKind,
	type PushRemotePatchDeps,
	type PushRemotePatchInput,
	type PushRemotePatchResult,
	pushRemotePatch,
	type RepoLookup,
} from "./push-remote-patch";
export type { ResolvedRef, ResolveRefOptions } from "./refs";
export {
	asLocalRef,
	asRemoteRef,
	getDefaultBranchName,
	resolveBaseComparison,
	resolveDefaultBranchName,
	resolveRef,
	resolveUpstream,
} from "./refs";
export type { GitCredentialProvider, GitFactory } from "./types";
