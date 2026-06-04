import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { useCallback } from "react";
import type { ChatPaneData } from "../../../../types";
import { buildPRContext } from "../../components/PRActionHeader/utils/buildPRContext";
import type { PRFlowState } from "../../components/PRActionHeader/utils/getPRFlowState";

/**
 * Opens a chat pane (or reuses one later — see plan phase 7) pre-populated
 * with a slash command and a synthesized `pr-context.md` attachment.
 *
 * For the MVP, `onOpenChat` always creates a new chat tab. The V2 workspace
 * page wires this up by calling `store.getState().addTab({ kind: "chat", ... })`.
 */
export type OpenChatFn = (launchConfig: ChatPaneData["launchConfig"]) => void;

export interface PRFlowDispatchArgs {
	state: PRFlowState;
	draft?: boolean;
}

export type PRFlowDispatch = (args: PRFlowDispatchArgs) => void;

interface UsePRFlowDispatchOptions {
	workspaceId: string;
	onOpenChat: OpenChatFn;
}

export function usePRFlowDispatch({
	workspaceId,
	onOpenChat,
}: UsePRFlowDispatchOptions): PRFlowDispatch {
	// Remote (Daytona) workspaces have no on-disk worktree, so the agent-driven
	// `/pr/create-pr` flow (which runs `git push` + `gh pr create` in the
	// worktree cwd) can't ship them. They publish + open the PR host-side.
	const workspaceQuery = workspaceTrpc.workspace.get.useQuery({
		id: workspaceId,
	});
	const isRemote = workspaceQuery.data?.runtimeKind === "remote";

	const refreshPRMutation =
		workspaceTrpc.pullRequests.refreshByWorkspaces.useMutation();
	const publishMutation =
		workspaceTrpc.pullRequests.publishAndCreatePR.useMutation({
			onMutate: () => ({ toastId: toast.loading("Creating pull request…") }),
			onSuccess: async (data, _variables, context) => {
				toast.success(`PR #${data.number} created`, { id: context?.toastId });
				await refreshPRMutation
					.mutateAsync({ workspaceIds: [workspaceId] })
					.catch(() => {});
			},
			onError: (error, _variables, context) => {
				toast.error(`Create PR failed: ${error.message}`, {
					id: context?.toastId,
				});
			},
		});

	return useCallback(
		({ state, draft }: PRFlowDispatchArgs) => {
			if (state.kind !== "no-pr") return;

			if (isRemote) {
				publishMutation.mutate({ workspaceId, draft: draft === true });
				return;
			}

			const plan = planDispatch(state, { draft: draft === true });
			if (!plan) return;
			onOpenChat({
				initialPrompt: plan.prompt,
				initialFiles: [plan.attachment],
			});
		},
		[isRemote, onOpenChat, publishMutation, workspaceId],
	);
}

interface DispatchPlan {
	prompt: string;
	attachment: {
		data: string;
		mediaType: string;
		filename: string;
	};
}

export function planDispatch(
	state: PRFlowState,
	options: { draft: boolean },
): DispatchPlan | null {
	switch (state.kind) {
		case "no-pr": {
			const prompt = options.draft ? "/pr/create-pr --draft" : "/pr/create-pr";
			const markdown = buildPRContext(state);
			return {
				prompt,
				attachment: {
					data: encodeAsDataUrl(markdown, "text/markdown"),
					mediaType: "text/markdown",
					filename: "pr-context.md",
				},
			};
		}
		// MVP scope: other states don't dispatch yet.
		default:
			return null;
	}
}

function encodeAsDataUrl(content: string, mediaType: string): string {
	// `unescape` is removed from WHATWG; use TextEncoder for UTF-8 → base64.
	// Branch names + commit messages can carry non-ASCII characters.
	const base64 =
		typeof btoa === "function"
			? btoa(
					Array.from(new TextEncoder().encode(content), (b) =>
						String.fromCharCode(b),
					).join(""),
				)
			: Buffer.from(content, "utf-8").toString("base64");
	return `data:${mediaType};base64,${base64}`;
}
