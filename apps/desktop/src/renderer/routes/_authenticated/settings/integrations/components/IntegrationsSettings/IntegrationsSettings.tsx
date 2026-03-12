import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "@superset/ui/card";
import { Input } from "@superset/ui/input";
import { Skeleton } from "@superset/ui/skeleton";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useState } from "react";
import { FaGithub, FaSlack } from "react-icons/fa";
import { HiCheckCircle, HiOutlineArrowTopRightOnSquare } from "react-icons/hi2";
import { SiLinear } from "react-icons/si";
import { vanillaElectronTrpc } from "renderer/lib/vanilla-electron-trpc";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface IntegrationsSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

interface GithubInstallation {
	id: string;
	accountLogin: string | null;
	accountType: string | null;
	suspended: boolean | null;
	lastSyncedAt: Date | null;
	createdAt: Date;
}

export function IntegrationsSettings({
	visibleItems,
}: IntegrationsSettingsProps) {
	const collections = useCollections();

	const { data: integrations } = useLiveQuery(
		(q) =>
			q
				.from({ integrationConnections: collections.integrationConnections })
				.select(({ integrationConnections }) => ({
					...integrationConnections,
				})),
		[collections],
	);

	const [githubInstallation, setGithubInstallation] =
		useState<GithubInstallation | null>(null);
	const [isLoadingGithub, setIsLoadingGithub] = useState(true);

	const hasGithubAccess = true;
	const hasSlackAccess = true;

	const showLinear = isItemVisible(
		SETTING_ITEM_ID.INTEGRATIONS_LINEAR,
		visibleItems,
	);
	const showGithub =
		hasGithubAccess &&
		isItemVisible(SETTING_ITEM_ID.INTEGRATIONS_GITHUB, visibleItems);

	const fetchGithubInstallation = useCallback(async () => {
		try {
			const result =
				await vanillaElectronTrpc.data.integration.github.getInstallation.query();
			setGithubInstallation(result);
		} catch (err) {
			console.error("[integrations] Failed to fetch GitHub installation:", err);
		} finally {
			setIsLoadingGithub(false);
		}
	}, []);

	useEffect(() => {
		fetchGithubInstallation();
	}, [fetchGithubInstallation]);

	const linearConnection = integrations?.find((i) => i.provider === "linear");
	const slackConnection = integrations?.find((i) => i.provider === "slack");
	const isLinearConnected = !!linearConnection;
	const isSlackConnected = !!slackConnection;
	const isGithubConnected =
		!!githubInstallation && !githubInstallation.suspended;
	const showSlack =
		hasSlackAccess &&
		isItemVisible(SETTING_ITEM_ID.INTEGRATIONS_SLACK, visibleItems);

	const handleOpenApi = (_path: string) => {
		console.warn("[integrations] OAuth flow unavailable without API server");
	};

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Integrations</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Connect external services to sync data
				</p>
			</div>

			<div className="grid gap-4">
				{showLinear && (
					<LinearIntegrationCard
						isConnected={isLinearConnected}
						connectedOrgName={linearConnection?.externalOrgName}
					/>
				)}

				{showGithub && (
					<IntegrationCard
						name="GitHub"
						description="Connect repos and sync pull requests"
						icon={<FaGithub className="size-6" />}
						isConnected={isGithubConnected}
						connectedOrgName={githubInstallation?.accountLogin}
						isLoading={isLoadingGithub}
						onManage={() =>
							isGithubConnected
								? handleOpenApi("/api/github/install")
								: handleOpenApi("/api/github/install")
						}
					/>
				)}

				{showSlack && (
					<IntegrationCard
						name="Slack"
						description="Manage tasks from Slack conversations"
						icon={<FaSlack className="size-6" />}
						isConnected={isSlackConnected}
						connectedOrgName={slackConnection?.externalOrgName}
						onManage={() =>
							isSlackConnected
								? handleOpenApi("/api/integrations/slack/connect")
								: handleOpenApi("/api/integrations/slack/connect")
						}
					/>
				)}
			</div>

			<p className="mt-6 text-xs text-muted-foreground">
				Get your Linear API key from{" "}
				<a
					href="https://linear.app/settings/api"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-primary hover:underline"
				>
					Linear Settings → API
					<HiOutlineArrowTopRightOnSquare className="h-3 w-3" />
				</a>
			</p>
		</div>
	);
}

