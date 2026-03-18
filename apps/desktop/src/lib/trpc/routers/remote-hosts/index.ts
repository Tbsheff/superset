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

/** Strip trailing backslashes (zsh line-continuation) and carriage returns from parsed values */
function sanitize(value: string): string;
function sanitize(value: string | null): string | null;
function sanitize(value: string | null): string | null {
	if (value == null) return null;
	return value.replace(/[\r\\]+$/, "").trim();
}

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

			hosts.push({
				name: sanitize(hostPattern.trim()),
				hostname: sanitize(hostname?.trim() ?? null),
				port,
				username: sanitize(username?.trim() ?? null),
				identityFile: sanitize(identityFile?.trim() ?? null),
			});
		}

		return hosts;
	} catch {
		return [];
	}
}

/** Parse an SSH command string into connection parameters */
function parseSshCommand(command: string): {
	hostname: string;
	username: string | null;
	port: number;
	identityFile: string | null;
} {
	let rest = command.trim();
	// Strip leading "ssh " if present
	if (rest.toLowerCase().startsWith("ssh ")) {
		rest = rest.slice(4).trim();
	}

	// Extract -p port
	let port = 22;
	const portMatch = rest.match(/(?:^|\s)-p\s+(\d+)/);
	if (portMatch) {
		port = Number.parseInt(portMatch[1], 10);
		rest = rest.replace(portMatch[0], " ").trim();
	}

	// Extract -i identity_file
	let identityFile: string | null = null;
	const identityMatch = rest.match(/(?:^|\s)-i\s+(\S+)/);
	if (identityMatch) {
		identityFile = identityMatch[1];
		rest = rest.replace(identityMatch[0], " ").trim();
	}

	// Strip remaining flags
	rest = rest.replace(/-[a-zA-Z](?:\s+\S+)?/g, "").trim();

	// Last non-option token is [user@]host or [user@]host:port
	const tokens = rest.split(/\s+/).filter((t) => t && !t.startsWith("-"));
	const target = tokens[tokens.length - 1] ?? "";

	let username: string | null = null;
	let hostname = target;

	if (hostname.includes("@")) {
		const atIdx = hostname.indexOf("@");
		username = hostname.slice(0, atIdx);
		hostname = hostname.slice(atIdx + 1);
	}

	// Handle host:port format (but not IPv6)
	const colonMatch = hostname.match(/^([^:]+):(\d+)$/);
	if (colonMatch && !hostname.includes("::")) {
		hostname = colonMatch[1];
		port = Number.parseInt(colonMatch[2], 10);
	}

	return {
		hostname: sanitize(hostname),
		username: username ? sanitize(username) : null,
		port,
		identityFile: identityFile ? sanitize(identityFile) : null,
	};
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
						name: input.name.trim(),
						type: input.type,
						hostname: input.hostname?.trim(),
						port: input.port ?? 22,
						username: input.username?.trim(),
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath?.trim(),
						defaultCwd: input.defaultCwd?.trim(),
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
				const trimmed = {
					...updates,
					...(updates.name && { name: updates.name.trim() }),
					...(updates.hostname && { hostname: updates.hostname.trim() }),
					...(updates.username && { username: updates.username.trim() }),
					...(updates.privateKeyPath && {
						privateKeyPath: updates.privateKeyPath.trim(),
					}),
					...(updates.defaultCwd && { defaultCwd: updates.defaultCwd.trim() }),
					updatedAt: Date.now(),
				};
				localDb
					.update(remoteHosts)
					.set(trimmed)
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
						hostname: input.hostname.trim(),
						port: input.port ?? 22,
						username: input.username.trim(),
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath,
						password: input.password,
					});

					// Successful — clean up test connection
					manager.disconnect(testId);
					return { success: true, error: null };
				} catch (err) {
					manager.disconnect(testId);
					let message =
						err instanceof Error ? err.message : "Connection failed";

					// Provide actionable hint for the most common agent-auth failure
					if (
						input.authMethod === "agent" &&
						message.includes("All configured authentication methods failed")
					) {
						message +=
							". Ensure your SSH key is loaded in the agent (run: ssh-add) or switch auth method to Key and provide the key path.";
					}

					return {
						success: false,
						error: message,
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
			const config = await parseConfigHosts();
			return { config };
		}),

		createFromCommand: publicProcedure
			.input(z.object({ command: z.string().min(1) }))
			.mutation(({ input }) => {
				const parsed = parseSshCommand(input.command);
				if (!parsed.hostname) {
					throw new Error("Could not parse hostname from SSH command");
				}

				const id = uuidv4();
				const now = Date.now();
				const authMethod = parsed.identityFile ? "key" : "agent";

				localDb
					.insert(remoteHosts)
					.values({
						id,
						name: parsed.hostname,
						type: "ssh",
						hostname: parsed.hostname,
						port: parsed.port,
						username: parsed.username ?? undefined,
						authMethod,
						privateKeyPath: parsed.identityFile ?? undefined,
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
						name: input.name.trim(),
						type: "ssh",
						hostname: input.hostname.trim(),
						port: input.port ?? 22,
						username: input.username?.trim(),
						authMethod,
						privateKeyPath: input.identityFile?.trim(),
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
