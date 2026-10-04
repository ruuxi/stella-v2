import type { StreamOptions } from "../types.js";

const statusFromError = (error: unknown, depth = 0): number | null => {
	if (depth > 3 || !error || typeof error !== "object" || Array.isArray(error)) return null;
	const status = Reflect.get(error, "status");
	if (typeof status === "number" && Number.isFinite(status)) return status;
	for (const key of ["response", "error", "cause"]) {
		const value: unknown = Reflect.get(error, key);
		const nested = statusFromError(value, depth + 1);
		if (nested !== null) return nested;
	}
	return null;
};

export const isUnauthorizedProviderError = (error: unknown): boolean => {
	if (statusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : String(error ?? "");
	// `token_expired` / `token_revoked` are ChatGPT OAuth's 401 codes; the
	// Codex transport surfaces them in the message with no HTTP status.
	return /(?:^|\b)401(?:\b|$)|\bunauthorized\b|\btoken_(?:expired|revoked)\b|authentication token is expired/i.test(
		message,
	);
};

/**
 * A subscription usage-limit rejection, as opposed to a rate limit that
 * clears in seconds: ChatGPT's `usage_limit_reached` / `usage_not_included`,
 * or Claude's usage-limit message. Carries the reset time when known.
 */
export const subscriptionLimitOfError = (
	error: unknown,
): { resetsAt?: number } | null => {
	if (!error || typeof error !== "object") return null;
	// Claude subscriptions: a 429 whose unified rate-limit status is
	// "rejected" is the 5-hour or weekly window, not a per-minute limit.
	const headers = Reflect.get(error, "headers");
	const header = (name: string): string | null => {
		if (headers instanceof Headers) return headers.get(name);
		if (headers && typeof headers === "object") {
			const value = Reflect.get(headers, name);
			return typeof value === "string" ? value : null;
		}
		return null;
	};
	if (header("anthropic-ratelimit-unified-status") === "rejected") {
		const seconds = Number(header("anthropic-ratelimit-unified-reset"));
		return Number.isFinite(seconds) && seconds > 0 ? { resetsAt: seconds * 1000 } : {};
	}
	const code = Reflect.get(error, "code");
	const message = error instanceof Error ? error.message : String(error);
	const resetsAt = Reflect.get(error, "resetsAt");
	const known = typeof resetsAt === "number" && Number.isFinite(resetsAt) ? { resetsAt } : {};
	if (typeof code === "string" && /usage_limit_reached|usage_not_included/u.test(code)) {
		return known;
	}
	if (/usage limit|usage_limit_reached/iu.test(message)) return known;
	return null;
};

/**
 * Retry one provider request with a freshly minted short-lived credential,
 * or, after a subscription limit, once with another account's credential.
 * The retry happens before a stream is exposed to callers, so it cannot
 * duplicate model text or tool calls.
 */
export const requestWithAuthRefresh = async <T>(args: {
	apiKey: string;
	refreshApiKey?: StreamOptions["refreshApiKey"];
	onSubscriptionLimit?: StreamOptions["onSubscriptionLimit"];
	request: (apiKey: string) => Promise<T>;
}): Promise<T> => {
	try {
		return await args.request(args.apiKey);
	} catch (error) {
		const limit = args.onSubscriptionLimit ? subscriptionLimitOfError(error) : null;
		if (limit) {
			let next: string | undefined;
			try {
				next = (await args.onSubscriptionLimit!(limit))?.trim() || undefined;
			} catch {
				next = undefined;
			}
			if (!next || next === args.apiKey) throw error;
			return await args.request(next);
		}
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
