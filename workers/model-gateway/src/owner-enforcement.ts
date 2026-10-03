import {
  OWNER_ENFORCEMENT_STATUSES,
  type GatewayOwnerEnforcementRequest,
  type OwnerEnforcementStatus,
} from "@stella/contracts/gateway/usage";
import { GatewayError } from "./errors.js";

export const DEFAULT_ENFORCEMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const KV_MINIMUM_TTL_SECONDS = 60;

export type StoredOwnerEnforcement = {
  status: OwnerEnforcementStatus;
  until?: number;
  updatedAt: number;
  /** Effective expiry for statuses without an explicit `until`. */
  expiresAt?: number;
};

export type OwnerEnforcementAdmission = {
  suspended: boolean;
  throttled: boolean;
};

const isStatus = (value: unknown): value is OwnerEnforcementStatus =>
  typeof value === "string" &&
  (OWNER_ENFORCEMENT_STATUSES as readonly string[]).includes(value);

export const normalizeStoredOwnerEnforcement = (
  value: unknown,
): StoredOwnerEnforcement | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = Reflect.get(value, "status");
  const until = Reflect.get(value, "until");
  const updatedAt = Reflect.get(value, "updatedAt");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (
    !isStatus(status) ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    (until !== undefined &&
      (typeof until !== "number" || !Number.isFinite(until))) ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)))
  )
    return null;
  return {
    status,
    updatedAt,
    ...(typeof until === "number" ? { until } : {}),
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
};

/** The KV mirror stores the record as JSON text. */
export const parseStoredOwnerEnforcement = (
  value: string,
): StoredOwnerEnforcement | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return normalizeStoredOwnerEnforcement(parsed);
};

export const enforcementAdmissionForRecord = (
  stored: StoredOwnerEnforcement | null,
  now: number,
): OwnerEnforcementAdmission => {
  if (!stored || stored.status === "ok")
    return { suspended: false, throttled: false };
  const effectiveUntil =
    stored.until ??
    stored.expiresAt ??
    stored.updatedAt + DEFAULT_ENFORCEMENT_TTL_SECONDS * 1_000;
  if (effectiveUntil <= now) return { suspended: false, throttled: false };
  return {
    suspended: stored.status === "suspended",
    throttled: stored.status === "throttled",
  };
};

const parseRequest = (
  body: Record<string, unknown>,
): GatewayOwnerEnforcementRequest => {
  const ownerId = typeof body.ownerId === "string" ? body.ownerId.trim() : "";
  const updatedAt = body.updatedAt;
  const enforcement = body.enforcement;
  if (
    !ownerId ||
    ownerId.length > 1_024 ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    !enforcement ||
    typeof enforcement !== "object" ||
    Array.isArray(enforcement)
  ) {
    throw new GatewayError(
      400,
      "bad_request",
      "The owner enforcement body is invalid.",
    );
  }
  const status = Reflect.get(enforcement, "status");
  const until = Reflect.get(enforcement, "until");
  const reason = Reflect.get(enforcement, "reason");
  if (
    !isStatus(status) ||
    (until !== undefined &&
      (typeof until !== "number" || !Number.isFinite(until))) ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    throw new GatewayError(
      400,
      "bad_request",
      "The owner enforcement body is invalid.",
    );
  }
  return {
    ownerId,
    enforcement: {
      status,
      ...(typeof until === "number" ? { until } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    },
    updatedAt,
  };
};

export const ownerEnforcementAdmission = async (
  env: Pick<Env, "OWNER_ENFORCEMENT">,
  ownerId: string,
  now: number,
): Promise<OwnerEnforcementAdmission> => {
  const stored = await env.OWNER_ENFORCEMENT.get(ownerId, { cacheTtl: 60 });
  if (!stored) return { suspended: false, throttled: false };
  return enforcementAdmissionForRecord(
    parseStoredOwnerEnforcement(stored),
    now,
  );
};

/**
 * Apply an owner's enforcement pushed by its owner object on cloud-builder
 * (`ModelGatewayControl.applyOwnerEnforcement`): the relay gate orders it by
 * `updatedAt`, KV mirrors it for session mints, and a status change posts
 * `STELLA_ALERT_WEBHOOK_URL` when one is set.
 */
export const applyOwnerEnforcementPush = async (
  env: Env,
  input: unknown,
  receivedAt: number,
): Promise<void> => {
  const body = parseRequest(
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {},
  );
  const until = body.enforcement.until;
  const expiresAt =
    until ?? receivedAt + DEFAULT_ENFORCEMENT_TTL_SECONDS * 1_000;
  const previous = await env.OWNER_ENFORCEMENT.get(body.ownerId);
  const authoritative = await env.OWNER_RELAY_GATE.get(
    env.OWNER_RELAY_GATE.idFromName(body.ownerId),
  ).applyOwnerEnforcement({
    status: body.enforcement.status,
    ...(until !== undefined ? { until } : {}),
    updatedAt: body.updatedAt,
    expiresAt,
  });
  // KV mirrors the owner object for session mints; the owner DO is the
  // ordered authority for owner-relay-v2 requests.
  const expirationTtl =
    authoritative.until === undefined
      ? DEFAULT_ENFORCEMENT_TTL_SECONDS
      : Math.max(
          KV_MINIMUM_TTL_SECONDS,
          Math.ceil((authoritative.until - receivedAt) / 1_000),
        );
  await env.OWNER_ENFORCEMENT.put(
    body.ownerId,
    JSON.stringify(authoritative),
    { expirationTtl },
  );
  const from =
    (previous ? parseStoredOwnerEnforcement(previous)?.status : undefined) ??
    "ok";
  if (from !== authoritative.status) {
    await postAlert(env, [
      "Owner enforcement status changed",
      `ownerId: ${body.ownerId}`,
      `from: ${from}`,
      `to: ${authoritative.status}`,
      ...(body.enforcement.reason ? [`reason: ${body.enforcement.reason}`] : []),
      ...(authoritative.until !== undefined
        ? [`until: ${new Date(authoritative.until).toISOString()}`]
        : []),
    ].join("\n"));
  }
};

/** Best effort: an alert never fails the change that raised it. */
export const postAlert = async (env: object, text: string): Promise<void> => {
  const url = Reflect.get(env, "STELLA_ALERT_WEBHOOK_URL");
  if (typeof url !== "string" || !url.trim()) return;
  try {
    await fetch(url.trim(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn(
      `[model-gateway] alert failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
};
