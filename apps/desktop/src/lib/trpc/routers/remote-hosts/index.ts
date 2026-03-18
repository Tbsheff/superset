import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remoteHosts } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { getSshConnectionManager } from "main/lib/workspace-runtime/ssh-connection-manager";
import SSHConfig from "ssh-config";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { publicProcedure, router } from "../..";

async function parseConfigHosts(): Promise<
	Array<{
		name: string;
		hostname: string | null;
		port: number;
		username: string | null;
		identityFile: string | null;
	}>
> {
	const configPath = join(homedir(), ".ssh", "config");
	try {
		const content = await readFile(configPath, "utf-8");
		const config = SSHConfig.parse(content);

		const hosts: Array<{
			name: string;
			hostname: string | null;
			port: number;
			username: string | null;
			identityFile: string | null;
		}> = [];

		for (const entry of config) {
			if (entry.type !== SSHConfig.DIRECTIVE || entry.param !== "Host") {
				continue;
			}

			const rawValue = entry.value;
			const hostPattern =
				typeof rawValue === "string"
					? rawValue
					: rawValue.map((t) => t.val).join(" ");

			if (
				!hostPattern ||
				hostPattern === "*" ||
				hostPattern.includes("*") ||
				hostPattern.includes("?")
			) {
				continue;
			}

			const hostConfig = config.compute(hostPattern);

			const rawIdentityFile = hostConfig.IdentityFile;
			const identityFile = Array.isArray(rawIdentityFile)
				? (rawIdentityFile[0] ?? null)
				: (rawIdentityFile ?? null);

			const rawPort = hostConfig.Port;
			const port = rawPort
				? Number.parseInt(Array.isArray(rawPort) ? rawPort[0] : rawPort, 10)
				: 22;

			const rawHostname = hostConfig.HostName;
			const hostname = Array.isArray(rawHostname)
				? (rawHostname[0] ?? null)
				: (rawHostname ?? null);

			const rawUser = hostConfig.User;
			const username = Array.isArray(rawUser)
				? (rawUser[0] ?? null)
				: (rawUser ?? null);

			hosts.push({ name: hostPattern, hostname, port, username, identityFile });
		}

		return hosts;
	} catch {
		return [];
	}
}

async function parseKnownHosts(): Promise<
	Array<{ hostname: string; port: number }>
> {
	const knownHostsPath = join(homedir(), ".ssh", "known_hosts");
	try {
		const content = await readFile(knownHostsPath, "utf-8");
		const seen = new Set<string>();
		const hosts: Array<{ hostname: string; port: number }> = [];

		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("|")) {
				continue;
			}

			const hostField = trimmed.split(/\s+/)[0];
			if (!hostField) continue;

			for (const entry of hostField.split(",")) {
				let hostname = entry;
				let port = 22;

				const bracketMatch = hostname.match(/^\[(.+?)\]:(\d+)$/);
				if (bracketMatch) {
					hostname = bracketMatch[1];
					port = Number.parseInt(bracketMatch[2], 10);
				}

				if (
					hostname === "localhost" ||
					hostname === "127.0.0.1" ||
					hostname === "::1"
				) {
					continue;
				}

				const key = `${hostname}:${port}`;
				if (!seen.has(key)) {
					seen.add(key);
					hosts.push({ hostname, port });
				}
			}
		}

		return hosts;
	} catch {
		return [];
	}
}

async function parseHistoryHosts(): Promise<
	Array<{ hostname: string; username: string | null; port: number }>
> {
	const hosts: Array<{
		hostname: string;
		username: string | null;
		port: number;
	}> = [];
	const seen = new Set<string>();

	const historyPaths = [
		join(homedir(), ".zsh_history"),
		join(homedir(), ".bash_history"),
	];

	for (const histPath of historyPaths) {
		try {
			const content = await readFile(histPath, "utf-8");
			for (const line of content.split("\n")) {
				const command = line.replace(/^:\s*\d+:\d+;/, "").trim();
				if (!command.startsWith("ssh ")) continue;

				// Strip options and flags to find user@host
				// Remove known flag-value pairs: -p port, -i key, -l user, -o option, etc.
				let rest = command.slice(4).trim();

				// Extract -p port if present
				let port = 22;
				const portMatch = rest.match(/(?:^|\s)-p\s+(\d+)/);
				if (portMatch) {
					port = Number.parseInt(portMatch[1], 10);
					rest = rest.replace(portMatch[0], " ");
				}

				// Strip remaining flags (single-char flags with optional value)
				rest = rest.replace(/-[a-zA-Z](?:\s+\S+)?/g, "").trim();

				// Last non-option token is [user@]host
				const tokens = rest.split(/\s+/).filter((t) => t && !t.startsWith("-"));
				const target = tokens[tokens.length - 1];
				if (!target) continue;

				let username: string | null = null;
				let hostname = target;
				if (target.includes("@")) {
					const atIdx = target.indexOf("@");
					username = target.slice(0, atIdx);
					hostname = target.slice(atIdx + 1);
				}

				if (
					!hostname ||
					hostname.startsWith("-") ||
					hostname.includes("/") ||
					hostname === "localhost" ||
					hostname === "127.0.0.1"
				) {
					continue;
				}

				const key = `${username ?? ""}@${hostname}:${port}`;
				if (!seen.has(key)) {
					seen.add(key);
					hosts.push({ hostname, username, port });
				}
			}
		} catch {
			// History file not found, skip
		}
	}

	return hosts;
}

