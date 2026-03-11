import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useOrganizations } from "@/screens/(authenticated)/hooks/useOrganizations";
import { OrganizationHeaderButton } from "./components/OrganizationHeaderButton";

export function WorkspacesScreen() {
	const [refreshing, setRefreshing] = useState(false);
	const { organizationName } = useOrganizations();

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		setRefreshing(false);
	}, []);

	return (
		<>
			<OrganizationHeaderButton
				name={organizationName}
			/>
			<ScrollView
				className="flex-1 bg-background"
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				}
			>
				<View className="p-6">
					<View className="items-center justify-center py-20">
						<Text className="text-center text-muted-foreground">
							Workspaces grouped by project will appear here
						</Text>
					</View>
				</View>
			</ScrollView>
		</>
	);
}
