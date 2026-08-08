/**
 * Anonymous managed-model trial policy shared by relay enforcement and
 * subscription-status reporting. Keeping the env-backed limits here prevents
 * the public status contract from drifting away from the actual counters.
 */

export const ANON_DEVICE_USAGE_RETENTION_DAYS = 7;
export const ANON_DEVICE_USAGE_RETENTION_MS =
  ANON_DEVICE_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const ANON_IP_CAP_DEFAULT_MULTIPLIER = 10;

let cachedMaxAnonRequests: number | null = null;
let cachedMaxAnonRequestsPerIp: number | null = null;

const requirePositiveIntegerEnv = (name: string): number => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    throw new Error(
      `[stella-provider] Missing required env ${name}. Set it in Convex env before starting.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw new Error(
      `[stella-provider] Invalid env ${name}=${raw}; expected a positive integer.`,
    );
  }
  return parsed;
};

export const getMaxAnonRequests = (): number => {
  if (cachedMaxAnonRequests === null) {
    cachedMaxAnonRequests = requirePositiveIntegerEnv(
      "STELLA_ANON_MAX_REQUESTS",
    );
  }
  return cachedMaxAnonRequests;
};

export const getMaxAnonRequestsPerIp = (): number => {
  if (cachedMaxAnonRequestsPerIp !== null) {
    return cachedMaxAnonRequestsPerIp;
  }
  const raw = process.env.STELLA_ANON_MAX_REQUESTS_PER_IP?.trim();
  cachedMaxAnonRequestsPerIp = raw
    ? requirePositiveIntegerEnv("STELLA_ANON_MAX_REQUESTS_PER_IP")
    : getMaxAnonRequests() * ANON_IP_CAP_DEFAULT_MULTIPLIER;
  return cachedMaxAnonRequestsPerIp;
};
