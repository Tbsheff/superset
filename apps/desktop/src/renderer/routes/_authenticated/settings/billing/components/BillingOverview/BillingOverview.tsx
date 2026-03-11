import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { HiArrowRight } from "react-icons/hi2";
import { authClient } from "renderer/lib/auth-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import type { PlanTier } from "../../constants";
import { CurrentPlanCard } from "./components/CurrentPlanCard";
import { RecentInvoices } from "./components/RecentInvoices";
import { UpgradeCard } from "./components/UpgradeCard";

interface BillingOverviewProps {
	visibleItems?: SettingItemId[] | null;
}

export function BillingOverview({ visibleItems }: BillingOverviewProps) {
	const { data: session } = authClient.useSession();
	const collections = useCollections();
	const [isUpgrading, _setIsUpgrading] = useState(false);
	const [isCanceling, _setIsCanceling] = useState(false);
	const [isRestoring, _setIsRestoring] = useState(false);

	const _activeOrgId = session?.session?.activeOrganizationId;

	// Get subscription from Electric (preloaded, instant)
	const { data: subscriptionsData } = useLiveQuery(
		(q) => q.from({ subscriptions: collections.subscriptions }),
		[collections],
	);
	const subscriptionData = subscriptionsData?.find(
		(s) => s.status === "active",
	);

	// Derive plan from subscription data (not session, which can be stale)
	const plan: PlanTier = (subscriptionData?.plan as PlanTier) ?? "free";

	// Get member count from Electric
	const { data: membersData } = useLiveQuery(
		(q) =>
			q
				.from({ members: collections.members })
				.select(({ members }) => ({ id: members.id })),
		[collections],
	);
	const memberCount = membersData ? membersData.length : undefined;

	const showOverview = isItemVisible(
		SETTING_ITEM_ID.BILLING_OVERVIEW,
		visibleItems,
	);

	// All features are free — subscription actions are no-ops
	const handleUpgrade = async (_annual = false) => {
		toast.success("All features are free — no action needed");
	};

	const handleCancel = async () => {
		toast.success("All features are free — no action needed");
	};

	const handleRestore = async () => {
		toast.success("All features are free — no action needed");
	};

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-6">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-semibold">Billing</h2>
						<p className="text-xs text-muted-foreground mt-0.5">
							For questions about billing,{" "}
							<a
								href="mailto:founders@superset.sh"
								className="text-primary hover:underline"
							>
								contact us
							</a>
						</p>
					</div>
					<Button variant="ghost" size="sm" asChild>
						<Link to="/settings/billing/plans">
							All plans
							<HiArrowRight className="h-3 w-3" />
						</Link>
					</Button>
				</div>
			</div>

			<div className="space-y-3">
				{showOverview && (
					<>
						<CurrentPlanCard
							currentPlan={plan}
							onCancel={handleCancel}
							isCanceling={isCanceling}
							onRestore={handleRestore}
							isRestoring={isRestoring}
							cancelAt={subscriptionData?.cancelAt}
							periodEnd={subscriptionData?.periodEnd}
						/>
						{plan === "free" && (
							<UpgradeCard
								onUpgrade={() => handleUpgrade(false)}
								isUpgrading={isUpgrading || memberCount === undefined}
							/>
						)}
					</>
				)}
				<RecentInvoices />
			</div>
		</div>
	);
}
