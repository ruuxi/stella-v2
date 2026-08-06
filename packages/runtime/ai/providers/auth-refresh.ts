import type { StreamOptions } from "../types.js";

const statusFromError = (error: unknown, depth = 0): number | null => {
	if (depth > 3 || !error || typeof error !== "object") return null;
	const record = error as Record<string, unknown>;
	if (typeof record.status === "number") return record.status;
	for (const key of ["response", "error", "cause"]) {
		const nested = statusFromError(record[key], depth + 1);
		if (nested !== null) return nested;
	}
	return null;
};

export const isUnauthorizedProviderError = (error: unknown): boolean => {
	if (statusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /(?:^|\b)401(?:\b|$)|\bunauthorized\b/i.test(message);
};

/**
 * Retry one provider request with a freshly minted short-lived credential.
 * The retry happens before a stream is exposed to callers, so it cannot
 * duplicate model text or tool calls.
 */
export const requestWithAuthRefresh = async <T>(args: {
	apiKey: string;
	refreshApiKey?: StreamOptions["refreshApiKey"];
	request: (apiKey: string) => Promise<T>;
}): Promise<T> => {
	try {
		return await args.request(args.apiKey);
	} catch (error) {
		if (!args.refreshApiKey || !isUnauthorizedProviderError(error)) {
			throw error;
		}

		let refreshed: string | undefined;
		try {
			refreshed = (await args.refreshApiKey())?.trim() || undefined;
		} catch {
			refreshed = undefined;
		}
		if (!refreshed) throw error;
		return await args.request(refreshed);
	}
};
