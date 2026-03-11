import { toast } from "@superset/ui/sonner";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { env } from "renderer/env.renderer";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";
import { getAuthToken } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { posthog } from "renderer/lib/posthog";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { ChatMastraLaunchConfig } from "shared/tabs-types";
import type { StartFreshSessionResult } from "../../../ChatPane/ChatInterface/types";
import { reportChatMastraError } from "../../utils/reportChatMastraError";
import { createSessionInitRunner } from "../../utils/session-init-runner";

const apiUrl = env.NEXT_PUBLIC_API_URL;
const SESSION_INIT_RETRY_DELAY_MS = 1500;
const SESSION_INIT_MAX_RETRIES = 3;

interface SessionSelectorItem {
	sessionId: string;
	title: string;
	updatedAt: Date;
}

interface UseChatMastraPaneControllerOptions {
	paneId: string;
	workspaceId: string;
}

interface UseChatMastraPaneControllerReturn {
	sessionId: string | null;
	launchConfig: ChatMastraLaunchConfig | null;
	workspacePath: string;
	isSessionInitializing: boolean;
	hasCurrentSessionRecord: boolean;
	sessionItems: SessionSelectorItem[];
	handleSelectSession: (sessionId: string) => void;
	handleNewChat: () => Promise<void>;
	handleStartFreshSession: () => Promise<StartFreshSessionResult>;
	handleDeleteSession: (sessionId: string) => Promise<void>;
	ensureCurrentSessionRecord: () => Promise<boolean>;
	consumeLaunchConfig: () => void;
}

function toSessionSelectorItem(session: {
	id: string;
	title: string | null;
	lastActiveAt: Date | string | null;
	createdAt: Date | string;
}): SessionSelectorItem {
	return {
		sessionId: session.id,
		title: session.title ?? "",
		updatedAt:
			session.lastActiveAt instanceof Date
				? session.lastActiveAt
				: session.lastActiveAt
					? new Date(session.lastActiveAt)
					: session.createdAt instanceof Date
						? session.createdAt
						: new Date(session.createdAt),
	};
}

async function getHttpErrorDetail(response: Response): Promise<string> {
	const errorBody = await response
		.text()
		.then((text) => text.trim())
		.catch(() => "");
	const statusText = response.statusText ? ` ${response.statusText}` : "";
	const detail = errorBody ? ` - ${errorBody.slice(0, 500)}` : "";
	return `${response.status}${statusText}${detail}`;
}

