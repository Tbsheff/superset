import { PatchDiff } from "@pierre/diffs/react";
import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Spinner } from "@superset/ui/spinner";
import { useNavigate } from "@tanstack/react-router";
import { HiArrowLeft } from "react-icons/hi2";
import { LuChevronDown, LuExternalLink, LuGitMerge } from "react-icons/lu";
import { PRIcon } from "renderer/screens/main/components/PRIcon";
import {
	type MergeMethod,
	useMergePullRequest,
} from "../../hooks/useMergePullRequest";
import { usePullRequestDiff } from "../../hooks/usePullRequestDiff";
import { useReviewDiffOptions } from "../../hooks/useReviewDiffOptions";
import { useReviewPullRequest } from "../../hooks/useReviewPullRequest";
import { prIconState } from "../../utils/reviewStatus";
import { ChecksBadge, DiffStat, ReviewDecisionBadge } from "../ReviewBadges";

const MERGE_METHODS: { method: MergeMethod; label: string }[] = [
	{ method: "squash", label: "Squash and merge" },
	{ method: "merge", label: "Create a merge commit" },
	{ method: "rebase", label: "Rebase and merge" },
];

interface PullRequestDetailProps {
	prId: string;
}

export function PullRequestDetail({ prId }: PullRequestDetailProps) {
	const navigate = useNavigate();
	const { data, isReady } = useReviewPullRequest(prId);

	const owner = data?.repository?.owner ?? null;
	const repo = data?.repository?.name ?? null;
	const pullNumber = data?.pr.prNumber ?? null;

	const {
		data: diff,
		isLoading: diffLoading,
		error: diffError,
	} = usePullRequestDiff({ owner, repo, pullNumber });
	const { options, style } = useReviewDiffOptions();
	const merge = useMergePullRequest(() => navigate({ to: "/reviews" }));

	const handleBack = () => navigate({ to: "/reviews" });

	if (!data) {
		return (
			<div className="flex flex-1 items-center justify-center">
				{isReady ? (
					<span className="cursor-text select-text text-sm text-muted-foreground">
						Pull request not found.
					</span>
				) : (
					<Spinner className="size-5 text-muted-foreground" />
				)}
			</div>
		);
	}

	const { pr, repository } = data;
	const canMerge = pr.state === "open" && !pr.isDraft;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					onClick={handleBack}
					aria-label="Back to reviews"
				>
					<HiArrowLeft className="size-4" />
				</Button>
				<PRIcon state={prIconState(pr)} className="size-4 shrink-0" />
				<div className="flex min-w-0 flex-col">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-medium">{pr.title}</span>
						<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
							#{pr.prNumber}
						</span>
					</div>
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span className="truncate">{repository?.fullName ?? "—"}</span>
						<span>·</span>
						<span className="truncate font-mono">
							{pr.headBranch} → {pr.baseBranch}
						</span>
						<span>·</span>
						<span>by {pr.authorLogin}</span>
					</div>
				</div>

				<div className="ml-auto flex items-center gap-3">
					<ReviewDecisionBadge decision={pr.reviewDecision} />
					<ChecksBadge status={pr.checksStatus} />
					<DiffStat
						additions={pr.additions}
						deletions={pr.deletions}
						changedFiles={pr.changedFiles}
					/>
					<a
						href={pr.url}
						target="_blank"
						rel="noopener noreferrer"
						className="p-1.5 text-muted-foreground transition-colors hover:text-foreground"
						title="Open in GitHub"
					>
						<LuExternalLink className="size-4" />
					</a>
					{canMerge && owner && repo && pullNumber != null ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									size="sm"
									className="h-8 gap-1.5"
									disabled={merge.isPending}
								>
									<LuGitMerge className="size-4" />
									Merge
									<LuChevronDown className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{MERGE_METHODS.map(({ method, label }) => (
									<DropdownMenuItem
										key={method}
										onSelect={() =>
											merge.mutate({
												owner,
												repo,
												pullNumber,
												mergeMethod: method,
											})
										}
									>
										{label}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</div>

			<DiffBody
				diff={diff}
				isLoading={diffLoading}
				error={diffError}
				options={options}
				style={style}
			/>
		</div>
	);
}

function DiffBody({
	diff,
	isLoading,
	error,
	options,
	style,
}: {
	diff: string | null | undefined;
	isLoading: boolean;
	error: unknown;
	options: ReturnType<typeof useReviewDiffOptions>["options"];
	style: ReturnType<typeof useReviewDiffOptions>["style"];
}) {
	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-1 items-center justify-center px-6">
				<span className="cursor-text select-text text-sm text-destructive">
					{error instanceof Error ? error.message : "Unable to load diff."}
				</span>
			</div>
		);
	}

	if (!diff || diff.trim() === "") {
		return (
			<div className="flex flex-1 items-center justify-center">
				<span className="text-sm text-muted-foreground">
					No changes in this pull request.
				</span>
			</div>
		);
	}

	return (
		<PatchDiff
			patch={diff}
			options={options}
			style={style}
			className="min-h-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain [overflow-anchor:none]"
		/>
	);
}
