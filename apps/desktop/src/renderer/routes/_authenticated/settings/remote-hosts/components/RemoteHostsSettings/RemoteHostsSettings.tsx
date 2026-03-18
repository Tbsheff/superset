import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
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
import { useState } from "react";
import { HiOutlinePlus, HiOutlineTrash } from "react-icons/hi2";
import { LuPlug, LuPlugZap, LuUnplug } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { SettingItemId } from "renderer/routes/_authenticated/settings/utils/settings-search";
import {
	isItemVisible,
	SETTING_ITEM_ID,
} from "renderer/routes/_authenticated/settings/utils/settings-search";

interface RemoteHostsSettingsProps {
	visibleItems: SettingItemId[] | null;
}

export function RemoteHostsSettings({
	visibleItems,
}: RemoteHostsSettingsProps) {
	const { data: hosts, refetch } = electronTrpc.remoteHosts.list.useQuery();
	const createMutation = electronTrpc.remoteHosts.create.useMutation({
		onSuccess: () => refetch(),
	});
	const deleteMutation = electronTrpc.remoteHosts.delete.useMutation({
		onSuccess: () => refetch(),
	});
	const testMutation = electronTrpc.remoteHosts.testConnection.useMutation();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [form, setForm] = useState({
		name: "",
		hostname: "",
		port: "22",
		username: "",
		authMethod: "agent" as "key" | "agent" | "password",
		privateKeyPath: "",
		defaultCwd: "",
	});

	const resetForm = () => {
		setForm({
			name: "",
			hostname: "",
			port: "22",
			username: "",
			authMethod: "agent",
			privateKeyPath: "",
			defaultCwd: "",
		});
	};

	const handleCreate = () => {
		createMutation.mutate({
			name: form.name,
			type: "ssh",
			hostname: form.hostname,
			port: Number.parseInt(form.port, 10) || 22,
			username: form.username,
			authMethod: form.authMethod,
			privateKeyPath: form.privateKeyPath || undefined,
			defaultCwd: form.defaultCwd || undefined,
		});
		setDialogOpen(false);
		resetForm();
	};

	const handleTest = (host: {
		hostname: string | null;
		port: number | null;
		username: string | null;
		authMethod: string | null;
		privateKeyPath: string | null;
	}) => {
		if (!host.hostname || !host.username || !host.authMethod) return;
		testMutation.mutate({
			hostname: host.hostname,
			port: host.port ?? 22,
			username: host.username,
			authMethod: host.authMethod as "key" | "agent" | "password",
			privateKeyPath: host.privateKeyPath ?? undefined,
		});
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
						<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
							<DialogTrigger asChild>
								<Button variant="outline" size="sm">
									<HiOutlinePlus className="h-4 w-4 mr-1.5" />
									Add Host
								</Button>
							</DialogTrigger>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>Add SSH Host</DialogTitle>
								</DialogHeader>
								<div className="grid gap-4 py-4">
									<div className="grid gap-2">
										<Label htmlFor="name">Name</Label>
										<Input
											id="name"
											placeholder="My Server"
											value={form.name}
											onChange={(e) =>
												setForm((f) => ({ ...f, name: e.target.value }))
											}
										/>
									</div>
									<div className="grid grid-cols-3 gap-2">
										<div className="col-span-2 grid gap-2">
											<Label htmlFor="hostname">Hostname</Label>
											<Input
												id="hostname"
												placeholder="192.168.1.100"
												value={form.hostname}
												onChange={(e) =>
													setForm((f) => ({ ...f, hostname: e.target.value }))
												}
											/>
										</div>
										<div className="grid gap-2">
											<Label htmlFor="port">Port</Label>
											<Input
												id="port"
												placeholder="22"
												value={form.port}
												onChange={(e) =>
													setForm((f) => ({ ...f, port: e.target.value }))
												}
											/>
										</div>
									</div>
									<div className="grid gap-2">
										<Label htmlFor="username">Username</Label>
										<Input
											id="username"
											placeholder="root"
											value={form.username}
											onChange={(e) =>
												setForm((f) => ({ ...f, username: e.target.value }))
											}
										/>
									</div>
									<div className="grid gap-2">
										<Label htmlFor="authMethod">Auth Method</Label>
										<Select
											value={form.authMethod}
											onValueChange={(v) =>
												setForm((f) => ({
													...f,
													authMethod: v as "key" | "agent" | "password",
												}))
											}
										>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="agent">SSH Agent</SelectItem>
												<SelectItem value="key">Private Key</SelectItem>
												<SelectItem value="password">Password</SelectItem>
											</SelectContent>
										</Select>
									</div>
									{form.authMethod === "key" && (
										<div className="grid gap-2">
											<Label htmlFor="keyPath">Private Key Path</Label>
											<Input
												id="keyPath"
												placeholder="~/.ssh/id_ed25519"
												value={form.privateKeyPath}
												onChange={(e) =>
													setForm((f) => ({
														...f,
														privateKeyPath: e.target.value,
													}))
												}
											/>
										</div>
									)}
									<div className="grid gap-2">
										<Label htmlFor="defaultCwd">
											Default Directory (optional)
										</Label>
										<Input
											id="defaultCwd"
											placeholder="/home/user/projects"
											value={form.defaultCwd}
											onChange={(e) =>
												setForm((f) => ({ ...f, defaultCwd: e.target.value }))
											}
										/>
									</div>
								</div>
								<DialogFooter>
									<Button
										variant="outline"
										onClick={() => setDialogOpen(false)}
									>
										Cancel
									</Button>
									<Button
										onClick={handleCreate}
										disabled={!form.name || !form.hostname || !form.username}
									>
										Add Host
									</Button>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</div>

					{(!hosts || hosts.length === 0) && (
						<div className="rounded-lg border border-dashed p-8 text-center">
							<p className="text-sm text-muted-foreground">
								No remote hosts configured. Add an SSH host to get started.
							</p>
						</div>
					)}

					{hosts?.map((host) => (
						<div
							key={host.id}
							className="flex items-center justify-between rounded-lg border p-4"
						>
							<div className="flex items-center gap-3">
								<div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
									<LuPlug className="h-4 w-4" />
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
										<LuPlugZap className="h-4 w-4 animate-pulse" />
									) : (
										<LuUnplug className="h-4 w-4" />
									)}
									<span className="ml-1.5">Test</span>
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => deleteMutation.mutate(host.id)}
								>
									<HiOutlineTrash className="h-4 w-4 text-destructive" />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
