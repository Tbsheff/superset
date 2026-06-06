import { useMemo } from "react";
import type { ReviewPullRequest } from "../../hooks/useReviewsData";
import {
	REVIEW_BUCKET_ORDER,
	type ReviewBucket,
} from "../../utils/reviewStatus";
import { ReviewColumn } from "../ReviewColumn";

interface ReviewsBoardProps {
	prs: ReviewPullRequest[];
	onOpen: (pr: ReviewPullRequest) => void;
}

export function ReviewsBoard({ prs, onOpen }: ReviewsBoardProps) {
	const byBucket = useMemo(() => {
		const map = new Map<ReviewBucket, ReviewPullRequest[]>();
		for (const bucket of REVIEW_BUCKET_ORDER) {
			map.set(bucket, []);
		}
		for (const pr of prs) {
			map.get(pr.bucket)?.push(pr);
		}
		return map;
	}, [prs]);

	return (
		<div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3">
			{REVIEW_BUCKET_ORDER.map((bucket) => (
				<ReviewColumn
					key={bucket}
					bucket={bucket}
					prs={byBucket.get(bucket) ?? []}
					onOpen={onOpen}
				/>
			))}
		</div>
	);
}
