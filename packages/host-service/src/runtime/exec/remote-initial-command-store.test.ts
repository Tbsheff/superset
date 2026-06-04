import { describe, expect, test } from "bun:test";
import {
	setRemoteInitialCommand,
	takeRemoteInitialCommand,
} from "./remote-initial-command-store.ts";

describe("remote-initial-command-store", () => {
	test("take returns the stored command exactly once (consume on read)", () => {
		setRemoteInitialCommand("term-1", "bun run dev");

		expect(takeRemoteInitialCommand("term-1")).toBe("bun run dev");
		// A reconnect's fresh attach must not re-run it.
		expect(takeRemoteInitialCommand("term-1")).toBeUndefined();
	});

	test("take for an unknown terminal is undefined", () => {
		expect(takeRemoteInitialCommand("never-set")).toBeUndefined();
	});

	test("commands are isolated per terminalId", () => {
		setRemoteInitialCommand("term-a", "echo a");
		setRemoteInitialCommand("term-b", "echo b");

		expect(takeRemoteInitialCommand("term-b")).toBe("echo b");
		expect(takeRemoteInitialCommand("term-a")).toBe("echo a");
	});
});