async function createSessionRecord(input: {
	sessionId: string;
	workspaceId: string;
}): Promise<void> {
	const token = getAuthToken();
	const response = await fetch(`${apiUrl}/api/chat/${input.sessionId}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			workspaceId: input.workspaceId,
		}),
	});

	if (!response.ok) {
		const detail = await getHttpErrorDetail(response);
		console.warn("[chat-sessions] create session failed", {
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			detail,
		});
		throw new Error(`Failed to create session ${input.sessionId}: ${detail}`);
	}
}

async function deleteSessionRecord(sessionId: string): Promise<void> {
	const token = getAuthToken();
	const response = await fetch(`${apiUrl}/api/chat/${sessionId}/stream`, {
		method: "DELETE",
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});

	if (!response.ok) {
		const detail = await getHttpErrorDetail(response);
		throw new Error(`Failed to delete session ${sessionId}: ${detail}`);
	}
}

export function useChatMastraPaneController({
	paneId,
	workspaceId,
}: UseChatMastraPaneControllerOptions): UseChatMastraPaneControllerReturn {
	const pane = useTabsStore((state) => state.panes[paneId]);
	const switchChatMastraSession = useTabsStore(
		(state) => state.switchChatMastraSession,
	);
	const setChatMastraLaunchConfig = useTabsStore(
		(state) => state.setChatMastraLaunchConfig,
	);
	const sessionId = pane?.chatMastra?.sessionId ?? null;
	const launchConfig = pane?.chatMastra?.launchConfig ?? null;
	const needsLegacySessionBootstrap = sessionId === null;
	const collections = useCollections();
	const legacySessionBootstrapRef = useRef(false);
	const ensuredRef = useRef<string | null>(null);

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ enabled: Boolean(workspaceId) },
	);

	const { data: remoteWorkspaces } = useLiveQuery(
		(q) =>
			q
				.from({ ws: collections.workspaces })
				.where(({ ws }) => eq(ws.id, workspaceId))
				.select(({ ws }) => ({ id: ws.id })),
		[collections.workspaces, workspaceId],
	);
	const existsRemotely = Boolean(
		remoteWorkspaces && remoteWorkspaces.length > 0,
	);

	useEffect(() => {
		if (existsRemotely) return;
		if (!workspace?.project) return;
		if (ensuredRef.current === workspaceId) return;

		const project = workspace.project;
		const repoName = project.mainRepoPath.split("/").pop();
		if (!repoName || !project.githubOwner) return;

		ensuredRef.current = workspaceId;

		apiTrpcClient.workspace.ensure
			.mutate({
				project: {
					name: project.name,
					slug: repoName.toLowerCase(),
					repoOwner: project.githubOwner,
					repoName,
					repoUrl: `https://github.com/${project.githubOwner}/${repoName}`,
					defaultBranch: project.defaultBranch ?? "main",
				},
				workspace: {
					id: workspaceId,
					name: workspace.name,
					type: "local",
					config: {
						path: workspace.worktreePath,
						branch:
							workspace.worktree?.branch ?? project.defaultBranch ?? "main",
					},
				},
			})
			.catch((error) => {
				reportChatMastraError({
					operation: "workspace.ensure",
					error,
					workspaceId,
					paneId,
				});
				ensuredRef.current = null;
			});
	}, [existsRemotely, paneId, workspace, workspaceId]);

	const { data: allSessionsData } = useLiveQuery(
		(q) =>
			q
				.from({ chatSessions: collections.chatSessions })
				.orderBy(({ chatSessions }) => chatSessions.lastActiveAt, "desc")
				.select(({ chatSessions }) => ({ ...chatSessions })),
		[collections.chatSessions],
	);
	const allSessions = allSessionsData ?? [];
	const sessions = useMemo(() => {
		const scopedOrUnscoped = allSessions.filter(
			(item) => item.workspaceId === workspaceId || item.workspaceId === null,
		);
		return scopedOrUnscoped.length > 0 ? scopedOrUnscoped : allSessions;
	}, [allSessions, workspaceId]);
	const hasCurrentSessionRecord = Boolean(
		sessionId && sessions.some((item) => item.id === sessionId),
	);
	const [isSessionInitializing, setIsSessionInitializing] = useState(false);
	const hasCurrentSessionRecordRef = useRef(hasCurrentSessionRecord);
	const sessionInitScopeRef = useRef<string | null>(null);
	const sessionInitRunnerRef = useRef<ReturnType<
		typeof createSessionInitRunner
	> | null>(null);

	useEffect(() => {
		hasCurrentSessionRecordRef.current = hasCurrentSessionRecord;
	}, [hasCurrentSessionRecord]);

	if (!sessionInitRunnerRef.current) {
		sessionInitRunnerRef.current = createSessionInitRunner({
			maxRetries: SESSION_INIT_MAX_RETRIES,
			retryDelayMs: SESSION_INIT_RETRY_DELAY_MS,
			hasCurrentSessionRecord: () => hasCurrentSessionRecordRef.current,
			isScopeCurrent: (scopeKey) => sessionInitScopeRef.current === scopeKey,
			setIsSessionInitializing,
			createSessionRecord: async (scope) => {
				await createSessionRecord({
					sessionId: scope.sessionId,
					workspaceId: scope.workspaceId,
				});
			},
			reportCreateSessionError: (error, scope) => {
				reportChatMastraError({
					operation: "session.create",
					error,
					sessionId: scope.sessionId,
					workspaceId: scope.workspaceId,
					paneId,
				});
			},
			onRetryExhausted: () => {
				toast.error("Failed to initialize chat session");
			},
		});
	}

	useEffect(() => {
		return () => {
			sessionInitRunnerRef.current?.dispose();
		};
	}, []);

	useEffect(() => {
		const scope = `${workspaceId}:${sessionId ?? "none"}`;
		if (sessionInitScopeRef.current === scope) return;
		sessionInitScopeRef.current = scope;
		sessionInitRunnerRef.current?.resetScope(scope);
	}, [sessionId, workspaceId]);

	const currentSessionInitScope = useMemo(() => {
		if (!sessionId) return null;
		return {
			scopeKey: `${workspaceId}:${sessionId}`,
			workspaceId,
			sessionId,
		};
	}, [sessionId, workspaceId]);

	const handleSelectSession = useCallback(
		(nextSessionId: string) => {
			switchChatMastraSession(paneId, nextSessionId);
			posthog.capture("chat_session_opened", {
				workspace_id: workspaceId,
				session_id: nextSessionId,
			});
		},
		[paneId, switchChatMastraSession, workspaceId],
	);

	const createAndActivateSession = useCallback(
		async ({
			newSessionId,
		}: {
			newSessionId: string;
		}): Promise<StartFreshSessionResult> => {
			try {
				await createSessionRecord({
					sessionId: newSessionId,
					workspaceId,
				});
				switchChatMastraSession(paneId, newSessionId);
				posthog.capture("chat_session_created", {
					workspace_id: workspaceId,
					session_id: newSessionId,
				});
				return { created: true, sessionId: newSessionId };
			} catch (error) {
				reportChatMastraError({
					operation: "session.create",
					error,
					sessionId: newSessionId,
					workspaceId,
					paneId,
				});
				return {
					created: false,
					errorMessage:
						error instanceof Error
							? error.message
							: "Failed to create a new chat session",
				};
			}
		},
		[paneId, switchChatMastraSession, workspaceId],
	);

	const handleNewChat = useCallback(async () => {
		const createResult = await createAndActivateSession({
			newSessionId: crypto.randomUUID(),
		});
		if (!createResult.created) {
			toast.error("Failed to create session");
		}
	}, [createAndActivateSession]);

	const handleStartFreshSession = useCallback(async () => {
		return createAndActivateSession({
			newSessionId: crypto.randomUUID(),
		});
	}, [createAndActivateSession]);

	const handleDeleteSession = useCallback(
		async (sessionIdToDelete: string) => {
			try {
				await deleteSessionRecord(sessionIdToDelete);
				posthog.capture("chat_session_deleted", {
					workspace_id: workspaceId,
					session_id: sessionIdToDelete,
				});
				if (sessionIdToDelete === sessionId) {
					switchChatMastraSession(paneId, null);
				}
			} catch (error) {
				reportChatMastraError({
					operation: "session.delete",
					error,
					sessionId: sessionIdToDelete,
					workspaceId,
					paneId,
				});
				throw error;
			}
		},
		[paneId, sessionId, switchChatMastraSession, workspaceId],
	);

	const runSessionInit = useCallback(
		async ({
			retryOnFailure,
		}: {
			retryOnFailure: boolean;
		}): Promise<boolean> => {
			if (!currentSessionInitScope) return false;
			const runner = sessionInitRunnerRef.current;
			if (!runner) return false;
			return runner.run({ scope: currentSessionInitScope, retryOnFailure });
		},
		[currentSessionInitScope],
	);

	const ensureCurrentSessionRecord = useCallback(async (): Promise<boolean> => {
		return runSessionInit({ retryOnFailure: false });
	}, [runSessionInit]);

	useEffect(() => {
		if (!currentSessionInitScope) return;
		if (!hasCurrentSessionRecord) return;
		sessionInitRunnerRef.current?.markReady(currentSessionInitScope.scopeKey);
	}, [currentSessionInitScope, hasCurrentSessionRecord]);

	useEffect(() => {
		if (!currentSessionInitScope) return;
		if (hasCurrentSessionRecord) return;
		void runSessionInit({ retryOnFailure: true });
	}, [currentSessionInitScope, hasCurrentSessionRecord, runSessionInit]);

	useEffect(() => {
		// Legacy fallback for panes created before session IDs were seeded at pane creation.
		if (!needsLegacySessionBootstrap) return;
		if (legacySessionBootstrapRef.current) return;
		legacySessionBootstrapRef.current = true;

		void handleNewChat()
			.catch(() => {})
			.finally(() => {
				legacySessionBootstrapRef.current = false;
			});
	}, [handleNewChat, needsLegacySessionBootstrap]);

	const sessionItems = useMemo(
		() => sessions.map((item) => toSessionSelectorItem(item)),
		[sessions],
	);

	const consumeLaunchConfig = useCallback(() => {
		setChatMastraLaunchConfig(paneId, null);
	}, [paneId, setChatMastraLaunchConfig]);

	return {
		sessionId,
		launchConfig,
		workspacePath: workspace?.worktreePath ?? "",
		isSessionInitializing,
		hasCurrentSessionRecord,
		sessionItems,
		handleSelectSession,
		handleNewChat,
		handleStartFreshSession,
		handleDeleteSession,
		ensureCurrentSessionRecord,
		consumeLaunchConfig,
	};
}
