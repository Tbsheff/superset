/**
 * SSH Connection Manager
 *
 * Manages SSH connections to remote hosts. One ssh2.Client per hostId,
 * cached in a Map. Handles connect/disconnect/reconnect with exponential backoff.
 */

import { EventEmitter } from "node:events";
import type { Client, ConnectConfig } from "ssh2";

export type SshConnectionStatus =
	| "connected"
	| "connecting"
	| "disconnected"
	| "error";

export interface SshHostConfig {
	id: string;
	hostname: string;
	port: number;
	username: string;
	authMethod: "key" | "agent" | "password";
	privateKeyPath?: string;
	password?: string;
	defaultCwd?: string;
}

interface ManagedConnection {
	client: Client;
	config: SshHostConfig;
	status: SshConnectionStatus;
	reconnectAttempts: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 3;

export class SshConnectionManager extends EventEmitter {
	private connections = new Map<string, ManagedConnection>();

	async connect(config: SshHostConfig): Promise<Client> {
		const existing = this.connections.get(config.id);
		if (existing?.status === "connected") {
			return existing.client;
		}

		if (existing?.status === "connecting") {
			return new Promise((resolve, reject) => {
				const onConnected = () => {
					this.off(`error:${config.id}`, onError);
					resolve(existing.client);
				};
				const onError = (err: Error) => {
					this.off(`connected:${config.id}`, onConnected);
					reject(err);
				};
				this.once(`connected:${config.id}`, onConnected);
				this.once(`error:${config.id}`, onError);
			});
		}

		return this.createConnection(config);
	}

	private async createConnection(config: SshHostConfig): Promise<Client> {
		// Dynamic import ssh2 to avoid loading it at startup
		const { Client: SshClient } = await import("ssh2");
		const client = new SshClient();

		const managed: ManagedConnection = {
			client,
			config,
			status: "connecting",
			reconnectAttempts: 0,
			reconnectTimer: null,
		};
		this.connections.set(config.id, managed);
		this.emit(`status:${config.id}`, "connecting" as SshConnectionStatus);

		return new Promise<Client>((resolve, reject) => {
			client.on("ready", () => {
				managed.status = "connected";
				managed.reconnectAttempts = 0;
				this.emit(`connected:${config.id}`);
				this.emit(`status:${config.id}`, "connected" as SshConnectionStatus);
				resolve(client);
			});

			client.on("error", (err: Error) => {
				const wasConnecting = managed.status === "connecting";
				managed.status = "error";
				this.emit(`error:${config.id}`, err);
				this.emit(`status:${config.id}`, "error" as SshConnectionStatus);
				if (wasConnecting) {
					reject(err);
				}
			});

			client.on("close", () => {
				const prev = managed.status;
				managed.status = "disconnected";
				this.emit(`disconnected:${config.id}`);
				this.emit(`status:${config.id}`, "disconnected" as SshConnectionStatus);

				// Auto-reconnect if was previously connected (not during initial connect)
				if (prev === "connected") {
					this.scheduleReconnect(config.id);
				}
			});

			client.on("end", () => {
				managed.status = "disconnected";
			});

			const connectConfig = this.buildConnectConfig(config);
			client.connect(connectConfig);
		});
	}

	private buildConnectConfig(config: SshHostConfig): ConnectConfig {
		const base: ConnectConfig = {
			host: config.hostname,
			port: config.port,
			username: config.username,
			keepaliveInterval: KEEPALIVE_INTERVAL_MS,
			keepaliveCountMax: KEEPALIVE_COUNT_MAX,
		};

		switch (config.authMethod) {
			case "agent":
				base.agent = process.env.SSH_AUTH_SOCK;
				break;
			case "key":
				if (config.privateKeyPath) {
					// Read key file synchronously — only happens on connect
					const fs = require("node:fs");
					base.privateKey = fs.readFileSync(config.privateKeyPath);
				}
				break;
			case "password":
				base.password = config.password;
				break;
		}

		return base;
	}

	private scheduleReconnect(hostId: string): void {
		const managed = this.connections.get(hostId);
		if (!managed) return;

		if (managed.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			console.warn(
				`[SshConnectionManager] Max reconnect attempts reached for ${hostId}`,
			);
			return;
		}

		const delay = BASE_RECONNECT_DELAY_MS * 2 ** managed.reconnectAttempts;
		managed.reconnectAttempts++;

		this.emit(`reconnecting:${hostId}`, {
			attempt: managed.reconnectAttempts,
			maxAttempts: MAX_RECONNECT_ATTEMPTS,
			delayMs: delay,
		});
		this.emit(`status:${hostId}`, "connecting" as SshConnectionStatus);

		managed.reconnectTimer = setTimeout(async () => {
			try {
				await this.createConnection(managed.config);
			} catch {
				// Error already handled in createConnection
			}
		}, delay);
	}

	disconnect(hostId: string): void {
		const managed = this.connections.get(hostId);
		if (!managed) return;

		if (managed.reconnectTimer) {
			clearTimeout(managed.reconnectTimer);
			managed.reconnectTimer = null;
		}

		managed.client.end();
		this.connections.delete(hostId);
		this.emit(`status:${hostId}`, "disconnected" as SshConnectionStatus);
	}

	getConnection(hostId: string): Client | null {
		const managed = this.connections.get(hostId);
		return managed?.status === "connected" ? managed.client : null;
	}

	getStatus(hostId: string): SshConnectionStatus {
		return this.connections.get(hostId)?.status ?? "disconnected";
	}

	disconnectAll(): void {
		for (const hostId of this.connections.keys()) {
			this.disconnect(hostId);
		}
	}
}

// Singleton
let instance: SshConnectionManager | null = null;

export function getSshConnectionManager(): SshConnectionManager {
	if (!instance) {
		instance = new SshConnectionManager();
	}
	return instance;
}
