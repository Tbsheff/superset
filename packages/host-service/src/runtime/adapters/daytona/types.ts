import type { Daytona, Sandbox } from "@daytonaio/sdk";
import type { RuntimeMetadata } from "../../../db/types/index.ts";
import type { GitFactory } from "../../git/types.ts";
import type { NormalizedRuntimeStatus } from "../../status.ts";
import type { syncAgentAuthToSandbox } from "./syncAgentAuth.ts";

/**
 * The minimal `Daytona` surface the adapter uses. Pinning to a `Pick` (rather
 * than the whole client) keeps unit tests honest: a fake only has to model the
 * verbs the adapter actually calls, and adding a new SDK call here forces the
 * fake to grow with it. `delete`'s timeout is in SECONDS (SDK convention), not
 * milliseconds.
 */
export type DaytonaSdk = Pick<Daytona, "create" | "get" | "stop" | "delete">;

/** The single-repo-scoped token the clone (in-sandbox) + host-push need. */
export interface RepoScopedToken {
	token: string;
	expiresAt: number;
}

/**
 * Mints a short-lived (<=1h) installation token scoped to ONE repository
 * (`contents:write`, `metadata:read`). The clone rides this token over a single
 * TLS call; it is never persisted, logged, or written into `metadataJson`. In
 * production this calls the apps/api `createInstallationAccessToken` route; in
 * tests it is a deterministic stub.
 */
export type TokenMinter = (args: {
	owner: string;
	repo: string;
}) => Promise<RepoScopedToken>;

/** What the adapter persists per runtime instance, decoupled from drizzle. */
export interface RuntimeInstanceRecord {
	id: string;
	workspaceId: string;
	provider: string;
	role: string;
	externalId: string | null;
	status: NormalizedRuntimeStatus;
	previewUrl: string | null;
	lastActivityAt: number | null;
	metadataJson: RuntimeMetadata;
	createdAt: number;
	destroyedAt: number | null;
	failureReason: string | null;
}

/**
 * Persistence seam for `runtime_instances`. Production backs this with the
 * drizzle `runtimeInstances` table; tests back it with an in-memory map. Keeping
 * it an interface (not the raw `HostDb`) means a unit test never has to fake the
 * drizzle query-builder chain to assert what was written.
 */
export interface DaytonaInstanceStore {
	insert(record: RuntimeInstanceRecord): void;
	setPreviewUrl(externalId: string, previewUrl: string): void;
	markDestroyed(externalId: string, destroyedAt: number): void;
	get(externalId: string): RuntimeInstanceRecord | undefined;
}

/** Dependency-injected adapter seam; production wires the real SDK + store. */
export interface DaytonaAdapterDeps {
	sdk: DaytonaSdk;
	git: GitFactory;
	mintRepoScopedToken: TokenMinter;
	store: DaytonaInstanceStore;
	/** Injectable clock so lease/timestamp tests are deterministic. */
	now?: () => number;
	/**
	 * Uploads the host user's agent credentials into the sandbox. Injectable so a
	 * unit test substitutes a no-op and never reads the host keychain / ~/.codex.
	 * Defaults to the real {@link syncAgentAuthToSandbox}.
	 */
	syncAgentAuth?: typeof syncAgentAuthToSandbox;
}

/** Parsed `owner/repo` from a clone url; the token scope depends on it. */
export interface RepoCoordinates {
	owner: string;
	repo: string;
}

export type { Sandbox };
