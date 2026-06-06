import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { LuCheck, LuCircleDashed, LuMessageSquare, LuX } from "react-icons/lu";
import {
	type ChecksStatus,
	coerceChecksStatus,
} from "../../utils/reviewStatus";

const CHECKS_META: Record<
	ChecksStatus,
	{ label: string; dot: string; icon: typeof LuCheck | null }
> = {
	none: { label: "No checks", dot: "bg-muted-foreground/40", icon: null },
	pending: { label: "Checks running", dot: "bg-amber-500", icon: null },
	success: { label: "Checks passing", dot: "bg-emerald-500", icon: LuCheck },
	failure: { label: "Checks failing", dot: "bg-red-500", icon: LuX },
};

export function ChecksBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const value = coerceChecksStatus(status);
	if (value === "none") return null;
	const meta = CHECKS_META[value];
	const Icon = meta.icon;

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"flex items-center gap-1 text-xs text-muted-foreground",
						className,
					)}
				>
					{Icon ? (
						<Icon
							className={cn(
								"size-3",
								value === "success" && "text-emerald-500",
								value === "failure" && "text-red-500",
							)}
						/>
					) : (
						<span className={cn("size-2 rounded-full", meta.dot)} />
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent>{meta.label}</TooltipContent>
		</Tooltip>
	);
}

const DECISION_META: Record<
	string,
	{ label: string; className: string; icon: typeof LuCheck }
> = {
	APPROVED: {
		label: "Approved",
		className: "text-emerald-600 dark:text-emerald-400",
		icon: LuCheck,
	},
	CHANGES_REQUESTED: {
		label: "Changes requested",
		className: "text-red-600 dark:text-red-400",
		icon: LuX,
	},
	REVIEW_REQUIRED: {
		label: "Review required",
		className: "text-amber-600 dark:text-amber-400",
		icon: LuCircleDashed,
	},
};

export function ReviewDecisionBadge({
	decision,
	className,
}: {
	decision: string | null;
	className?: string;
}) {
	const meta = decision ? DECISION_META[decision] : undefined;
	if (!meta) {
		return (
			<span
				className={cn(
					"flex items-center gap-1 text-xs text-muted-foreground",
					className,
				)}
			>
				<LuMessageSquare className="size-3" />
				No review
			</span>
		);
	}
	const Icon = meta.icon;
	return (
		<span
			className={cn(
				"flex items-center gap-1 text-xs font-medium",
				meta.className,
				className,
			)}
		>
			<Icon className="size-3" />
			{meta.label}
		</span>
	);
}

export function DiffStat({
	additions,
	deletions,
	changedFiles,
	className,
}: {
	additions: number;
	deletions: number;
	changedFiles: number;
	className?: string;
}) {
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"flex items-center gap-1.5 font-mono text-xs tabular-nums",
						className,
					)}
				>
					<span className="text-emerald-600 dark:text-emerald-400">
						+{additions}
					</span>
					<span className="text-red-600 dark:text-red-400">−{deletions}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{changedFiles} {changedFiles === 1 ? "file" : "files"} changed
			</TooltipContent>
		</Tooltip>
	);
}
