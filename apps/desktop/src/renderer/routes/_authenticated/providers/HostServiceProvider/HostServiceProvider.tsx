import { createContext, type ReactNode, useContext, useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	getHostServiceClient,
	type HostServiceClient,
} from "renderer/lib/host-service-client";

export interface OrgService {
	port: number;
	url: string;
	client: HostServiceClient;
}

interface HostServiceContextValue {
	/** Map of id -> { port, url, client } for running services */
	services: Map<string, OrgService>;
}

const LOCAL_ID = "local";

const HostServiceContext = createContext<HostServiceContextValue | null>(null);

export function HostServiceProvider({ children }: { children: ReactNode }) {
	// Query the local service port
	const { data: portData } =
		electronTrpc.hostServiceManager.getLocalPort.useQuery();

	// Build the services map
	const services = useMemo(() => {
		const map = new Map<string, OrgService>();
		if (portData?.port) {
			map.set(LOCAL_ID, {
				port: portData.port,
				url: `http://127.0.0.1:${portData.port}`,
				client: getHostServiceClient(portData.port),
			});
		}
		return map;
	}, [portData]);

	const value = useMemo(() => ({ services }), [services]);

	return (
		<HostServiceContext.Provider value={value}>
			{children}
		</HostServiceContext.Provider>
	);
}

export function useHostService(): HostServiceContextValue {
	const context = useContext(HostServiceContext);
	if (!context) {
		throw new Error("useHostService must be used within HostServiceProvider");
	}
	return context;
}
