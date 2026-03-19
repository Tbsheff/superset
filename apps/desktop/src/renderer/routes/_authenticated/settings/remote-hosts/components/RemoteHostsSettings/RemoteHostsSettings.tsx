import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { useCallback, useState } from "react";
import { FileTerminal, Plug, PlugZap, Plus, Trash2, Unplug } from "lucide-react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { SettingItemId } from "renderer/routes/_authenticated/settings/utils/settings-search";
import {
	isItemVisible,
	SETTING_ITEM_ID,
} from "renderer/routes/_authenticated/settings/utils/settings-search";

interface RemoteHostsSettingsProps {
	visibleItems: SettingItemId[] | null;
}

/** Per-host test state so results don't bleed across cards */
interface HostTestState {
	isPending: boolean;
	result: { success: boolean; error: string | null } | null;
	showPassword: boolean;
	password: string;
}

export function RemoteHostsSettings({
	visibleItems,
}: RemoteHostsSettingsProps) {
	const { data: hosts, refetch } = electronTrpc.remoteHosts.list.useQuery();
	const createFromCommandMutation =
		electronTrpc.remoteHosts.createFromCommand.useMutation({
			onSuccess: () => refetch(),
		});
	const deleteMutation = electronTrpc.remoteHosts.delete.useMutation({
		onSuccess: () => refetch(),
	});
	const testMutation = electronTrpc.remoteHosts.testConnection.useMutation();
	const updateMutation = electronTrpc.remoteHosts.update.useMutation({
		onSuccess: () => refetch(),
	});

	const updateHost = (
		id: string,
		updates: {
			dockerMemoryLimit?: string | null;
			dockerCpuLimit?: number | null;
			idleTimeoutMinutes?: number | null;
		},
	) => {
		updateMutation.mutate({ id, ...updates });
	};

	const [importDialogOpen, setImportDialogOpen] = useState(false);
	const [sshCommand, setSshCommand] = useState("");
	const [hostTestStates, setHostTestStates] = useState<
		Record<string, HostTestState>
	>({});

	const discoverQuery = electronTrpc.remoteHosts.discoverHosts.useQuery(
		undefined,
		{ enabled: importDialogOpen },
	);

	const importMutation =
		electronTrpc.remoteHosts.importFromSshConfig.useMutation({
			onSuccess: () => refetch(),
		});

	const handleCreate = () => {
		if (!sshCommand.trim()) return;
		createFromCommandMutation.mutate({ command: sshCommand.trim() });
		setSshCommand("");
	};

	const _getHostTestState = useCallback(
		(hostId: string): HostTestState =>
			hostTestStates[hostId] ?? {
				isPending: false,
				result: null,
				showPassword: false,
				password: "",
			},
		[hostTestStates],
	);

	const updateHostTestState = useCallback(
		(hostId: string, patch: Partial<HostTestState>) => {
			setHostTestStates((prev) => ({
				...prev,
				[hostId]: {
					...(prev[hostId] ?? {
						isPending: false,
						result: null,
						showPassword: false,
						password: "",
					}),
					...patch,
				},
			}));
		},
		[],
	);

	const handleTest = (
		host: {
			id: string;
			hostname: string | null;
			port: number | null;
			username: string | null;
			authMethod: string | null;
			privateKeyPath: string | null;
		},
		password?: string,
	) => {
		if (!host.hostname || !host.username || !host.authMethod) return;
		updateHostTestState(host.id, { isPending: true, result: null });
		testMutation.mutate(
			{
				hostname: host.hostname,
				port: host.port ?? 22,
				username: host.username,
				authMethod: host.authMethod as "key" | "agent" | "password",
				privateKeyPath: host.privateKeyPath ?? undefined,
				password,
			},
			{
				onSuccess: (data) => {
					updateHostTestState(host.id, {
						isPending: false,
						result: data,
						// Show password input on auth failure, hide on success
						showPassword: !data.success,
						// Clear password on success
						...(data.success ? { password: "" } : {}),
					});
				},
				onError: (err) => {
					updateHostTestState(host.id, {
						isPending: false,
						result: {
							success: false,
							error: err.message ?? "Connection failed",
						},
						showPassword: true,
					});
				},
			},
		);
	};

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-6">
				<h1 className="text-lg font-semibold">Remote Hosts</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Configure SSH hosts for remote terminal sessions. Assign a host to a
					workspace to run terminals on remote machines.
				</p>
			</div>

			{isItemVisible(SETTING_ITEM_ID.REMOTE_HOSTS_LIST, visibleItems) && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h2 className="text-sm font-medium">Configured Hosts</h2>
						<Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
							<DialogTrigger asChild>
								<Button variant="outline" size="sm">
									<FileTerminal className="h-4 w-4 mr-1.5" />
									Discover SSH Hosts
								</Button>
							</DialogTrigger>
							<DialogContent className="max-w-lg">
								<DialogHeader>
									<DialogTitle>Import SSH Host</DialogTitle>
									<p className="text-sm text-muted-foreground">
										Hosts discovered from your SSH config
									</p>
								</DialogHeader>
								<div className="space-y-2 max-h-[400px] overflow-auto py-2">
									{discoverQuery.isLoading && (
										<p className="text-sm text-muted-foreground text-center py-4">
											Discovering hosts...
										</p>
									)}
									{!discoverQuery.isLoading &&
										!discoverQuery.data?.config.length && (
											<p className="text-sm text-muted-foreground text-center py-4">
												No hosts discovered
											</p>
										)}
									{(discoverQuery.data?.config.length ?? 0) > 0 && (
										<>
											<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
												SSH Config
											</p>
											{discoverQuery.data?.config.map((sshHost) => {
												const alreadyAdded = hosts?.some(
													(h) =>
														h.hostname === sshHost.hostname &&
														h.name === sshHost.name,
												);
												return (
													<div
														key={sshHost.name}
														className="flex items-center justify-between rounded-lg border p-3"
													>
														<div>
															<p className="text-sm font-medium">
																{sshHost.name}
															</p>
															<p className="text-xs text-muted-foreground">
																{sshHost.username ? `${sshHost.username}@` : ""}
																{sshHost.hostname ?? "no hostname"}
																{sshHost.port !== 22 ? `:${sshHost.port}` : ""}
															</p>
															{sshHost.identityFile && (
																<p className="text-xs text-muted-foreground/60">
																	Key: {sshHost.identityFile}
																</p>
															)}
														</div>
														<Button
															variant={alreadyAdded ? "ghost" : "outline"}
															size="sm"
															disabled={
																alreadyAdded ||
																!sshHost.hostname ||
																importMutation.isPending
															}
															onClick={() => {
																if (!sshHost.hostname) return;
																importMutation.mutate({
																	name: sshHost.name,
																	hostname: sshHost.hostname,
																	port: sshHost.port,
																	username: sshHost.username ?? undefined,
																	identityFile:
																		sshHost.identityFile ?? undefined,
																});
															}}
														>
															{alreadyAdded ? "Added" : "Import"}
														</Button>
													</div>
												);
											})}
										</>
									)}
								</div>
							</DialogContent>
						</Dialog>
					</div>

					<div className="flex items-center gap-2">
						<Input
							placeholder="ssh user@example -p 2222"
							value={sshCommand}
							onChange={(e) => setSshCommand(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCreate();
							}}
							className="flex-1"
						/>
						<Button
							onClick={handleCreate}
							disabled={
								!sshCommand.trim() || createFromCommandMutation.isPending
							}
							size="sm"
						>
							<Plus className="h-4 w-4 mr-1.5" />
							Add
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						Enter the SSH command you use to connect to this server
					</p>

					{(!hosts || hosts.length === 0) && (
						<div className="rounded-lg border border-dashed p-8 text-center">
							<p className="text-sm text-muted-foreground">
								No remote hosts configured. Add an SSH host to get started.
							</p>
						</div>
					)}

					{hosts?.map((host) => (
						<div key={host.id} className="rounded-lg border p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
										<Plug className="h-4 w-4" />
									</div>
									<div>
										<p className="text-sm font-medium">{host.name}</p>
										<p className="text-xs text-muted-foreground">
											{host.username}@{host.hostname}:{host.port ?? 22}
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									{testMutation.data && !testMutation.isPending && (
										<span
											className={`text-xs ${testMutation.data.success ? "text-green-500" : "text-red-500"}`}
										>
											{testMutation.data.success
												? "Connected"
												: testMutation.data.error}
										</span>
									)}
									<Button
										variant="ghost"
										size="sm"
										onClick={() => handleTest(host)}
										disabled={testMutation.isPending}
									>
										{testMutation.isPending ? (
											<PlugZap className="h-4 w-4 animate-pulse" />
										) : (
											<Unplug className="h-4 w-4" />
										)}
										<span className="ml-1.5">Test</span>
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => deleteMutation.mutate(host.id)}
									>
										<Trash2 className="h-4 w-4 text-destructive" />
									</Button>
								</div>
							</div>
							<div className="mt-3 border-t pt-3">
								<p className="text-xs font-medium text-muted-foreground mb-2">
									Docker Settings
								</p>
								<div className="grid grid-cols-3 gap-2">
									<div>
										<label className="text-xs text-muted-foreground">
											Memory Limit
										</label>
										<Input
											placeholder="e.g. 8g"
											defaultValue={host.dockerMemoryLimit ?? ""}
											onBlur={(e) =>
												updateHost(host.id, {
													dockerMemoryLimit: e.target.value || null,
												})
											}
											className="h-7 text-xs"
										/>
									</div>
									<div>
										<label className="text-xs text-muted-foreground">
											CPU Limit
										</label>
										<Input
											placeholder="e.g. 4"
											type="number"
											defaultValue={host.dockerCpuLimit ?? ""}
											onBlur={(e) =>
												updateHost(host.id, {
													dockerCpuLimit: e.target.value
														? Number(e.target.value)
														: null,
												})
											}
											className="h-7 text-xs"
										/>
									</div>
									<div>
										<label className="text-xs text-muted-foreground">
											Idle Timeout (min)
										</label>
										<Input
											placeholder="e.g. 30"
											type="number"
											defaultValue={host.idleTimeoutMinutes ?? ""}
											onBlur={(e) =>
												updateHost(host.id, {
													idleTimeoutMinutes: e.target.value
														? Number(e.target.value)
														: null,
												})
											}
											className="h-7 text-xs"
										/>
									</div>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
