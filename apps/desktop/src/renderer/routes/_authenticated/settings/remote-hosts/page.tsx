import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search";
import { RemoteHostsSettings } from "./components/RemoteHostsSettings";

export const Route = createFileRoute("/_authenticated/settings/remote-hosts/")({
	component: RemoteHostsSettingsPage,
});

function RemoteHostsSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "remote-hosts").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <RemoteHostsSettings visibleItems={visibleItems} />;
}
