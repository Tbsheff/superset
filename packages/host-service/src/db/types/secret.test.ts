import { describe, expect, test } from "bun:test";
import { asSecret, type RuntimeMetadata } from "./secret.ts";

describe("Secret brand", () => {
	test("asSecret round-trips as a string at runtime", () => {
		expect(String(asSecret("x"))).toBe("x");
	});

	test("RuntimeMetadata accepts plain JSON scalars", () => {
		const m: RuntimeMetadata = {
			provider: "daytona",
			retries: 3,
			persistent: true,
			note: null,
		};
		expect(m.provider).toBe("daytona");
	});

	test("RuntimeMetadata forbids a Secret-typed value at compile time", () => {
		// @ts-expect-error a branded Secret must be unassignable into metadata
		const m: RuntimeMetadata = { token: asSecret("t") };
		// Runtime is unaffected (the brand is erased); the guarantee is the
		// compile-time @ts-expect-error above, verified by `tsc`.
		expect(typeof m.token).toBe("string");
	});
});
