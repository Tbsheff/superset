/**
 * Desktop-main registry wiring for remote workspaces.
 *
 * Assembles the `WorkspaceRuntimeRegistryDeps` the singleton registry is
 * constructed with: the synchronous runtime-kind resolver (backed by the
 * in-memory binding store) plus the host-service-backed remote PTY transport
 * factory. The registry construction site (`main/windows/main.ts`) calls this
 * once so every `getForWorkspaceId("remote-ws")` routes to the
 * `RemoteWorkspaceRuntime` over the live host-service connection.
 */

import type { WorkspaceRuntimeRegistryDeps } from "../registry";
import {
	createHostServiceRemoteTransportFactory,
	type HostServiceRemoteConnection,
	type RemotePtyChannel,
	type RemotePtyControlMessage,
} from "./hostServiceRemoteTransport";
import { resolveWorkspaceRuntimeKind } from "./workspaceRuntimeBindingStore";

export interface WorkspaceRuntimeRegistryWiringDeps {
	/**
	 * Resolves the live host-service connection for a workspace. Production wires
	 * this to the coordinator (`getConnection(orgId)` -> origin + secret); a null
	 * result means the host-service is not running for that workspace.
	 */
	resolveConnection: (
		workspaceId: string,
	) => HostServiceRemoteConnection | null;
	/**
	 * Opens the duplex channel to the host-service remote PTY endpoint. Defaults
	 * to a global-`WebSocket` channel; injectable so tests drive it in-memory.
	 */
	openChannel?: (args: {
		connection: HostServiceRemoteConnection;
		workspaceId: string;
		paneId: string;
	}) => RemotePtyChannel;
}

/**
 * The host-service WS path for a remote (sandbox) PTY. The host upgrades this to
 * a duplex byte/JSON channel; the PSK rides the `token` query param exactly like
 * the existing `/terminal/*` routes (see host-service `app.ts` `wsAuth`).
 */
function remotePtyWsUrl(args: {
	connection: HostServiceRemoteConnection;
	workspaceId: string;
	paneId: string;
}): string {
	const base = args.connection.origin.replace(/^http/, "ws").replace(/\/$/, "");
	const url = new URL(
		`${base}/runtime/${encodeURIComponent(args.workspaceId)}/pty/${encodeURIComponent(args.paneId)}`,
	);
	url.searchParams.set("token", args.connection.secret);
	return url.toString();
}

/**
 * Default channel opener over the global `WebSocket` (Electron main ships Node
 * 22, which provides it — no `ws` package needed). Decodes server frames:
 * binary frames are PTY output bytes (decoded to string with a streaming
 * UTF-8 decoder so a glyph never splits across frames); text frames are JSON
 * control messages.
 */
function openWebSocketChannel(args: {
	connection: HostServiceRemoteConnection;
	workspaceId: string;
	paneId: string;
}): RemotePtyChannel {
	const socket = new WebSocket(remotePtyWsUrl(args));
	socket.binaryType = "arraybuffer";

	const decoder = new TextDecoder("utf-8");
	let outputCb: ((chunk: string) => void) | null = null;
	let controlCb: ((message: RemotePtyControlMessage) => void) | null = null;

	const ready = new Promise<void>((resolve, reject) => {
		const onAttachOrError = (message: RemotePtyControlMessage) => {
			if (message.type === "attached") resolve();
			else if (message.type === "error") reject(new Error(message.message));
		};
		const prior = controlCb;
		controlCb = (message) => {
			onAttachOrError(message);
			prior?.(message);
		};
		socket.addEventListener("error", () =>
			reject(new Error(`remote-pty: WebSocket error for pane ${args.paneId}`)),
		);
		socket.addEventListener("close", () => {
			// A close before `attached` is a failed open; after attach the runtime's
			// exit handling owns teardown, so this rejection is a no-op then.
			reject(new Error(`remote-pty: WebSocket closed for pane ${args.paneId}`));
		});
	});

	socket.addEventListener("message", (event: MessageEvent) => {
		if (event.data instanceof ArrayBuffer) {
			const chunk = decoder.decode(new Uint8Array(event.data), {
				stream: true,
			});
			if (chunk.length > 0) outputCb?.(chunk);
			return;
		}
		try {
			const message = JSON.parse(String(event.data)) as RemotePtyControlMessage;
			controlCb?.(message);
		} catch {
			// Ignore malformed control frames rather than tearing down the channel.
		}
	});

	return {
		ready,
		onOutput: (cb) => {
			outputCb = cb;
		},
		onControl: (cb) => {
			const prior = controlCb;
			controlCb = (message) => {
				prior?.(message);
				cb(message);
			};
		},
		send: (message) => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		},
		close: () => socket.close(),
	};
}

/**
 * Builds the deps the registry singleton is constructed with. The resolver is
 * always wired; the remote transport factory is wired so a `runtimeKind`
 * `"remote"` workspace routes to the host-service-backed runtime.
 */
export function createWorkspaceRuntimeRegistryDeps(
	deps: WorkspaceRuntimeRegistryWiringDeps,
): WorkspaceRuntimeRegistryDeps {
	return {
		resolveRuntimeKind: resolveWorkspaceRuntimeKind,
		remoteTransportFactory: createHostServiceRemoteTransportFactory({
			resolveConnection: deps.resolveConnection,
			openChannel: deps.openChannel ?? openWebSocketChannel,
		}),
	};
}
