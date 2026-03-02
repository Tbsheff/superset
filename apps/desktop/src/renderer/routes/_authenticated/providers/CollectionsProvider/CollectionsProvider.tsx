import { createContext, type ReactNode, useContext, useMemo } from "react";
import { MOCK_ORG_ID } from "shared/constants";
import { getCollections } from "./collections";

type CollectionsContextType = ReturnType<typeof getCollections> & {
	switchOrganization: (organizationId: string) => Promise<void>;
};

const CollectionsContext = createContext<CollectionsContextType | null>(null);

export function CollectionsProvider({ children }: { children: ReactNode }) {
	const collections = useMemo(() => getCollections(MOCK_ORG_ID), []);

	const switchOrganization = useMemo(
		() => async (_organizationId: string) => {},
		[],
	);

	return (
		<CollectionsContext.Provider value={{ ...collections, switchOrganization }}>
			{children}
		</CollectionsContext.Provider>
	);
}

export function useCollections(): CollectionsContextType {
	const context = useContext(CollectionsContext);
	if (!context) {
		throw new Error("useCollections must be used within CollectionsProvider");
	}
	return context;
}
