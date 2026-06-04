import { describe, expect, test } from "bun:test";
import { parseListenerScan } from "./DaytonaWorkspaceRuntime.ts";

describe("parseListenerScan", () => {
	test("parses ss -ltnp rows with pid and process name", () => {
		const output = [
			"State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
			'LISTEN 0      511    0.0.0.0:3000       0.0.0.0:*         users:(("node",pid=1234,fd=20))',
			'LISTEN 0      4096   127.0.0.1:5432     0.0.0.0:*         users:(("postgres",pid=42,fd=7))',
		].join("\n");
		expect(parseListenerScan(output)).toEqual([
			{ port: 3000, address: "0.0.0.0", pid: 1234, processName: "node" },
			{ port: 5432, address: "127.0.0.1", pid: 42, processName: "postgres" },
		]);
	});

	test("dedupes a dual-stack listener to a single port", () => {
		const output = [
			'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("vite",pid=9,fd=3))',
			'LISTEN 0 511 [::]:8080 [::]:* users:(("vite",pid=9,fd=4))',
		].join("\n");
		const parsed = parseListenerScan(output);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.port).toBe(8080);
	});

	test("parses lsof rows", () => {
		const output = [
			"COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
			"node    1234 dev    20u  IPv4  98765      0t0  TCP 0.0.0.0:3000 (LISTEN)",
			"node    1234 dev    21u  IPv6  98766      0t0  TCP [::1]:9229 (LISTEN)",
		].join("\n");
		expect(parseListenerScan(output)).toEqual([
			{ port: 3000, address: "0.0.0.0", pid: 1234, processName: "node" },
			{ port: 9229, address: "::1", pid: 1234, processName: "node" },
		]);
	});

	test("ignores non-listening and malformed lines", () => {
		const output = [
			"node 1 dev 5u IPv4 1 0t0 TCP 1.2.3.4:80->5.6.7.8:443 (ESTABLISHED)",
			"garbage line with no port",
			"",
		].join("\n");
		expect(parseListenerScan(output)).toEqual([]);
	});
});
