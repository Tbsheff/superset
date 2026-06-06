import type { SelectGithubRepository } from "@superset/db/schema";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { LuRefreshCw, LuSearch } from "react-icons/lu";
import {
	REVIEW_TRIAGE_LABEL,
	REVIEW_TRIAGE_TABS,
	type ReviewTriageTab,
} from "../../hooks/useReviewsData";

const ALL_REPOS = "__all__";

interface ReviewsTopBarProps {
	tab: ReviewTriageTab;
	onTabChange: (tab: ReviewTriageTab) => void;
	counts: Record<ReviewTriageTab, number>;
	search: string;
	onSearchChange: (value: string) => void;
	repoFilter: string | null;
	onRepoChange: (repoId: string | null) => void;
	repositories: SelectGithubRepository[];
	onRefresh: () => void;
	isRefreshing: boolean;
}

export function ReviewsTopBar({
	tab,
	onTabChange,
	counts,
	search,
	onSearchChange,
	repoFilter,
	onRepoChange,
	repositories,
	onRefresh,
	isRefreshing,
}: ReviewsTopBarProps) {
	return (
		<div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
			<Tabs
				value={tab}
				onValueChange={(value) => onTabChange(value as ReviewTriageTab)}
			>
				<TabsList>
					{REVIEW_TRIAGE_TABS.map((value) => (
						<TabsTrigger key={value} value={value} className="gap-1.5">
							{REVIEW_TRIAGE_LABEL[value]}
							<span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
								{counts[value]}
							</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<div className="relative ml-auto w-56">
				<LuSearch className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
				<Input
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder="Search PRs…"
					className="h-8 pl-8"
				/>
			</div>

			{repositories.length > 0 ? (
				<Select
					value={repoFilter ?? ALL_REPOS}
					onValueChange={(value) =>
						onRepoChange(value === ALL_REPOS ? null : value)
					}
				>
					<SelectTrigger className="h-8 w-48">
						<SelectValue placeholder="All repositories" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_REPOS}>All repositories</SelectItem>
						{repositories.map((repo) => (
							<SelectItem key={repo.id} value={repo.id}>
								{repo.fullName}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}

			<button
				type="button"
				onClick={onRefresh}
				disabled={isRefreshing}
				aria-label="Refresh pull requests"
				className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
			>
				<LuRefreshCw
					className={isRefreshing ? "size-4 animate-spin" : "size-4"}
				/>
			</button>
		</div>
	);
}
