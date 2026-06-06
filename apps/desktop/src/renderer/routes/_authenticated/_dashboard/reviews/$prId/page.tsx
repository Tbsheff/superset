import { createFileRoute } from "@tanstack/react-router";
import { PullRequestDetail } from "../components/PullRequestDetail";

export const Route = createFileRoute(
	"/_authenticated/_dashboard/reviews/$prId/",
)({
	component: ReviewDetailPage,
});

function ReviewDetailPage() {
	const { prId } = Route.useParams();
	return <PullRequestDetail prId={prId} />;
}
