import { ScrollArea } from "@superset/ui/scroll-area";
import type { ReviewPullRequest } from "../../hooks/useReviewsData";
import {
	REVIEW_BUCKET_LABEL,
	type ReviewBucket,
} from "../../utils/reviewStatus";
import { ReviewCard } from "../ReviewCard";

interface ReviewColumnProps {
	bucket: ReviewBucket;
	prs: ReviewPullRequest[];
	onOpen: (pr: ReviewPullRequest) => void;
}

export function ReviewColumn({ bucket, prs, onOpen }: ReviewColumnProps) {
	return (
		<div className="flex w-[300px] shrink-0 flex-col rounded-lg bg-muted/30">
			<div className="flex items-center gap-2 px-3 py-2.5">
				<span className="text-sm font-medium text-foreground">
					{REVIEW_BUCKET_LABEL[bucket]}
				</span>
				<span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
					{prs.length}
				</span>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-2 px-2 pb-3">
					{prs.map((pr) => (
						<ReviewCard key={pr.id} pr={pr} onOpen={onOpen} />
					))}
					{prs.length === 0 ? (
						<p className="px-1 py-6 text-center text-xs text-muted-foreground/60">
							Nothing here
						</p>
					) : null}
				</div>
			</ScrollArea>
		</div>
	);
}
