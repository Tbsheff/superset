import { useRouter } from "expo-router";
import {
	ChevronRight,
	LogOut,
	Settings,
} from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useSignOut } from "@/hooks/useSignOut";

export function MoreMenuScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { signOut } = useSignOut();

	return (
		<ScrollView
			className="flex-1 bg-background"
			contentContainerStyle={{ paddingTop: insets.top + 16 }}
		>
			<View className="px-4 gap-6">
				{/* Account section */}
				<View className="gap-2">
					<Text className="text-xs font-medium text-muted-foreground uppercase px-2">
						Account
					</Text>
					<View className="rounded-xl bg-card">
						<View className="flex-row items-center gap-3 px-4 py-3">
							<Avatar alt="Superset" className="size-9">
								<AvatarFallback>
									<Text className="text-sm font-semibold">S</Text>
								</AvatarFallback>
							</Avatar>
							<Text
								className="text-base font-semibold flex-1"
								numberOfLines={1}
							>
								Superset
							</Text>
						</View>
					</View>
				</View>

				{/* Menu items */}
				<View className="gap-2">
					<Text className="text-xs font-medium text-muted-foreground uppercase px-2">
						General
					</Text>
					<View className="rounded-xl bg-card">
						<Pressable
							onPress={() => router.push("/(authenticated)/(more)/settings")}
							className="flex-row items-center gap-3 px-4 py-3"
						>
							<Icon as={Settings} className="text-foreground size-5" />
							<Text className="text-base flex-1">Settings</Text>
							<Icon
								as={ChevronRight}
								className="text-muted-foreground size-5"
							/>
						</Pressable>
					</View>
				</View>

				{/* Sign out */}
				<View className="gap-2">
					<View className="rounded-xl bg-card">
						<Pressable
							onPress={signOut}
							className="flex-row items-center gap-3 px-4 py-3"
						>
							<Icon as={LogOut} className="text-destructive size-5" />
							<Text className="text-base text-destructive">Log out</Text>
						</Pressable>
					</View>
				</View>
			</View>
		</ScrollView>
	);
}
