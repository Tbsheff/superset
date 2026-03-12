import { useRouter } from "expo-router";
import { ChevronDown, LogOut, Settings } from "lucide-react-native";
import { View } from "react-native";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useSignOut } from "@/hooks/useSignOut";

export function OrgDropdown() {
	const router = useRouter();
	const { signOut } = useSignOut();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<View className="flex-row items-center gap-3 px-4 py-3">
					<Avatar alt="Superset" className="size-9">
						<AvatarFallback>
							<Text className="text-sm font-semibold">S</Text>
						</AvatarFallback>
					</Avatar>
					<View className="flex-1">
						<Text className="text-base font-semibold" numberOfLines={1}>
							Superset
						</Text>
					</View>
					<Icon as={ChevronDown} className="text-muted-foreground size-4" />
				</View>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56" align="start" side="bottom">
				<DropdownMenuItem
					onPress={() => router.push("/(authenticated)/settings")}
				>
					<Icon as={Settings} className="text-foreground size-4" />
					<Text>Settings</Text>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onPress={signOut}>
					<Icon as={LogOut} className="text-destructive size-4" />
					<Text>Log out</Text>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
