import { createFileRoute } from "@tanstack/react-router";
import { ReviewsView } from "./components/ReviewsView";

export const Route = createFileRoute("/_authenticated/_dashboard/reviews/")({
	component: ReviewsPage,
});

function ReviewsPage() {
	return <ReviewsView />;
}
