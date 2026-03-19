/**
 * SSH Connection Manager
 *
 * Manages SSH connections to remote hosts. One ssh2.Client per hostId,
 * cached in a Map. Handles connect/disconnect/reconnect with exponential backoff.
 *
 * Mirrors OpenSSH behavior:
 * - Parses ~/.ssh/config to resolve per-host IdentityFile, User, Port, etc.
 * - Falls back through all default identity files (ed25519, rsa, ecdsa, dsa)
 * - Supports keyboard-interactive auth as fallback
 * - Reads passphrases from macOS Keychain for encrypted keys
 */

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getShellEnvironment } from "lib/trpc/routers/workspaces/utils/shell-env";
import SSHConfig from "ssh-config";
import type { Client, ConnectConfig } from "ssh2";

const execFileAsync = promisify(execFile);

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

/** Resolved settings from ~/.ssh/config for a given host */
interface ResolvedSshConfig {
	hostname: string;
	port: number;
	user: string | null;
	identityFiles: string[];
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 3;

/** Default identity file names in OpenSSH search order */
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];

export class SshConnectionManager extends EventEmitter {
	private connections = new Map<string, ManagedConnection>();

	async connect(config: SshHostConfig): Promise<Client> {
		console.log("[ssh-conn] connect:", config.hostname, config.username);
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

		const connectConfig = await this.buildConnectConfig(config);

		console.log("[ssh-conn] Calling client.connect with config:", {
			host: connectConfig.host,
			port: connectConfig.port,
			username: connectConfig.username,
			hasAgent: !!connectConfig.agent,
			hasPrivateKey: !!connectConfig.privateKey,
		});

		return new Promise<Client>((resolve, reject) => {
			client.on("ready", () => {
				console.log("[ssh-conn] Client ready!");
				managed.status = "connected";
				managed.reconnectAttempts = 0;
				this.emit(`connected:${config.id}`);
				this.emit(`status:${config.id}`, "connected" as SshConnectionStatus);
				resolve(client);
			});

			client.on("error", (err: Error) => {
				console.log("[ssh-conn] Client error:", err.message);
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

			// Handle keyboard-interactive auth (e.g. password prompts from the server)
			client.on(
				"keyboard-interactive",
				(_name, _instructions, _instructionsLang, prompts, finish) => {
					// If a password was provided, send it for each prompt
					if (config.password && prompts.length > 0) {
						finish([config.password]);
					} else {
						// No password available, send empty responses
						finish(Array(prompts.length).fill(""));
					}
				},
			);

			client.connect(connectConfig);
		});
	}

	private async buildConnectConfig(
		config: SshHostConfig,
	): Promise<ConnectConfig> {
		// Resolve SSH config for this host (parses ~/.ssh/config)
		const resolved = await this.resolveHostConfig(config.hostname);

		const base: ConnectConfig = {
			host: config.hostname,
			port: config.port,
			username: config.username,
			keepaliveInterval: KEEPALIVE_INTERVAL_MS,
			keepaliveCountMax: KEEPALIVE_COUNT_MAX,
			// Enable keyboard-interactive as a fallback auth method
			tryKeyboard: true,
		};

		switch (config.authMethod) {
			case "agent": {
				// Electron GUI apps on macOS don't inherit SSH_AUTH_SOCK from the
				// user's shell. Resolve the full shell environment to find it.
				const shellEnv = await getShellEnvironment();
				const agentSock = shellEnv.SSH_AUTH_SOCK || process.env.SSH_AUTH_SOCK;
				if (agentSock) {
					base.agent = agentSock;
					base.agentForward = true;
				}

				// Try keys from SSH config first, then fall back to defaults.
				// This mirrors OpenSSH behavior of checking config-specified keys
				// before the default identity files.
				const privateKey = await this.readFirstAvailableKey(
					resolved.identityFiles,
				);
				if (privateKey) {
					base.privateKey = privateKey.key;
					if (privateKey.passphrase) {
						base.passphrase = privateKey.passphrase;
					}
				}
				break;
			}
			case "key": {
				if (config.privateKeyPath) {
					const expandedPath = config.privateKeyPath.replace(/^~/, homedir());
					try {
						const key = fs.readFileSync(expandedPath);
						base.privateKey = key;

						// Unconditionally try Keychain — harmless if key isn't encrypted
						const passphrase =
							await this.getPassphraseFromKeychain(expandedPath);
						if (passphrase) {
							base.passphrase = passphrase;
						}
					} catch {
						// Key file not readable, connection will fail with clear error
					}
				} else {
					// No explicit key path — try SSH config keys then defaults
					const privateKey = await this.readFirstAvailableKey(
						resolved.identityFiles,
					);
					if (privateKey) {
						base.privateKey = privateKey.key;
						if (privateKey.passphrase) {
							base.passphrase = privateKey.passphrase;
						}
					}
				}
				break;
			}
			case "password":
				base.password = config.password;
				break;
		}

		return base;
	}

	/**
	 * Parse ~/.ssh/config and resolve settings for a given hostname.
	 * Returns identity files (from config + defaults), resolved hostname, port, user.
	 */
	private async resolveHostConfig(
		hostname: string,
	): Promise<ResolvedSshConfig> {
		const sshDir = join(homedir(), ".ssh");
		const configPath = join(sshDir, "config");
		const identityFiles: string[] = [];

		try {
			const content = fs.readFileSync(configPath, "utf-8");
			const config = SSHConfig.parse(content);
			const computed = config.compute(hostname);

			// Collect IdentityFile entries from config
			const rawIdentityFile = computed.IdentityFile;
			if (rawIdentityFile) {
				const files = Array.isArray(rawIdentityFile)
					? rawIdentityFile
					: [rawIdentityFile];
				for (const f of files) {
					const expanded = f.replace(/^~/, homedir());
					identityFiles.push(expanded);
				}
			}

			// Collect resolved hostname, port, user
			const resolvedHostname = Array.isArray(computed.HostName)
				? computed.HostName[0]
				: (computed.HostName ?? hostname);
			const rawPort = Array.isArray(computed.Port)
				? computed.Port[0]
				: computed.Port;
			const resolvedPort = rawPort ? Number.parseInt(rawPort, 10) : 22;
			const resolvedUser = Array.isArray(computed.User)
				? (computed.User[0] ?? null)
				: (computed.User ?? null);

			// Always append default key paths as fallbacks (OpenSSH does this)
			for (const name of DEFAULT_KEY_NAMES) {
				const keyPath = join(sshDir, name);
				if (!identityFiles.includes(keyPath)) {
					identityFiles.push(keyPath);
				}
			}

			return {
				hostname: resolvedHostname,
				port: resolvedPort,
				user: resolvedUser,
				identityFiles,
			};
		} catch {
			// No SSH config or parse error — use defaults only
			for (const name of DEFAULT_KEY_NAMES) {
				identityFiles.push(join(sshDir, name));
			}
			return {
				hostname,
				port: 22,
				user: null,
				identityFiles,
			};
		}
	}

	/**
	 * Try reading each key file in order. Returns the first readable key
	 * along with its passphrase (from macOS Keychain) if encrypted.
	 */
	private async readFirstAvailableKey(
		keyPaths: string[],
	): Promise<{ key: Buffer; passphrase?: string } | null> {
		for (const keyPath of keyPaths) {
			try {
				const key = fs.readFileSync(keyPath);

				// Try to get a passphrase from macOS Keychain (for encrypted keys).
				// If the key isn't encrypted, the passphrase is simply ignored by ssh2.
				const passphrase = await this.getPassphraseFromKeychain(keyPath);
				if (passphrase) {
					return { key, passphrase };
				}

				return { key };
			} catch {
				// File doesn't exist or isn't readable, try next
			}
		}
		return null;
	}

	/**
	 * Attempt to read an SSH key passphrase from the macOS Keychain.
	 * OpenSSH on macOS stores passphrases under the "SSH" service with
	 * the key file path as the account.
	 */
	private async getPassphraseFromKeychain(
		keyPath: string,
	): Promise<string | null> {
		if (process.platform !== "darwin") return null;

		try {
			// macOS Keychain stores SSH passphrases with service "SSH" and
			// the absolute key path as the account name
			const { stdout } = await execFileAsync("security", [
				"find-generic-password",
				"-s",
				"SSH",
				"-a",
				keyPath,
				"-w",
			]);
			return stdout.trim() || null;
		} catch {
			// Not found in Keychain or Keychain access denied
			return null;
		}
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
