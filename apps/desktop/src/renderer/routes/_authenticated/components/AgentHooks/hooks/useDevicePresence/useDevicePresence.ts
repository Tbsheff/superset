import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { vanillaElectronTrpc } from "renderer/lib/vanilla-electron-trpc";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function useDevicePresence() {
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const { data: deviceInfo } = electronTrpc.auth.getDeviceInfo.useQuery();

	const sendHeartbeat = useCallback(async () => {
		if (!deviceInfo) return;

		try {
			await vanillaElectronTrpc.data.device.heartbeat.mutate({
				deviceId: deviceInfo.deviceId,
				deviceName: deviceInfo.deviceName,
				deviceType: "desktop",
			});
		} catch {
			// Heartbeat can fail when offline - ignore
		}
	}, [deviceInfo]);

	useEffect(() => {
		if (!deviceInfo) return;

		sendHeartbeat();
		intervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [deviceInfo, sendHeartbeat]);

	return {
		deviceInfo,
		isActive: !!deviceInfo,
	};
}
