import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	shared: {
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
	},
	server: {
		// Electric SQL — no longer required (local shape server reads SQLite directly)
		ELECTRIC_URL: z.string().url().optional(),
		ELECTRIC_SECRET: z.string().optional(),
		ELECTRIC_SOURCE_ID: z.string().optional(),
		ELECTRIC_SOURCE_SECRET: z.string().optional(),
		BLOB_READ_WRITE_TOKEN: z.string().optional(),
		// GitHub OAuth — optional (only needed when GitHub OAuth is configured)
		GH_CLIENT_ID: z.string().optional(),
		GH_CLIENT_SECRET: z.string().optional(),
		BETTER_AUTH_SECRET: z.string(),
		// Linear integration — optional
		LINEAR_API_TOKEN: z.string().optional(),
		LINEAR_CLIENT_ID: z.string().optional(),
		LINEAR_CLIENT_SECRET: z.string().optional(),
		LINEAR_WEBHOOK_SECRET: z.string().optional(),
		// GitHub App — optional
		GH_APP_ID: z.string().optional(),
		GH_APP_PRIVATE_KEY: z.string().optional(),
		GH_WEBHOOK_SECRET: z.string().optional(),
		// Slack integration — optional
		SLACK_CLIENT_ID: z.string().optional(),
		SLACK_CLIENT_SECRET: z.string().optional(),
		SLACK_SIGNING_SECRET: z.string().optional(),
		ANTHROPIC_API_KEY: z.string().optional(),
		KV_REST_API_URL: z.string().optional(),
		KV_REST_API_TOKEN: z.string().optional(),
		SECRETS_ENCRYPTION_KEY: z.string().optional(),
		SENTRY_AUTH_TOKEN: z.string().optional(),
		DURABLE_STREAMS_URL: z.string().url().optional(),
		DURABLE_STREAMS_SECRET: z.string().optional(),
		TAVILY_API_KEY: z.string().optional(),
	},
	client: {
		NEXT_PUBLIC_API_URL: z.string().url(),
		NEXT_PUBLIC_WEB_URL: z.string().url(),
		NEXT_PUBLIC_ADMIN_URL: z.string().url().optional(),
		NEXT_PUBLIC_DESKTOP_URL: z.string().url().optional(),
		NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
		NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
		NEXT_PUBLIC_SENTRY_DSN_API: z.string().optional(),
		NEXT_PUBLIC_SENTRY_ENVIRONMENT: z
			.enum(["development", "preview", "production"])
			.optional(),
	},
	experimental__runtimeEnv: {
		NODE_ENV: process.env.NODE_ENV,
		NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
		NEXT_PUBLIC_WEB_URL: process.env.NEXT_PUBLIC_WEB_URL,
		NEXT_PUBLIC_ADMIN_URL: process.env.NEXT_PUBLIC_ADMIN_URL,
		NEXT_PUBLIC_DESKTOP_URL: process.env.NEXT_PUBLIC_DESKTOP_URL,
		NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
		NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
		NEXT_PUBLIC_SENTRY_DSN_API: process.env.NEXT_PUBLIC_SENTRY_DSN_API,
		NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
	},
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
