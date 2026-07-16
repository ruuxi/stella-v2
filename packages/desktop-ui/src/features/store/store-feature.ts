/**
 * The desktop Store is intentionally browse-only until cloud artifacts land.
 * It stays out of navigation and rejects direct routes unless explicitly
 * enabled for development or product testing.
 */
export const STORE_BROWSE_ENABLED =
  import.meta.env.VITE_STELLA_STORE_BROWSE_ENABLED === "1";
