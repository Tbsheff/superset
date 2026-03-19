import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import reactPlugin from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { config } from "dotenv";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import injectProcessEnvPlugin from "rollup-plugin-inject-process-env";
import tsconfigPathsPlugin from "vite-tsconfig-paths";
import { dependencies, resources, version } from "./package.json";
import { mainExternalizedDependencies } from "./runtime-dependencies";
import {
	copyResourcesPlugin,
	defineEnv,
	devPath,
	htmlEnvTransformPlugin,
} from "./vite/helpers";

// override: true ensures .env values take precedence over inherited env vars
config({ path: resolve(__dirname, "../../.env"), override: true, quiet: true });

const DEV_SERVER_PORT = Number(process.env.DESKTOP_VITE_PORT);

// Validate required env vars at build time using the Zod schema (single source of truth)
await import("./src/main/env.main");

const tsconfigPaths = tsconfigPathsPlugin({
	projects: [resolve("tsconfig.json")],
});

const workspaceDependencies = Object.keys(dependencies).filter((dependency) =>
	dependency.startsWith("@superset/"),
);

export default defineConfig({
	main: {
		plugins: [tsconfigPaths, copyResourcesPlugin()],

		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV, "production"),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			"process.env.NEXT_PUBLIC_API_URL": defineEnv(
				process.env.NEXT_PUBLIC_API_URL,
			),
			"process.env.NEXT_PUBLIC_STREAMS_URL": defineEnv(
				process.env.NEXT_PUBLIC_STREAMS_URL,
				"https://streams.superset.sh",
			),
			"process.env.NEXT_PUBLIC_WEB_URL": defineEnv(
				process.env.NEXT_PUBLIC_WEB_URL,
				"https://app.superset.sh",
			),
			"process.env.NEXT_PUBLIC_DOCS_URL": defineEnv(
				process.env.NEXT_PUBLIC_DOCS_URL,
				"https://docs.superset.sh",
			),
			// Must match renderer for analytics in main process
			"process.env.NEXT_PUBLIC_POSTHOG_KEY": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_KEY,
			),
			"process.env.NEXT_PUBLIC_POSTHOG_HOST": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_HOST,
			),
			"process.env.STREAMS_URL": defineEnv(
				process.env.STREAMS_URL,
				"https://superset-stream.fly.dev",
			),
			"process.env.DESKTOP_VITE_PORT": defineEnv(process.env.DESKTOP_VITE_PORT),
			"process.env.DESKTOP_NOTIFICATIONS_PORT": defineEnv(
				process.env.DESKTOP_NOTIFICATIONS_PORT,
			),
			"process.env.ELECTRIC_PORT": defineEnv(process.env.ELECTRIC_PORT),
			"process.env.SUPERSET_WORKSPACE_NAME": defineEnv(
				process.env.SUPERSET_WORKSPACE_NAME,
			),
			"process.env.NEXT_PUBLIC_OUTLIT_KEY": defineEnv(
				process.env.NEXT_PUBLIC_OUTLIT_KEY,
			),
		},

		build: {
			sourcemap: true,
			rollupOptions: {
				input: {
					index: resolve("src/main/index.ts"),
					// Terminal host daemon process - runs separately for terminal persistence
					"terminal-host": resolve("src/main/terminal-host/index.ts"),
					// PTY subprocess - spawned by terminal-host for each terminal
					"pty-subprocess": resolve("src/main/terminal-host/pty-subprocess.ts"),
					// Worker-thread entrypoint for heavy git/status computations
					"git-task-worker": resolve("src/main/git-task-worker.ts"),
					// Workspace service - local HTTP/tRPC server per org
					"host-service": resolve("src/main/host-service/index.ts"),
				},
				output: {
					dir: resolve(devPath, "main"),
				},
				external: ["electron", ...mainExternalizedDependencies],
			},
		},
		resolve: {
			alias: {
				// @xterm/headless 6.0.0 has a packaging bug: `module` field points to
				// non-existent `lib/xterm.mjs`. Force Vite to use the CJS entry instead.
				"@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.js",
			},
		},
	},

	preload: {
		plugins: [
			tsconfigPaths,
			externalizeDepsPlugin({
				exclude: ["trpc-electron", ...workspaceDependencies],
			}),
		],

		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV, "production"),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			__APP_VERSION__: defineEnv(version),
		},

		build: {
			outDir: resolve(devPath, "preload"),
			rollupOptions: {
				input: {
					index: resolve("src/preload/index.ts"),
				},
			},
		},
	},

	renderer: {
		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			"process.platform": defineEnv(process.platform),
			"process.env.NEXT_PUBLIC_API_URL": defineEnv(
				process.env.NEXT_PUBLIC_API_URL,
			),
			"process.env.NEXT_PUBLIC_WEB_URL": defineEnv(
				process.env.NEXT_PUBLIC_WEB_URL,
				"https://app.superset.sh",
			),
			"process.env.NEXT_PUBLIC_DOCS_URL": defineEnv(
				process.env.NEXT_PUBLIC_DOCS_URL,
				"https://docs.superset.sh",
			),
			"import.meta.env.DEV_SERVER_PORT": defineEnv(String(DEV_SERVER_PORT)),
			"import.meta.env.NEXT_PUBLIC_POSTHOG_KEY": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_KEY,
			),
			"import.meta.env.NEXT_PUBLIC_POSTHOG_HOST": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_HOST,
			),
			"process.env.STREAMS_URL": defineEnv(
				process.env.STREAMS_URL,
				"https://superset-stream.fly.dev",
			),
			"process.env.DESKTOP_VITE_PORT": defineEnv(process.env.DESKTOP_VITE_PORT),
			"process.env.DESKTOP_NOTIFICATIONS_PORT": defineEnv(
				process.env.DESKTOP_NOTIFICATIONS_PORT,
			),
			"process.env.ELECTRIC_PORT": defineEnv(process.env.ELECTRIC_PORT),
			"process.env.SUPERSET_WORKSPACE_NAME": defineEnv(
				process.env.SUPERSET_WORKSPACE_NAME,
			),
			"import.meta.env.NEXT_PUBLIC_OUTLIT_KEY": defineEnv(
				process.env.NEXT_PUBLIC_OUTLIT_KEY,
			),
		},

		server: {
			port: DEV_SERVER_PORT,
			strictPort: false,
		},

		plugins: [
			tanstackRouter({
				target: "react",
				routesDirectory: resolve("src/renderer/routes"),
				generatedRouteTree: resolve("src/renderer/routeTree.gen.ts"),
				indexToken: "page",
				routeToken: "layout",
				autoCodeSplitting: true,
				routeFileIgnorePattern:
					"^(?!(__root|page|layout)\\.tsx$).*\\.(tsx?|jsx?)$",
			}),
			tsconfigPaths,
			tailwindcss(),
			codeInspectorPlugin({
				bundler: "vite",
				hotKeys: ["altKey"],
				hideConsole: true,
				port: Number(process.env.CODE_INSPECTOR_PORT) || undefined,
			}),
			reactPlugin(),
			htmlEnvTransformPlugin(),
		],

		worker: {
			format: "es",
		},

		optimizeDeps: {
			exclude: ["restty"],
		},

		publicDir: resolve(resources, "public"),

		build: {
			sourcemap: process.env.NODE_ENV === "production",
			outDir: resolve(devPath, "renderer"),

			rollupOptions: {
				plugins: [
					injectProcessEnvPlugin({
						NODE_ENV: "production",
						platform: process.platform,
					}),
				],

				input: {
					index: resolve("src/renderer/index.html"),
				},
			},
		},
	},
});
