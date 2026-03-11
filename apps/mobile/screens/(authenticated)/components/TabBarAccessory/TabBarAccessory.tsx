import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/hooks/useTheme";
import { useOrganizations } from "@/screens/(authenticated)/hooks/useOrganizations";

export function TabBarAccessory() {
	const theme = useTheme();
	const router = useRouter();
	const { organizationName } = useOrganizations();

	return (
		<View className="flex-row items-center justify-between px-4 py-2">
			<View className="flex-row items-center gap-2">
				<Text
					className="text-sm font-semibold"
					style={{ color: theme.foreground }}
				>
					{organizationName}
				</Text>
			</View>
			<Pressable
				onPress={() => router.push("/(authenticated)/(more)/settings")}
				hitSlop={8}
			>
				<Ionicons
					name="settings-sharp"
					size={20}
					color={theme.mutedForeground}
				/>
			</Pressable>
		</View>
	);
}
