import { EventEmitter } from "node:events";
import type { SandboxState } from "@superset/local-db";

export interface SandboxStateChange {
	projectId: string;
	state: SandboxState;
}

/**
 * Global emitter for sandbox state changes across all project state machines.
 * Subscribe to the "state" event to receive SandboxStateChange payloads.
 */
export const globalSandboxEmitter = new EventEmitter();

type ProvisioningStep = Extract<
	SandboxState,
	{ status: "provisioning" }
>["step"];

export class DevcontainerStateMachine extends EventEmitter {
	private state: SandboxState = { status: "idle" };
	private lock: Promise<void> = Promise.resolve();
	private activeSessions = 0;

	constructor(
		private readonly projectId: string,
		private persist: (state: SandboxState) => Promise<void>,
		initialState?: SandboxState,
	) {
		super();
		if (initialState) {
			this.state = this.recoverStaleState(initialState);
		}
	}

	getState(): SandboxState {
		return this.state;
	}

	/** Serialize state transitions to prevent race conditions */
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.lock.then(fn);
		this.lock = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async transition(newState: SandboxState): Promise<void> {
		this.state = newState;
		await this.persist(newState);
		const change: SandboxStateChange = {
			projectId: this.projectId,
			state: newState,
		};
		this.emit("state", change);
		globalSandboxEmitter.emit("state", change);
	}

	/** Recover from stale provisioning state (app crashed during provision) */
	private recoverStaleState(state: SandboxState): SandboxState {
		if (state.status === "provisioning") {
			const elapsed = Date.now() - state.startedAt;
			if (elapsed > 30 * 60 * 1000) {
				return {
					status: "error",
					error: "Provisioning timed out (stale lock recovered)",
					failedStep: state.step,
					retryable: true,
					occurredAt: Date.now(),
				};
			}
		}
		return state;
	}

	// --- Public transition methods ---

	startProvisioning(step: ProvisioningStep, message: string): Promise<void> {
		return this.enqueue(async () => {
			if (this.state.status !== "idle" && this.state.status !== "error") {
				throw new Error(`Cannot provision from state: ${this.state.status}`);
			}
			await this.transition({
				status: "provisioning",
				step,
				message,
				startedAt: Date.now(),
			});
		});
	}

	updateStep(step: ProvisioningStep, message: string): Promise<void> {
		return this.enqueue(async () => {
			if (this.state.status !== "provisioning") {
				throw new Error(`Cannot update step from state: ${this.state.status}`);
			}
			await this.transition({
				status: "provisioning",
				step,
				message,
				startedAt: this.state.startedAt,
			});
		});
	}

	markReady(containerId: string): Promise<void> {
		return this.enqueue(async () => {
			if (
				this.state.status !== "provisioning" &&
				this.state.status !== "stopped"
			) {
				throw new Error(`Cannot mark ready from state: ${this.state.status}`);
			}
			await this.transition({
				status: "ready",
				containerId,
				readyAt: Date.now(),
			});
		});
	}

	markStopped(reason?: string): Promise<void> {
		return this.enqueue(async () => {
			const containerId =
				this.state.status === "ready" ? this.state.containerId : undefined;
			await this.transition({
				status: "stopped",
				containerId,
				stoppedAt: Date.now(),
				reason,
			});
		});
	}

	markError(
		error: string,
		failedStep?: ProvisioningStep,
		retryable = true,
	): Promise<void> {
		return this.enqueue(async () => {
			await this.transition({
				status: "error",
				error,
				failedStep,
				retryable,
				occurredAt: Date.now(),
			});
		});
	}

	markDestroying(): Promise<void> {
		return this.enqueue(async () => {
			if (this.activeSessions > 0) {
				throw new Error(
					`Cannot destroy: ${this.activeSessions} active session(s)`,
				);
			}
			await this.transition({ status: "destroying" });
		});
	}

	// --- Session tracking ---

	registerSession(): void {
		this.activeSessions++;
	}

	unregisterSession(): void {
		this.activeSessions = Math.max(0, this.activeSessions - 1);
	}

	getActiveSessionCount(): number {
		return this.activeSessions;
	}

	updatePersist(persist: (state: SandboxState) => Promise<void>): void {
		this.persist = persist;
	}
}

/**
 * Registry of state machines — one per project.
 * Singleton pattern to ensure each project has exactly one state machine.
 */
const machines = new Map<string, DevcontainerStateMachine>();

export function getStateMachine(
	projectId: string,
	persist: (state: SandboxState) => Promise<void>,
	initialState?: SandboxState,
): DevcontainerStateMachine {
	let machine = machines.get(projectId);
	if (!machine) {
		machine = new DevcontainerStateMachine(projectId, persist, initialState);
		machines.set(projectId, machine);
	} else {
		// Update persist callback in case caller changed (e.g. retry after failed attempt)
		machine.updatePersist(persist);
	}
	return machine;
}

export function removeStateMachine(projectId: string): void {
	machines.delete(projectId);
}

export function getMachines(): Map<string, DevcontainerStateMachine> {
	return machines;
}
