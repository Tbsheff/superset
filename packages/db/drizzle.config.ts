import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "drizzle-kit";

export default {
	schema: "./src/schema/index.ts",
	out: "./drizzle",
	dialect: "sqlite",
	dbCredentials: {
		url:
			process.env.SUPERSET_DB_PATH ||
			join(homedir(), ".superset", "superset.db"),
	},
	casing: "snake_case",
} satisfies Config;
