import { Stack } from "expo-router";
import { View } from "react-native";
import { Text } from "@/components/ui/text";

export function OrganizationHeaderButton({
	name,
}: {
	name?: string;
}) {
	return (
		<>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.View hidesSharedBackground>
					<View className="flex-row items-center gap-2">
						<Text className="text-xl font-semibold text-foreground">
							{name ?? "Superset"}
						</Text>
					</View>
				</Stack.Toolbar.View>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => {}} />
			</Stack.Toolbar>
		</>
	);
}
