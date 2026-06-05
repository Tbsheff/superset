import { Button } from "@superset/ui/button";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowRight,
	Loader2,
	PowerOff,
	RotateCw,
	Snowflake,
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Full-pane state for a remote workspace whose Daytona sandbox is not running.
 * Remote sandboxes auto-stop after an idle interval (disk retained) and archive
 * after a longer stopped period (disk evicted to cold storage). Opening such a
 * workspace resumes it; this surface gives that the same first-class feedback a
 * fresh create gets, instead of a silently hung terminal.
 *
 *   - `restarting`: the sandbox is being resumed (auto on open). `archived`
 *     swaps the copy to set the right expectation — a cold-storage restore is
 *     slow, a plain stop is fast.
 *   - `failed`: the resume errored (e.g. a restore exceeded its timeout). Offers
 *     a manual retry, since auto-resume can't recover a hard failure.
 *   - `destroyed`: the sandbox no longer exists provider-side; there is nothing
 *     to resume, so we point the user back to their workspaces.
 */
type WorkspaceWakingStatus = "restarting" | "failed" | "destroyed";

interface WorkspaceWakingStateProps {
	status: WorkspaceWakingStatus;
	/** True when resuming from cold storage (archived); slower, different copy. */
	archived?: boolean;
	name?: string;
	/** Provider/host error text shown in the failed state (selectable). */
	reason?: string;
	/** Re-fires the resume; shown as "Restart sandbox" in the failed state. */
	onRetry?: () => void;
	/** When the resume began, for the elapsed counter. */
	startedAt?: number;
}

export function WorkspaceWakingState({
	status,
	archived = false,
	name,
	reason,
	onRetry,
	startedAt,
}: WorkspaceWakingStateProps) {
	if (status === "failed") {
		return <WakingFailed name={name} reason={reason} onRetry={onRetry} />;
	}
	if (status === "destroyed") {
		return <WakingDestroyed name={name} />;
	}
	return (
		<WakingRestarting name={name} archived={archived} startedAt={startedAt} />
	);
}

function WakingRestarting({
	name,
	archived,
	startedAt,
}: {
	name?: string;
	archived: boolean;
	startedAt?: number;
}) {
	const elapsed = useElapsedSeconds(startedAt);

	return (
		<div className="flex h-full w-full items-center justify-center p-6">
			<div className="flex w-full max-w-sm flex-col items-start gap-5">
				<div className="relative">
					<Loader2
						className="size-5 animate-spin text-muted-foreground"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
					{archived && (
						<Snowflake
							className="absolute -bottom-1 -right-1 size-3 text-sky-400"
							strokeWidth={2.5}
							aria-hidden="true"
						/>
					)}
				</div>

				<div className="flex flex-col gap-1.5">
					<h1 className="text-[15px] font-medium tracking-tight text-foreground">
						{archived ? "Restoring workspace" : "Waking workspace"}
					</h1>
					<p className="truncate text-[13px] leading-relaxed text-muted-foreground">
						{name || "Untitled workspace"}
					</p>
				</div>

				<p className="text-[12px] leading-relaxed text-muted-foreground/90">
					{archived
						? "This sandbox was archived to cold storage to save space. Restoring it can take a minute or two."
						: "This sandbox was paused after sitting idle. Resuming it usually takes a few seconds."}
				</p>

				<div className="text-[11px] text-muted-foreground/70">
					<span className="font-mono tabular-nums">
						{formatElapsed(elapsed)}
					</span>
					<span> elapsed</span>
				</div>
			</div>
		</div>
	);
}

function WakingFailed({
	name,
	reason,
	onRetry,
}: {
	name?: string;
	reason?: string;
	onRetry?: () => void;
}) {
	return (
		<div className="flex h-full w-full items-center justify-center p-6">
			<div
				role="alert"
				aria-live="assertive"
				className="flex w-full max-w-sm flex-col items-start gap-5"
			>
				<AlertCircle
					className="size-5 text-destructive"
					strokeWidth={1.5}
					aria-hidden="true"
				/>

				<div className="flex flex-col gap-1.5">
					<h1 className="text-[15px] font-medium tracking-tight text-foreground">
						Couldn't wake workspace
					</h1>
					<p className="truncate text-[13px] leading-relaxed text-muted-foreground">
						{name || "Untitled workspace"}
					</p>
				</div>

				{reason && (
					<div className="w-full rounded-md border border-destructive/20 bg-destructive/[0.04] px-3 py-2.5">
						<p className="select-text cursor-text font-mono text-[11px] leading-relaxed text-destructive/90 break-words whitespace-pre-wrap">
							{reason}
						</p>
					</div>
				)}

				<div className="flex items-center gap-2">
					{onRetry && (
						<Button size="sm" onClick={onRetry} className="gap-1.5">
							<RotateCw
								className="size-3.5"
								strokeWidth={2}
								aria-hidden="true"
							/>
							Restart sandbox
						</Button>
					)}
					<Button asChild size="sm" variant="ghost">
						<Link to="/v2-workspaces">Browse workspaces</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}

function WakingDestroyed({ name }: { name?: string }) {
	return (
		<div className="flex h-full w-full items-center justify-center p-6">
			<div className="flex w-full max-w-sm flex-col items-start gap-5">
				<div className="grid size-10 place-items-center rounded-lg border border-border/60 bg-muted/30">
					<PowerOff
						className="size-[18px] text-muted-foreground"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<h1 className="text-[15px] font-medium tracking-tight text-foreground">
						Sandbox no longer exists
					</h1>
					<p className="select-text cursor-text text-[13px] leading-relaxed text-muted-foreground">
						The remote sandbox for {name || "this workspace"} has been removed
						and can't be resumed. Create a new workspace to continue.
					</p>
				</div>

				<Button asChild size="sm" variant="ghost" className="-ml-2 gap-1.5">
					<Link to="/v2-workspaces">
						Browse workspaces
						<ArrowRight
							className="size-3.5"
							strokeWidth={2}
							aria-hidden="true"
						/>
					</Link>
				</Button>
			</div>
		</div>
	);
}

function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function useElapsedSeconds(startedAt: number | undefined): number {
	const [mountedAt] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(id);
	}, []);
	return Math.max(0, (now - (startedAt ?? mountedAt)) / 1000);
}
