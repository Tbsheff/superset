import { randomBytes } from "node:crypto";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		HOST_SERVICE_SECRET: z
			.string()
			.min(1)
			.default(randomBytes(32).toString("hex")),
		ORGANIZATION_ID: z.string().uuid(),
		HOST_DB_PATH: z.string().min(1),
		HOST_MIGRATIONS_FOLDER: z.string().min(1),
		AUTH_TOKEN: z.string().min(1),
		SUPERSET_AUTH_CONFIG_PATH: z.string().min(1).optional(),
		SUPERSET_API_URL: z.string().url(),
		CORS_ORIGINS: z
			.string()
			.transform((s) => s.split(",").map((o) => o.trim()))
			.optional(),
		PORT: z.coerce.number().int().positive().default(4879),
		RELAY_URL: z.string().url().optional(),
		// Daytona is optional so a host with no remote-runtime config still boots;
		// the adapter throws a clear CONFIG_MISSING error only when selected.
		// Two auth modes: an API key, OR a JWT + organization id (the SDK rejects a
		// JWT without an org id). resolveDaytonaCredentials picks between them.
		DAYTONA_API_KEY: z.string().min(1).optional(),
		DAYTONA_JWT_TOKEN: z.string().min(1).optional(),
		DAYTONA_ORGANIZATION_ID: z.string().min(1).optional(),
		DAYTONA_API_URL: z.string().url().optional(),
		DAYTONA_TARGET: z.string().min(1).optional(),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