function LinearIntegrationCard({
	isConnected,
	connectedOrgName,
}: {
	isConnected: boolean;
	connectedOrgName?: string | null;
}) {
	const [tokenInput, setTokenInput] = useState("");
	const [isConnecting, setIsConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showInput, setShowInput] = useState(false);

	const handleConnect = async () => {
		if (!tokenInput.trim()) return;
		setIsConnecting(true);
		setError(null);
		try {
			await vanillaElectronTrpc.data.integration.linear.connectWithToken.mutate(
				{
					apiToken: tokenInput.trim(),
				},
			);
			setTokenInput("");
			setShowInput(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to connect");
		} finally {
			setIsConnecting(false);
		}
	};

	const handleDisconnect = async () => {
		try {
			await vanillaElectronTrpc.data.integration.linear.disconnect.mutate();
		} catch (err) {
			console.error("[integrations] Failed to disconnect Linear:", err);
		}
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
							<SiLinear className="size-6" />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<span className="font-medium">Linear</span>
								{isConnected ? (
									<Badge variant="default" className="gap-1">
										<HiCheckCircle className="size-3" />
										Connected
									</Badge>
								) : (
									<Badge variant="secondary">Not Connected</Badge>
								)}
							</div>
							<CardDescription className="mt-0.5">
								Sync issues bidirectionally with Linear
							</CardDescription>
						</div>
					</div>
					{isConnected ? (
						<Button variant="outline" size="sm" onClick={handleDisconnect}>
							Disconnect
						</Button>
					) : (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setShowInput(!showInput)}
						>
							Connect
						</Button>
					)}
				</div>
			</CardHeader>
			{isConnected && connectedOrgName && (
				<CardContent className="pt-0">
					<p className="text-sm text-muted-foreground">
						Connected to <span className="font-medium">{connectedOrgName}</span>
					</p>
				</CardContent>
			)}
			{!isConnected && showInput && (
				<CardContent className="pt-0">
					<div className="flex gap-2">
						<Input
							type="password"
							placeholder="lin_api_..."
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleConnect()}
							className="font-mono text-sm"
						/>
						<Button
							size="sm"
							onClick={handleConnect}
							disabled={isConnecting || !tokenInput.trim()}
						>
							{isConnecting ? "Connecting..." : "Save"}
						</Button>
					</div>
					{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
				</CardContent>
			)}
		</Card>
	);
}

interface IntegrationCardProps {
	name: string;
	description: string;
	icon: React.ReactNode;
	isConnected: boolean;
	connectedOrgName?: string | null;
	isLoading?: boolean;
	onManage: () => void;
	comingSoon?: boolean;
}

function IntegrationCard({
	name,
	description,
	icon,
	isConnected,
	connectedOrgName,
	isLoading,
	onManage,
	comingSoon,
}: IntegrationCardProps) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
							{icon}
						</div>
						<div>
							<div className="flex items-center gap-2">
								<span className="font-medium">{name}</span>
								{isLoading ? (
									<Skeleton className="h-5 w-20" />
								) : isConnected ? (
									<Badge variant="default" className="gap-1">
										<HiCheckCircle className="size-3" />
										Connected
									</Badge>
								) : comingSoon ? (
									<Badge variant="outline">Coming Soon</Badge>
								) : (
									<Badge variant="secondary">Not Connected</Badge>
								)}
							</div>
							<CardDescription className="mt-0.5">
								{description}
							</CardDescription>
						</div>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={onManage}
						disabled={comingSoon}
						className="gap-2"
					>
						<HiOutlineArrowTopRightOnSquare className="size-4" />
						{isConnected ? "Manage" : "Connect"}
					</Button>
				</div>
			</CardHeader>
			{isConnected && connectedOrgName && (
				<CardContent className="pt-0">
					<p className="text-sm text-muted-foreground">
						Connected to <span className="font-medium">{connectedOrgName}</span>
					</p>
				</CardContent>
			)}
		</Card>
	);
}
