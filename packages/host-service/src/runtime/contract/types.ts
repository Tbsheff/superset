import type { RuntimeAdapter, RuntimePlan } from "../seam/index.ts";

/**
 * A contract runs against a freshly-built adapter; the descriptor drives
 * assertions. Every sub-contract receives the same `ContractContext`, so the
 * same harness exercises every adapter — a PTY-only abstraction cannot pass
 * itself off as general because the streaming-command branch runs too.
 */
export interface ContractContext {
	/** Human label used in describe() titles. */
	readonly name: string;
	/** Build a fresh adapter instance; called once per contract test. */
	makeAdapter(): Promise<RuntimeAdapter> | RuntimeAdapter;
	/**
	 * A valid workspace-role plan the adapter accepts. Optional: contracts fall
	 * back to a minimal plan when omitted.
	 */
	workspacePlan?(): RuntimePlan<"workspace">;
	/**
	 * Advance the adapter's injectable clock by `ms`. Hard-cap activity
	 * descriptors need to cross the cap deterministically; an adapter backed by
	 * wall-clock time omits this and the hard-cap branch self-skips the
	 * time-travel assertion.
	 */
	advanceClock?(ms: number): void;
}

/**
 * The fake-only shell command grammar the contract suite uses to mutate a
 * runtime's filesystem through the seam's `startShell().write()` (the only
 * mutation surface the seam exposes). Real adapters run real shell commands;
 * the fakes interpret these tokens against their in-memory FS so the diff and
 * persistence contracts can assert real before/after state without leaking a
 * write method onto `WorkspaceRuntime`.
 *
 * Grammar (one command per write, newline-terminated):
 *   WRITE <path> <base64-contents>
 *   RM <path>
 *   STAGE <path>
 */
export const CONTRACT_SHELL_COMMANDS = {
	write: (path: string, contents: string): string =>
		`WRITE ${path} ${Buffer.from(contents, "utf8").toString("base64")}\n`,
	rm: (path: string): string => `RM ${path}\n`,
	stage: (path: string): string => `STAGE ${path}\n`,
} as const;

/** A default workspace-role plan usable by any adapter under contract. */
export const defaultWorkspacePlan = (
	workspaceId: string,
): RuntimePlan<"workspace"> => ({
	role: "workspace",
	workspaceId,
	repo: { cloneUrl: "https://example.test/contract.git", ref: "main" },
});
