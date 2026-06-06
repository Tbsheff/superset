import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { ScrollArea } from "@superset/ui/scroll-area";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { LuPlus } from "react-icons/lu";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { PRIcon } from "renderer/screens/main/components/PRIcon";
import { prIconState } from "../../utils/reviewStatus";

interface AddPullRequestButtonProps {
	placedPullRequestIds: Set<string>;
	onAdd: (githubPullRequestId: string) => void;
}

export function AddPullRequestButton({
	placedPullRequestIds,
	onAdd,
}: AddPullRequestButtonProps) {
	const collections = useCollections();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const { data: prRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ pr: collections.githubPullRequests })
				.select(({ pr }) => ({ ...pr })),
		[collections],
	);

	const candidates = useMemo(() => {
		const query = search.trim().toLowerCase();
		return prRows
			.filter((pr) => pr.state === "open" && !placedPullRequestIds.has(pr.id))
			.filter(
				(pr) =>
					!query ||
					`${pr.title} ${pr.authorLogin} #${pr.prNumber}`
						.toLowerCase()
						.includes(query),
			)
			.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			)
			.slice(0, 50);
	}, [prRows, placedPullRequestIds, search]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-1.5">
					<LuPlus className="size-4" />
					Add PR
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-0">
				<div className="border-b border-border p-2">
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search open PRs…"
						className="h-8"
					/>
				</div>
				<ScrollArea className="max-h-72">
					<div className="flex flex-col p-1">
						{candidates.length === 0 ? (
							<p className="px-2 py-6 text-center text-xs text-muted-foreground">
								No open PRs to add.
							</p>
						) : (
							candidates.map((pr) => (
								<button
									key={pr.id}
									type="button"
									onClick={() => {
										onAdd(pr.id);
										setOpen(false);
										setSearch("");
									}}
									className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
								>
									<PRIcon
										state={prIconState(pr)}
										className="mt-0.5 size-3.5 shrink-0"
									/>
									<div className="flex min-w-0 flex-col">
										<span className="truncate text-sm">{pr.title}</span>
										<span className="text-xs text-muted-foreground">
											#{pr.prNumber} · {pr.authorLogin}
										</span>
									</div>
								</button>
							))
						)}
					</div>
				</ScrollArea>
			</PopoverContent>
		</Popover>
	);
}
