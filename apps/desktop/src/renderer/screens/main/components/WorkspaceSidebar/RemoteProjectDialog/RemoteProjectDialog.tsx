import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Separator } from "@superset/ui/separator";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface RemoteProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function deriveProjectName(repoUrl: string, remoteRepoPath: string): string {
	const source = repoUrl.trim() || remoteRepoPath.trim();
	if (!source) return "";
	const last = source.split(/[/\\]/).pop() ?? "";
	return last.replace(/\.git$/, "");
}

export function RemoteProjectDialog({
	open,
	onOpenChange,
}: RemoteProjectDialogProps) {
	const navigate = useNavigate();
	const { data: remoteHosts, isLoading: isHostsLoading } =
		electronTrpc.remoteHosts.list.useQuery();

	const [remoteHostId, setRemoteHostId] = useState<string>("");
	const [repoUrl, setRepoUrl] = useState("");
	const [remoteRepoPath, setRemoteRepoPath] = useState("");
	// nameOverride is non-empty only when the user has explicitly typed a name
	const [nameOverride, setNameOverride] = useState("");

	const derivedName =
		nameOverride || deriveProjectName(repoUrl, remoteRepoPath);

	const utils = electronTrpc.useUtils();
	const createRemote = electronTrpc.projects.createRemote.useMutation({
		onSuccess: async () => {
			await utils.projects.getRecents.invalidate();
			await utils.workspaces.getAllGrouped.invalidate();
			toast.success("Remote project added");
			handleClose();
		},
		onError: (err) => {
			toast.error("Failed to add remote project", {
				description: err.message,
			});
		},
	});

	const handleClose = () => {
		onOpenChange(false);
		setRemoteHostId("");
		setRepoUrl("");
		setRemoteRepoPath("");
		setNameOverride("");
	};

	const hasHosts = remoteHosts && remoteHosts.length > 0;
	const canSubmit =
		!!remoteHostId &&
		(!!repoUrl.trim() || !!remoteRepoPath.trim()) &&
		!createRemote.isPending;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;
		createRemote.mutate({
			remoteHostId,
			repoUrl: repoUrl.trim() || undefined,
			remoteRepoPath: remoteRepoPath.trim() || undefined,
			name: nameOverride.trim() || undefined,
		});
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
			<DialogContent className="max-w-[400px] gap-0 p-0">
				<DialogHeader className="px-4 pt-4 pb-3">
					<DialogTitle className="font-medium text-sm">
						Add remote project
					</DialogTitle>
				</DialogHeader>

				{isHostsLoading ? (
					<div className="px-4 pb-4 text-sm text-muted-foreground">
						Loading hosts...
					</div>
				) : !hasHosts ? (
					<div className="px-4 pb-4 space-y-3">
						<p className="text-sm text-muted-foreground">
							No remote hosts configured.{" "}
							<button
								type="button"
								className="text-foreground underline underline-offset-2 hover:no-underline"
								onClick={() => {
									handleClose();
									navigate({ to: "/settings/remote-hosts" });
								}}
							>
								Configure a host
							</button>{" "}
							to add remote projects.
						</p>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="px-4 pb-4 space-y-3">
						<div className="space-y-1.5">
							<Label className="text-xs text-muted-foreground">
								Remote Host
							</Label>
							<Select value={remoteHostId} onValueChange={setRemoteHostId}>
								<SelectTrigger className="h-8 text-sm">
									<SelectValue placeholder="Select a host..." />
								</SelectTrigger>
								<SelectContent>
									{remoteHosts.map((host) => (
										<SelectItem key={host.id} value={host.id}>
											{host.name}
											{host.username && host.hostname
												? ` (${host.username}@${host.hostname})`
												: host.hostname
													? ` (${host.hostname})`
													: ""}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs text-muted-foreground">
								Repository URL
							</Label>
							<Input
								className="h-8 text-sm font-mono"
								placeholder="git@github.com:org/repo.git"
								value={repoUrl}
								onChange={(e) => {
									setRepoUrl(e.target.value);
									if (remoteRepoPath) setRemoteRepoPath("");
								}}
							/>
							<p className="text-[10px] text-muted-foreground">
								Clones this URL onto the remote host.
							</p>
						</div>

						<div className="flex items-center gap-3">
							<Separator className="flex-1" />
							<span className="text-[10px] text-muted-foreground uppercase tracking-wider">
								or
							</span>
							<Separator className="flex-1" />
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs text-muted-foreground">
								Existing path on remote
							</Label>
							<Input
								className="h-8 text-sm font-mono"
								placeholder="~/code/my-repo"
								value={remoteRepoPath}
								onChange={(e) => {
									setRemoteRepoPath(e.target.value);
									if (repoUrl) setRepoUrl("");
								}}
							/>
							<p className="text-[10px] text-muted-foreground">
								Path to an existing clone on the remote host.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs text-muted-foreground">
								Project name
							</Label>
							<Input
								className="h-8 text-sm"
								placeholder={derivedName || "my-repo"}
								value={nameOverride}
								onChange={(e) => setNameOverride(e.target.value)}
							/>
						</div>

						{createRemote.isError && (
							<p className="text-xs text-destructive">
								{createRemote.error.message}
							</p>
						)}

						<div className="flex justify-end gap-2 pt-1">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-3 text-xs"
								onClick={handleClose}
								disabled={createRemote.isPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								className="h-7 px-3 text-xs"
								disabled={!canSubmit}
							>
								{createRemote.isPending ? "Adding..." : "Add Project"}
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
