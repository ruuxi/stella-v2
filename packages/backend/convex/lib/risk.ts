import { dollarsToMicroCents } from "./billing_money";

export type RiskSignalSnapshot = {
  requests: number;
  chargedMicroCents: number;
  mints: number;
  hostingRequests: number;
  distinctIps: number;
  failedRequests: number;
  sybilFlags: number;
};

export type RiskWeights = {
  requestsPerHour: number;
  chargedPerHour: number;
  mintsPerHour: number;
  hostingShare: number;
  distinctIps24h: number;
  failedShare: number;
  sybilFlag: number;
  sybilFlagCap: number;
};

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  requestsPerHour: 30,
  chargedPerHour: 30,
  mintsPerHour: 20,
  hostingShare: 20,
  distinctIps24h: 20,
  failedShare: 10,
  sybilFlag: 20,
  sybilFlagCap: 40,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseRiskWeights = (raw: string | undefined): RiskWeights => {
  if (!raw?.trim()) return DEFAULT_RISK_WEIGHTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("STELLA_RISK_WEIGHTS_JSON must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("STELLA_RISK_WEIGHTS_JSON must be an object.");
  }
  const weights = { ...DEFAULT_RISK_WEIGHTS };
  for (const key of Object.keys(weights) as Array<keyof RiskWeights>) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`STELLA_RISK_WEIGHTS_JSON.${key} must be non-negative.`);
    }
    weights[key] = value;
  }
  return weights;
};

export const calculateRiskScore = (
  snapshot: RiskSignalSnapshot,
  window: "1h" | "24h",
  weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
): number => {
  const hours = window === "1h" ? 1 : 24;
  const requestsPerHour = snapshot.requests / hours;
  const chargedPerHour = snapshot.chargedMicroCents / hours;
  const mintsPerHour = snapshot.mints / hours;
  const hostingShare =
    snapshot.requests > 0 ? snapshot.hostingRequests / snapshot.requests : 0;
  const failedShare =
    snapshot.requests > 0 ? snapshot.failedRequests / snapshot.requests : 0;
  let score = 0;
  if (requestsPerHour > 200) score += weights.requestsPerHour;
  if (chargedPerHour > dollarsToMicroCents(2)) score += weights.chargedPerHour;
  if (mintsPerHour > 6) score += weights.mintsPerHour;
  if (hostingShare > 0.5) score += weights.hostingShare;
  if (window === "24h" && snapshot.distinctIps > 5) {
    score += weights.distinctIps24h;
  }
  if (failedShare > 0.5) score += weights.failedShare;
  score += Math.min(
    weights.sybilFlagCap,
    snapshot.sybilFlags * weights.sybilFlag,
  );
  return Math.round(score);
};
