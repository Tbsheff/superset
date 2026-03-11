import type { GatedFeature } from "./constants";

type UserPlan = "free" | "pro" | "enterprise";

export function usePaywall() {
	const userPlan: UserPlan = "pro";

	function hasAccess(_feature: GatedFeature): boolean {
		return true;
	}

	function gateFeature(
		_feature: GatedFeature,
		callback: () => void | Promise<void>,
		_context?: Record<string, unknown>,
	): void {
		const result = callback();
		if (result instanceof Promise) {
			result.catch((error) => {
				console.error("[paywall] Callback error:", error);
			});
		}
	}

	return {
		hasAccess,
		gateFeature,
		userPlan,
	};
}
