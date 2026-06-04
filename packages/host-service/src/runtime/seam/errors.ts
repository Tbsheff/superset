/**
 * Thrown when a caller tries to use an execution surface a runtime does not
 * provide — e.g. writing interactive stdin to a `streaming-command` runtime
 * that only emits a log stream. Carrying the attempted operation + the surface
 * kind keeps the failure self-describing instead of a bare string throw.
 */
export class UnsupportedExecutionError extends Error {
	readonly attempted: "write" | "resize" | "startShell";
	readonly surfaceKind: import("./facets.ts").ExecutionSurface["kind"];

	constructor(
		attempted: "write" | "resize" | "startShell",
		surfaceKind: import("./facets.ts").ExecutionSurface["kind"],
	) {
		super(
			`Execution surface "${surfaceKind}" does not support "${attempted}".`,
		);
		this.name = "UnsupportedExecutionError";
		this.attempted = attempted;
		this.surfaceKind = surfaceKind;
	}
}

export function isUnsupportedExecutionError(
	value: unknown,
): value is UnsupportedExecutionError {
	return value instanceof UnsupportedExecutionError;
}

/** Stable codes a provider adapter can surface; grows additively per provider. */
export type RuntimeProviderErrorCode =
	| "EGRESS_TIER_GATED"
	| "EGRESS_INVALID_CIDR"
	| "CONFIG_MISSING"
	| "CROSS_REPO_PUSH";

/**
 * A provider-level failure with a machine-readable code, so a caller can branch
 * on the cause (e.g. tier-gated egress vs an invalid CIDR) instead of string
 * matching. The code is part of the contract; the message is for humans.
 */
export class RuntimeProviderError extends Error {
	readonly code: RuntimeProviderErrorCode;

	constructor(code: RuntimeProviderErrorCode, message: string) {
		super(message);
		this.name = "RuntimeProviderError";
		this.code = code;
	}
}

export function isRuntimeProviderError(
	value: unknown,
): value is RuntimeProviderError {
	return value instanceof RuntimeProviderError;
}
