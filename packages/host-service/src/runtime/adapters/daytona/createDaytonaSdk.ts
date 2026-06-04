import { Daytona, type DaytonaConfig } from "@daytonaio/sdk";
import type { DaytonaSdk } from "./types.ts";

/**
 * The subset of host-service `env` this factory reads. Typed as a narrow slice
 * (not the whole `env`) so the credential logic can be unit-tested by passing a
 * plain object — no `createEnv`/`process.env` machinery in tests.
 *
 * All five vars are optional: a host with no remote-runtime config still boots,
 * and `resolveDaytonaCredentials` returns `undefined` so local-only installs are
 * unaffected.
 */
export interface DaytonaEnvSlice {
	DAYTONA_API_KEY?: string | undefined;
	DAYTONA_JWT_TOKEN?: string | undefined;
	DAYTONA_ORGANIZATION_ID?: string | undefined;
	DAYTONA_API_URL?: string | undefined;
	DAYTONA_TARGET?: string | undefined;
}

/** Optional, auth-mode-agnostic SDK settings shared by both credential modes. */
interface DaytonaCommonOptions {
	apiUrl: string | undefined;
	target: string | undefined;
}

/**
 * The two mutually exclusive auth modes the SDK accepts, as a discriminated
 * union rather than a boolean bag. `apiKey` is a single credential; `jwt` always
 * carries an `organizationId` because the SDK rejects a JWT without one (it
 * throws `DaytonaAuthenticationError`), so this resolver refuses to emit a JWT
 * mode missing the org id.
 */
export type DaytonaCredentials =
	| ({ mode: "apiKey"; apiKey: string } & DaytonaCommonOptions)
	| ({
			mode: "jwt";
			jwtToken: string;
			organizationId: string;
	  } & DaytonaCommonOptions);

/**
 * Picks Daytona credentials from env, or `undefined` when unconfigured.
 *
 * Selection order:
 *  1. `DAYTONA_API_KEY` set -> `apiKey` mode (takes precedence; simplest auth).
 *  2. else `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID` both set -> `jwt` mode.
 *  3. else `undefined` — including a JWT with no org id, which the SDK would
 *     reject anyway, so we treat it as "not configured" instead of handing the
 *     SDK a guaranteed throw.
 *
 * Pure and network-free: this is the unit-tested seam.
 */
export function resolveDaytonaCredentials(
	env: DaytonaEnvSlice,
): DaytonaCredentials | undefined {
	const common: DaytonaCommonOptions = {
		apiUrl: env.DAYTONA_API_URL,
		target: env.DAYTONA_TARGET,
	};

	if (env.DAYTONA_API_KEY) {
		return { mode: "apiKey", apiKey: env.DAYTONA_API_KEY, ...common };
	}

	if (env.DAYTONA_JWT_TOKEN && env.DAYTONA_ORGANIZATION_ID) {
		return {
			mode: "jwt",
			jwtToken: env.DAYTONA_JWT_TOKEN,
			organizationId: env.DAYTONA_ORGANIZATION_ID,
			...common,
		};
	}

	return undefined;
}

/**
 * Maps resolved credentials onto the SDK's `DaytonaConfig`. `apiUrl`/`target`
 * are omitted when unset so the SDK applies its own defaults
 * (`https://app.daytona.io/api`) rather than receiving an explicit `undefined`.
 */
export function toDaytonaConfig(creds: DaytonaCredentials): DaytonaConfig {
	const config: DaytonaConfig =
		creds.mode === "apiKey"
			? { apiKey: creds.apiKey }
			: { jwtToken: creds.jwtToken, organizationId: creds.organizationId };
	if (creds.apiUrl !== undefined) config.apiUrl = creds.apiUrl;
	if (creds.target !== undefined) config.target = creds.target;
	return config;
}

/**
 * Production Daytona SDK factory. Returns a `DaytonaSdk` (the `Pick` the adapter
 * consumes) when credentials are configured, or `undefined` so callers can leave
 * the remote runtime unregistered on a local-only host.
 *
 * The returned client carries the API key / JWT internally; those secrets never
 * leave the host (no logs, no `metadataJson`, no URLs). This factory only
 * decides config — it never logs the credentials it selects.
 */
export function createDaytonaSdk(env: DaytonaEnvSlice): DaytonaSdk | undefined {
	const creds = resolveDaytonaCredentials(env);
	if (!creds) return undefined;
	return new Daytona(toDaytonaConfig(creds));
}
