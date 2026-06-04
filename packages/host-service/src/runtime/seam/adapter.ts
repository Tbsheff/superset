import type { ProviderDescriptor } from "../descriptors/types.ts";
import type { CleanupMode } from "./cleanup.ts";
import type { RuntimePlan } from "./plan.ts";
import type { RuntimeHandleFor, RuntimeRole } from "./roles.ts";
import type { NormalizedRuntimeStatus } from "./status.ts";

export interface RuntimeAdapter {
	readonly descriptor: ProviderDescriptor;
	createInstance<R extends RuntimeRole>(
		plan: RuntimePlan<R>,
	): Promise<RuntimeHandleFor<R>>;
	reconnect(externalId: string): Promise<RuntimeHandleFor<RuntimeRole>>;
	getStatus(externalId: string): Promise<NormalizedRuntimeStatus>;
	destroy(externalId: string, mode: CleanupMode): Promise<void>;
}
