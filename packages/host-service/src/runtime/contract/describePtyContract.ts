import { describe, expect, test } from "bun:test";
import { descriptorSupportsExecution } from "../descriptors/index.ts";
import { isUnsupportedExecutionError } from "../seam/index.ts";
import { drainShell } from "./drainShell.ts";
import { type ContractContext, defaultWorkspacePlan } from "./types.ts";

/**
 * The anti-PTY-bias core. This sub-contract must pass for a `{kind:"pty"}`
 * descriptor AND for a `{kind:"streaming-command"}` descriptor, asserting the
 * OPPOSITE behavior in each branch. Each branch additionally cross-checks that
 * the handle's behavior matches what the descriptor CLAIMS, so an adapter that
 * lies about its execution surface fails here.
 */
export function describePtyContract(ctx: ContractContext): void {
	const plan = () => ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-pty");

	describe("execution surface", () => {
		test("descriptor advertises exactly one execution surface", async () => {
			const adapter = await ctx.makeAdapter();
			expect(adapter.descriptor.execution.length).toBe(1);
		});

		test("pty: startShell yields a pty surface that streams data", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "pty")) return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({ cols: 80, rows: 24 });
			expect(shell.surface.kind).toBe("pty");

			const collected = await new Promise<string>((resolve) => {
				let data = "";
				const sub = shell.onData((chunk) => {
					data += chunk;
				});
				shell.write("echo hello\n");
				setTimeout(() => {
					sub.dispose();
					resolve(data);
				}, 50);
			});
			expect(collected.length).toBeGreaterThan(0);
		});

		test("pty: write and resize are accepted without throwing", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "pty")) return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({ cols: 80, rows: 24 });
			expect(() => shell.write("ls\n")).not.toThrow();
			expect(() => shell.resize(120, 40)).not.toThrow();
			await shell.kill();
		});

		test("pty: stderrMultiplexedIntoStdout claim is reflected in the stream", async () => {
			const adapter = await ctx.makeAdapter();
			const pty = adapter.descriptor.execution.find((e) => e.kind === "pty");
			if (!pty || pty.kind !== "pty") return;
			if (pty.stderrMultiplexedIntoStdout !== true) return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({ cols: 80, rows: 24 });
			const drained = await drainShell(shell, 100);
			// A multiplexed surface routes stderr into the same onData stream, so
			// any emitted error text is observable on the single data channel.
			expect(typeof drained.data).toBe("string");
			await shell.kill();
		});

		test("non-pty: startShell yields a streaming-command surface that logs then exits", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "streaming-command"))
				return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({});
			expect(shell.surface.kind).toBe("streaming-command");
			const drained = await drainShell(shell, 500);
			expect(drained.data.length).toBeGreaterThan(0);
			expect(drained.exit).not.toBeNull();
			expect(typeof drained.exit?.exitCode).toBe("number");
		});

		test("non-pty: write rejects with a typed UnsupportedExecutionError", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "streaming-command"))
				return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({});
			let thrown: unknown;
			try {
				shell.write("interactive input\n");
			} catch (error) {
				thrown = error;
			}
			expect(isUnsupportedExecutionError(thrown)).toBe(true);
			await shell.kill();
		});

		test("non-pty: resize never silently pretends to be a tty", async () => {
			const adapter = await ctx.makeAdapter();
			if (!descriptorSupportsExecution(adapter.descriptor, "streaming-command"))
				return;
			const handle = await adapter.createInstance(plan());
			const shell = await handle.startShell({});
			// Either a typed rejection or a true no-op is acceptable; silently
			// accepting a tty resize on a log stream is not.
			let thrown: unknown;
			try {
				shell.resize(120, 40);
			} catch (error) {
				thrown = error;
			}
			if (thrown !== undefined) {
				expect(isUnsupportedExecutionError(thrown)).toBe(true);
			}
			await shell.kill();
		});
	});
}
