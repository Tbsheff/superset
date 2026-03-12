interface VersionRequirements {
	minimumVersion: string;
	message?: string;
}

interface UseVersionCheckResult {
	isLoading: boolean;
	isBlocked: boolean;
	requirements: VersionRequirements | null;
	error: Error | null;
}

export function useVersionCheck(): UseVersionCheckResult {
	return {
		isLoading: false,
		isBlocked: false,
		requirements: null,
		error: null,
	};
}
