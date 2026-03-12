import type { ReactNode } from "react";

// Auth removed — single-user local mode. Just render children immediately.
export function AuthProvider({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
