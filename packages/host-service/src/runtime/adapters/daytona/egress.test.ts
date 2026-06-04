import { describe, expect, test } from "bun:test";
import { isRuntimeProviderError } from "../../seam/index.ts";
import {
	DEFAULT_DEV_CIDRS,
	isValidIpv4Cidr,
	MAX_EGRESS_CIDRS,
	toDaytonaNetwork,
	validateEgress,
} from "./egress.ts";

describe("isValidIpv4Cidr", () => {
	test("accepts well-formed IPv4 CIDRs", () => {
		expect(isValidIpv4Cidr("10.0.0.0/8")).toBe(true);
		expect(isValidIpv4Cidr("192.168.1.1/32")).toBe(true);
		expect(isValidIpv4Cidr("0.0.0.0/0")).toBe(true);
	});

	test("rejects hostnames, IPv6, and missing/oversized prefixes", () => {
		expect(isValidIpv4Cidr("example.com")).toBe(false);
		expect(isValidIpv4Cidr("::1/128")).toBe(false);
		expect(isValidIpv4Cidr("10.0.0.0")).toBe(false);
		expect(isValidIpv4Cidr("10.0.0.0/33")).toBe(false);
		expect(isValidIpv4Cidr("999.0.0.0/8")).toBe(false);
	});
});

describe("validateEgress", () => {
	test("allow-all / deny-all need no validation", () => {
		expect(() => validateEgress({ kind: "allow-all" })).not.toThrow();
		expect(() => validateEgress({ kind: "deny-all" })).not.toThrow();
	});

	test("throws EGRESS_INVALID_CIDR over the cap", () => {
		const cidrs = Array.from(
			{ length: MAX_EGRESS_CIDRS + 1 },
			(_, i) => `10.0.0.${i}/32`,
		);
		let thrown: unknown;
		try {
			validateEgress({ kind: "allow-cidrs", cidrs });
		} catch (error) {
			thrown = error;
		}
		expect(isRuntimeProviderError(thrown)).toBe(true);
		if (isRuntimeProviderError(thrown)) {
			expect(thrown.code).toBe("EGRESS_INVALID_CIDR");
		}
	});

	test("throws on an invalid entry", () => {
		expect(() =>
			validateEgress({ kind: "allow-cidrs", cidrs: ["not-a-cidr"] }),
		).toThrow();
	});

	test("the default dev CIDRs are valid and within the cap", () => {
		expect(DEFAULT_DEV_CIDRS.length).toBeLessThanOrEqual(MAX_EGRESS_CIDRS);
		for (const cidr of DEFAULT_DEV_CIDRS) {
			expect(isValidIpv4Cidr(cidr)).toBe(true);
		}
		expect(() =>
			validateEgress({ kind: "allow-cidrs", cidrs: [...DEFAULT_DEV_CIDRS] }),
		).not.toThrow();
	});
});

describe("toDaytonaNetwork", () => {
	test("maps the discriminated policy to Daytona network settings", () => {
		expect(toDaytonaNetwork({ kind: "allow-all" })).toEqual({
			networkBlockAll: false,
		});
		expect(toDaytonaNetwork({ kind: "deny-all" })).toEqual({
			networkBlockAll: true,
		});
		expect(
			toDaytonaNetwork({
				kind: "allow-cidrs",
				cidrs: ["10.0.0.0/8", "1.1.1.1/32"],
			}),
		).toEqual({
			networkBlockAll: true,
			networkAllowList: "10.0.0.0/8,1.1.1.1/32",
		});
	});
});
