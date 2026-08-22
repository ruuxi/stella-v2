export const REFRESH_LEASE_MS = 30_000;

// The complete token exchange, including reading the response body, must end
// before another worker can acquire the refresh lease.
export const REFRESH_TOKEN_REQUEST_TIMEOUT_MS = 20_000;
