// Auth removed — single-user local mode. Billing stubs.

export async function getOrganizationOwners(_organizationId: string) {
	return [];
}

export function formatPrice(amountInCents: number, currency: string): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(amountInCents / 100);
}
