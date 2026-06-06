import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/_dashboard/reviews")({
	component: ReviewsLayout,
});

function ReviewsLayout() {
	return <Outlet />;
}
