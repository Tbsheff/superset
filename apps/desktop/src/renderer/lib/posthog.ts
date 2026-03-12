// Stubbed — PostHog removed
export const posthog = {
	identify: (..._args: unknown[]) => {},
	capture: (..._args: unknown[]) => {},
	reset: () => {},
	reloadFeatureFlags: () => {},
	register: (_props: Record<string, unknown>) => {},
	opt_in_capturing: () => {},
	opt_out_capturing: () => {},
};

export function initPostHog() {}
