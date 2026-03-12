import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
		POSTHOG_API_KEY: z.string().optional(),
		POSTHOG_API_HOST: z.string().url().default("https://us.posthog.com"),
		POSTHOG_PROJECT_ID: z.string().optional(),
		NEXT_PUBLIC_API_URL: z.string().url().optional(),
		NEXT_PUBLIC_WEB_URL: z.string().url().optional(),
		KV_REST_API_URL: z.string().url().optional(),
		KV_REST_API_TOKEN: z.string().optional(),
		// GitHub App credentials
		GH_APP_ID: z.string().min(1).optional(),
		GH_APP_PRIVATE_KEY: z.string().min(1).optional(),
		GH_WEBHOOK_SECRET: z.string().min(1).optional(),
		SECRETS_ENCRYPTION_KEY: z.string().min(1).optional(),
		ANTHROPIC_API_KEY: z.string().optional(),
	},
	clientPrefix: "PUBLIC_",
	client: {},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
