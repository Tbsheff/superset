export { LOCAL_WORKTREE_DESCRIPTOR } from "./localWorktree.ts";
export type {
	ActivityStrategy,
	DurableStore,
	EgressMode,
	ExecutionSurface,
	FilesystemFacet,
	IngressMode,
	OnStop,
	ProviderDescriptor,
} from "./types.ts";
export {
	descriptorHasWritableFilesystem,
	descriptorRetainsDiskOnStop,
	descriptorSupportsActivity,
	descriptorSupportsEgress,
	descriptorSupportsExecution,
	descriptorSupportsFilesystem,
	descriptorSupportsOnStop,
	descriptorSupportsRole,
} from "./types.ts";
