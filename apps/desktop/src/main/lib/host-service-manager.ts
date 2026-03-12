import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

type HostServiceStatus = "starting" | "running" | "crashed";

interface HostServiceProcess {
	process: ChildProcess;
	port: number | null;
	status: HostServiceStatus;
	restartCount: number;
	lastCrash?: number;
}

const MAX_RESTART_DELAY = 30_000;
const BASE_RESTART_DELAY = 1_000;

class HostServiceManager {
	private instance: HostServiceProcess | null = null;
	private scriptPath = path.join(__dirname, "host-service.js");
	private authToken: string | null = null;
	private cloudApiUrl: string | null = null;

	setAuthToken(token: string | null): void {
		this.authToken = token;
	}

	setCloudApiUrl(url: string | null): void {
		this.cloudApiUrl = url;
	}

	async start(): Promise<number> {
		if (this.instance?.status === "running" && this.instance.port !== null) {
			return this.instance.port;
		}
		if (this.instance?.status === "starting") {
			return this.waitForPort();
		}

		return this.spawn();
	}

	stop(): void {
		if (!this.instance) return;

		this.instance.status = "crashed"; // prevent restart
		this.instance.process.kill("SIGTERM");
		this.instance = null;
	}

	stopAll(): void {
		this.stop();
	}

	getPort(): number | null {
		return this.instance?.port ?? null;
	}

	getStatus(): HostServiceStatus | null {
		return this.instance?.status ?? null;
	}

	private async spawn(): Promise<number> {
		const env: Record<string, string | undefined> = {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
		};
		if (this.authToken) {
			env.AUTH_TOKEN = this.authToken;
		}
		if (this.cloudApiUrl) {
			env.CLOUD_API_URL = this.cloudApiUrl;
		}

		const child = spawn(process.execPath, [this.scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		const instance: HostServiceProcess = {
			process: child,
			port: null,
			status: "starting",
			restartCount: 0,
		};

		this.instance = instance;

		child.stderr?.on("data", (data: Buffer) => {
			console.error(`[host-service] ${data.toString().trim()}`);
		});

		child.on("exit", (code) => {
			console.log(`[host-service] exited with code ${code}`);
			if (
				this.instance &&
				this.instance.process === child &&
				this.instance.status !== "crashed"
			) {
				this.instance.status = "crashed";
				this.instance.lastCrash = Date.now();
				this.scheduleRestart();
			}
		});

		return this.waitForPort();
	}

	private waitForPort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const instance = this.instance;
			if (!instance) {
				reject(new Error("Instance not found"));
				return;
			}

			if (instance.port !== null) {
				resolve(instance.port);
				return;
			}

			let buffer = "";
			const onData = (data: Buffer) => {
				buffer += data.toString();
				const newlineIdx = buffer.indexOf("\n");
				if (newlineIdx === -1) return;

				const line = buffer.slice(0, newlineIdx);
				instance.process.stdout?.off("data", onData);

				try {
					const parsed = JSON.parse(line) as { port: number };
					instance.port = parsed.port;
					instance.status = "running";
					console.log(`[host-service] listening on port ${parsed.port}`);
					resolve(parsed.port);
				} catch {
					reject(new Error(`Failed to parse port from host-service: ${line}`));
				}
			};

			instance.process.stdout?.on("data", onData);

			// Timeout after 10s
			setTimeout(() => {
				instance.process.stdout?.off("data", onData);
				reject(new Error("Timeout waiting for host-service port"));
			}, 10_000);
		});
	}

	private scheduleRestart(): void {
		const instance = this.instance;
		if (!instance) return;

		const delay = Math.min(
			BASE_RESTART_DELAY * 2 ** instance.restartCount,
			MAX_RESTART_DELAY,
		);
		instance.restartCount++;

		console.log(
			`[host-service] restarting in ${delay}ms (attempt ${instance.restartCount})`,
		);

		setTimeout(() => {
			if (this.instance?.status === "crashed") {
				this.instance = null;
				this.spawn().catch((err) => {
					console.error("[host-service] restart failed:", err);
				});
			}
		}, delay);
	}
}

let manager: HostServiceManager | null = null;

export function getHostServiceManager(): HostServiceManager {
	if (!manager) {
		manager = new HostServiceManager();
	}
	return manager;
}
