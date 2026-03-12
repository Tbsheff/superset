import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import type { NextConfig } from "next";

if (process.env.NODE_ENV !== "production") {
	dotenvConfig({
		path: join(process.cwd(), "../../.env"),
		override: true,
		quiet: true,
	});
}

const config: NextConfig = {
	reactCompiler: true,
	typescript: { ignoreBuildErrors: true },

	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "*.public.blob.vercel-storage.com",
			},
		],
	},
};

export default config;
