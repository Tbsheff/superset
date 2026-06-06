import { Avatar, AvatarFallback, AvatarImage } from "@superset/ui/avatar";
import { cn } from "@superset/ui/utils";
import { memo } from "react";
import { PRIcon } from "renderer/screens/main/components/PRIcon";
import type { ReviewPullRequest } from "../../hooks/useReviewsData";
import { formatRelativeTime } from "../../utils/formatRelativeTime";
import { prIconState } from "../../utils/reviewStatus";
import { ChecksBadge, DiffStat, ReviewDecisionBadge } from "../ReviewBadges";

interface ReviewCardProps {
	pr: ReviewPullRequest;
	onOpen: (pr: ReviewPullRequest) => void;
	overlay?: boolean;
}

function ReviewCardComponent({ pr, onOpen, overlay }: ReviewCardProps) {
	return (
		<button
			type="button"
			onClick={() => onOpen(pr)}
			className={cn(
				"group flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors",
				overlay
					? "shadow-lg ring-1 ring-border"
					: "hover:border-border-strong hover:bg-accent/40",
			)}
		>
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<PRIcon state={prIconState(pr)} className="size-3.5 shrink-0" />
				<span className="truncate">{pr.repository?.fullName ?? "—"}</span>
				<span className="ml-auto shrink-0 font-mono tabular-nums">
					#{pr.prNumber}
				</span>
			</div>

			<p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
				{pr.title}
			</p>

			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Avatar className="size-4">
					{pr.authorAvatarUrl ? (
						<AvatarImage src={pr.authorAvatarUrl} alt={pr.authorLogin} />
					) : null}
					<AvatarFallback className="text-[8px]">
						{pr.authorLogin.slice(0, 2).toUpperCase()}
					</AvatarFallback>
				</Avatar>
				<span className="truncate">{pr.authorLogin}</span>
				<span className="ml-auto shrink-0">
					{formatRelativeTime(pr.updatedAt)}
				</span>
			</div>

			<div className="flex items-center gap-3">
				<ReviewDecisionBadge decision={pr.reviewDecision} />
				<ChecksBadge status={pr.checksStatus} />
				<DiffStat
					additions={pr.additions}
					deletions={pr.deletions}
					changedFiles={pr.changedFiles}
					className="ml-auto"
				/>
			</div>
		</button>
	);
}

export const ReviewCard = memo(ReviewCardComponent);
