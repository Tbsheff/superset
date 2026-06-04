declare const secretBrand: unique symbol;
/** A value that must never be persisted in a *Json/preview/command column or logged. */
export type Secret = string & { readonly [secretBrand]: "Secret" };

export const asSecret = (value: string): Secret => value as Secret;

/**
 * A plain (non-secret) string. The optional `never` brand makes a branded
 * `Secret` (whose brand is the string literal `"Secret"`) structurally
 * unassignable here, so a `Secret` cannot flow into metadata even though it is
 * a `string` at runtime.
 */
export type NonSecretString = string & { readonly [secretBrand]?: never };

/** JSON-safe scalars allowed inside metadataJson. Excludes Secret structurally. */
export type JsonScalar = NonSecretString | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

/**
 * The only shape allowed in a *_json metadata column. `Secret` is a branded
 * `string`; `NonSecretString` makes a `Secret`-typed field unassignable here, so
 * illegal "secret in metadata" states fail to compile (mirrors ResolvedRef
 * discipline in runtime/git/refs.ts).
 */
export type RuntimeMetadata = Record<string, JsonValue>;
