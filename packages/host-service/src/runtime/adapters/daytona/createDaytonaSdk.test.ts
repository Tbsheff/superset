import { describe, expect, test } from "bun:test";
import {
	createDaytonaSdk,
	type DaytonaEnvSlice,
	resolveDaytonaCredentials,
	toDaytonaConfig,
} from "./createDaytonaSdk.ts";

describe("resolveDaytonaCredentials", () => {
	test("returns undefined when no credentials are set (local-only host)", () => {
		expect(resolveDaytonaCredentials({})).toBeUndefined();
	});

	test("returns undefined when only api url / target are set", () => {
		expect(
			resolveDaytonaCredentials({
				DAYTONA_API_URL: "https://app.daytona.io/api",
				DAYTONA_TARGET: "us",
			}),
		).toBeUndefined();
	});

	test("selects apiKey mode from DAYTONA_API_KEY", () => {
		expect(resolveDaytonaCredentials({ DAYTONA_API_KEY: "dtn_key" })).toEqual({
			mode: "apiKey",
			apiKey: "dtn_key",
			apiUrl: undefined,
			target: undefined,
		});
	});

	test("carries optional apiUrl and target into apiKey mode", () => {
		expect(
			resolveDaytonaCredentials({
				DAYTONA_API_KEY: "dtn_key",
				DAYTONA_API_URL: "https://self-hosted.example.com/api",
				DAYTONA_TARGET: "eu",
			}),
		).toEqual({
			mode: "apiKey",
			apiKey: "dtn_key",
			apiUrl: "https://self-hosted.example.com/api",
			target: "eu",
		});
	});

	test("selects jwt mode from DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID", () => {
		expect(
			resolveDaytonaCredentials({
				DAYTONA_JWT_TOKEN: "jwt.abc.def",
				DAYTONA_ORGANIZATION_ID: "org_123",
			}),
		).toEqual({
			mode: "jwt",
			jwtToken: "jwt.abc.def",
			organizationId: "org_123",
			apiUrl: undefined,
			target: undefined,
		});
	});

	test("carries optional apiUrl and target into jwt mode", () => {
		expect(
			resolveDaytonaCredentials({
				DAYTONA_JWT_TOKEN: "jwt.abc.def",
				DAYTONA_ORGANIZATION_ID: "org_123",
				DAYTONA_API_URL: "https://self-hosted.example.com/api",
				DAYTONA_TARGET: "eu",
			}),
		).toEqual({
			mode: "jwt",
			jwtToken: "jwt.abc.def",
			organizationId: "org_123",
			apiUrl: "https://self-hosted.example.com/api",
			target: "eu",
		});
	});

	test("returns undefined for a JWT without an organization id (SDK would reject it)", () => {
		expect(
			resolveDaytonaCredentials({ DAYTONA_JWT_TOKEN: "jwt.abc.def" }),
		).toBeUndefined();
	});

	test("returns undefined for an organization id without a JWT", () => {
		expect(
			resolveDaytonaCredentials({ DAYTONA_ORGANIZATION_ID: "org_123" }),
		).toBeUndefined();
	});

	test("api key takes precedence when both auth modes are present", () => {
		const creds = resolveDaytonaCredentials({
			DAYTONA_API_KEY: "dtn_key",
			DAYTONA_JWT_TOKEN: "jwt.abc.def",
			DAYTONA_ORGANIZATION_ID: "org_123",
		});
		expect(creds?.mode).toBe("apiKey");
		if (creds?.mode === "apiKey") expect(creds.apiKey).toBe("dtn_key");
	});
});

describe("toDaytonaConfig", () => {
	test("maps apiKey mode without optional keys when unset", () => {
		const config = toDaytonaConfig({
			mode: "apiKey",
			apiKey: "dtn_key",
			apiUrl: undefined,
			target: undefined,
		});
		expect(config).toEqual({ apiKey: "dtn_key" });
		expect("apiUrl" in config).toBe(false);
		expect("target" in config).toBe(false);
	});

	test("maps apiKey mode with optional keys when set", () => {
		expect(
			toDaytonaConfig({
				mode: "apiKey",
				apiKey: "dtn_key",
				apiUrl: "https://x/api",
				target: "eu",
			}),
		).toEqual({ apiKey: "dtn_key", apiUrl: "https://x/api", target: "eu" });
	});

	test("maps jwt mode with organizationId", () => {
		expect(
			toDaytonaConfig({
				mode: "jwt",
				jwtToken: "jwt.abc.def",
				organizationId: "org_123",
				apiUrl: undefined,
				target: undefined,
			}),
		).toEqual({ jwtToken: "jwt.abc.def", organizationId: "org_123" });
	});

	test("never emits an apiKey in jwt mode", () => {
		const config = toDaytonaConfig({
			mode: "jwt",
			jwtToken: "jwt.abc.def",
			organizationId: "org_123",
			apiUrl: undefined,
			target: undefined,
		});
		expect("apiKey" in config).toBe(false);
	});
});

describe("createDaytonaSdk", () => {
	test("returns undefined when unconfigured (no network, local-only host)", () => {
		const env: DaytonaEnvSlice = {};
		expect(createDaytonaSdk(env)).toBeUndefined();
	});

	test("returns a client exposing the adapter's required verbs when configured", () => {
		const sdk = createDaytonaSdk({ DAYTONA_API_KEY: "dtn_key" });
		expect(sdk).toBeDefined();
		expect(typeof sdk?.create).toBe("function");
		expect(typeof sdk?.get).toBe("function");
		expect(typeof sdk?.stop).toBe("function");
		expect(typeof sdk?.delete).toBe("function");
	});
});
