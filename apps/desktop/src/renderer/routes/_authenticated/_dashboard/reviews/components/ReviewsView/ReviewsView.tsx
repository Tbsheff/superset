import { Spinner } from "@superset/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { LuGitPullRequestArrow } from "react-icons/lu";
import { useGithubSync } from "../../hooks/useGithubSync";
import {
	type ReviewPullRequest,
	type ReviewTriageTab,
	useReviewsData,
} from "../../hooks/useReviewsData";
import { useViewerLogin } from "../../hooks/useViewerLogin";
import { KanbanBoardView } from "../KanbanBoardView";
import { ReviewsBoard } from "../ReviewsBoard";
import { ReviewsTopBar } from "../ReviewsTopBar";

type ReviewMode = "triage" | "board";

export function ReviewsView() {
	const navigate = useNavigate();
	const [mode, setMode] = useState<ReviewMode>("triage");
	const [tab, setTab] = useState<ReviewTriageTab>("needs-review");
	const [search, setSearch] = useState("");
	const [repoFilter, setRepoFilter] = useState<string | null>(null);

	const viewerLogin = useViewerLogin();
	const sync = useGithubSync();

	const { data, repositories, isReady, counts } = useReviewsData({
		tab,
		viewerLogin,
		repoFilter,
		searchQuery: search,
	});

	const handleOpen = (pr: ReviewPullRequest) => {
		navigate({ to: "/reviews/$prId", params: { prId: pr.id } });
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-3 border-b border-border px-4 py-2">
				<Tabs
					value={mode}
					onValueChange={(value) => setMode(value as ReviewMode)}
				>
					<TabsList>
						<TabsTrigger value="triage">Triage</TabsTrigger>
						<TabsTrigger value="board">Team Board</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>

			{mode === "triage" ? (
				<>
					<ReviewsTopBar
						tab={tab}
						onTabChange={setTab}
						counts={counts}
						search={search}
						onSearchChange={setSearch}
						repoFilter={repoFilter}
						onRepoChange={setRepoFilter}
						repositories={repositories}
						onRefresh={() => sync.mutate()}
						isRefreshing={sync.isPending}
					/>
					{data.length === 0 ? (
						<EmptyState isReady={isReady} tab={tab} />
					) : (
						<ReviewsBoard prs={data} onOpen={handleOpen} />
					)}
				</>
			) : (
				<KanbanBoardView />
			)}
		</div>
	);
}

function EmptyState({
	isReady,
	tab,
}: {
	isReady: boolean;
	tab: ReviewTriageTab;
}) {
	// Cache-first: only the no-data branch reaches here. If the collection
	// hasn't hydrated yet, show a spinner; once ready, it's a genuine empty.
	if (!isReady) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</div>
		);
	}

	const message =
		tab === "needs-review"
			? "No pull requests are waiting on your review."
			: tab === "mine"
				? "You have no open pull requests."
				: "No open pull requests yet.";

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
			<LuGitPullRequestArrow className="size-8 text-muted-foreground/40" />
			<p className="max-w-xs text-sm text-muted-foreground">{message}</p>
			<p className="max-w-sm text-xs text-muted-foreground/60">
				Pull requests appear here once the GitHub App is installed for your
				repositories.
			</p>
		</div>
	);
}