export const createRemoteHostsRouter = () => {
	return router({
		list: publicProcedure.query(() => {
			return localDb.select().from(remoteHosts).all();
		}),

		get: publicProcedure.input(z.string()).query(({ input: id }) => {
			return localDb
				.select()
				.from(remoteHosts)
				.where(eq(remoteHosts.id, id))
				.get();
		}),

		create: publicProcedure
			.input(
				z.object({
					name: z.string().min(1),
					type: z.enum(["ssh", "cloud-sandbox"]),
					hostname: z.string().optional(),
					port: z.number().optional(),
					username: z.string().optional(),
					authMethod: z.enum(["key", "agent", "password"]).optional(),
					privateKeyPath: z.string().optional(),
					defaultCwd: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const id = uuidv4();
				const now = Date.now();
				localDb
					.insert(remoteHosts)
					.values({
						id,
						name: input.name,
						type: input.type,
						hostname: input.hostname,
						port: input.port ?? 22,
						username: input.username,
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath,
						defaultCwd: input.defaultCwd,
						createdAt: now,
						updatedAt: now,
					})
					.run();

				return localDb
					.select()
					.from(remoteHosts)
					.where(eq(remoteHosts.id, id))
					.get();
			}),

		update: publicProcedure
			.input(
				z.object({
					id: z.string(),
					name: z.string().min(1).optional(),
					hostname: z.string().optional(),
					port: z.number().optional(),
					username: z.string().optional(),
					authMethod: z.enum(["key", "agent", "password"]).optional(),
					privateKeyPath: z.string().optional(),
					defaultCwd: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...updates } = input;
				localDb
					.update(remoteHosts)
					.set({ ...updates, updatedAt: Date.now() })
					.where(eq(remoteHosts.id, id))
					.run();

				return localDb
					.select()
					.from(remoteHosts)
					.where(eq(remoteHosts.id, id))
					.get();
			}),

		delete: publicProcedure.input(z.string()).mutation(({ input: id }) => {
			// Disconnect any active SSH connection
			const manager = getSshConnectionManager();
			manager.disconnect(id);

			// Delete host (workspace FK auto-nulled via onDelete: "set null")
			localDb.delete(remoteHosts).where(eq(remoteHosts.id, id)).run();
			return { success: true };
		}),

		testConnection: publicProcedure
			.input(
				z.object({
					hostname: z.string(),
					port: z.number().optional(),
					username: z.string(),
					authMethod: z.enum(["key", "agent", "password"]),
					privateKeyPath: z.string().optional(),
					password: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const manager = getSshConnectionManager();
				const testId = `test-${Date.now()}`;

				try {
					await manager.connect({
						id: testId,
						hostname: input.hostname,
						port: input.port ?? 22,
						username: input.username,
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath,
						password: input.password,
					});

					// Successful — clean up test connection
					manager.disconnect(testId);
					return { success: true, error: null };
				} catch (err) {
					manager.disconnect(testId);
					return {
						success: false,
						error: err instanceof Error ? err.message : "Connection failed",
					};
				}
			}),

		connectionStatus: publicProcedure
			.input(z.string())
			.query(({ input: hostId }) => {
				const manager = getSshConnectionManager();
				return { status: manager.getStatus(hostId) };
			}),

		parseSshConfig: publicProcedure.query(async () => {
			const hosts = await parseConfigHosts();
			return { hosts, error: null };
		}),

		discoverHosts: publicProcedure.query(async () => {
			const [configResult, knownResult, history] = await Promise.all([
				parseConfigHosts(),
				parseKnownHosts(),
				parseHistoryHosts(),
			]);

			// Enrich known hosts with SSH config usernames by matching on hostname
			const configByHostname = new Map<
				string,
				{ username: string | null; identityFile: string | null }
			>();
			for (const ch of configResult) {
				if (ch.hostname) {
					configByHostname.set(ch.hostname, {
						username: ch.username,
						identityFile: ch.identityFile,
					});
				}
			}

			const known = knownResult.map((kh) => {
				const configMatch = configByHostname.get(kh.hostname);
				return {
					...kh,
					username: configMatch?.username ?? null,
					identityFile: configMatch?.identityFile ?? null,
				};
			});

			return { config: configResult, known, history };
		}),

		importFromSshConfig: publicProcedure
			.input(
				z.object({
					name: z.string().min(1),
					hostname: z.string().min(1),
					port: z.number().optional(),
					username: z.string().optional(),
					identityFile: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const id = uuidv4();
				const now = Date.now();

				// Determine auth method from config
				const authMethod = input.identityFile ? "key" : "agent";

				localDb
					.insert(remoteHosts)
					.values({
						id,
						name: input.name,
						type: "ssh",
						hostname: input.hostname,
						port: input.port ?? 22,
						username: input.username,
						authMethod,
						privateKeyPath: input.identityFile,
						createdAt: now,
						updatedAt: now,
					})
					.run();

				return localDb
					.select()
					.from(remoteHosts)
					.where(eq(remoteHosts.id, id))
					.get();
			}),
	});
};
