export const GATED_FEATURES = {
	INVITE_MEMBERS: "invite-members",
	INTEGRATIONS: "integrations",
	TASKS: "tasks",
	CLOUD_WORKSPACES: "cloud-workspaces",
	MOBILE_APP: "mobile-app",
} as const;

export type GatedFeature = (typeof GATED_FEATURES)[keyof typeof GATED_FEATURES];
