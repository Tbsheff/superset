const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
	{ amount: 60, unit: "second" },
	{ amount: 60, unit: "minute" },
	{ amount: 24, unit: "hour" },
	{ amount: 7, unit: "day" },
	{ amount: 4.34524, unit: "week" },
	{ amount: 12, unit: "month" },
	{ amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(value: Date | string | number): string {
	const date = value instanceof Date ? value : new Date(value);
	let duration = (date.getTime() - Date.now()) / 1000;

	for (const division of DIVISIONS) {
		if (Math.abs(duration) < division.amount) {
			return formatter.format(Math.round(duration), division.unit);
		}
		duration /= division.amount;
	}
	return "";
}
