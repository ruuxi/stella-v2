export const MAX_PUBLISHED_INTEGRATION_ACTIONS = 2_000;

// The actions endpoint returns at most 100 documents per page. Keeping each
// schema below 64 KiB bounds the worst-case Convex query payload below 8 MiB.
export const MAX_INTEGRATION_ACTION_SCHEMA_BYTES = 64 * 1024;

export const MAX_INTEGRATION_ACTIONS_PAGE_SIZE = 100;
export const DEFAULT_INTEGRATION_ACTIONS_PAGE_SIZE = 50;
