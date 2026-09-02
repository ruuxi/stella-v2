import {
  OWNER_ENFORCEMENT_STATUSES,
  type GatewayOwnerEnforcementRequest,
  type OwnerEnforcementStatus,
} from "@stella/contracts/gateway/usage";
import { GatewayError, jsonResponse } from "./errors.js";
import { bearerToken } from "./capability.js";
import { readJsonObject, type GatewayDeps } from "./request-util.js";

const DEFAULT_ENFORCEMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const KV_MINIMUM_TTL_SECONDS = 60;

type StoredOwnerEnforcement = {
  status: OwnerEnforcementStatus;
  until?: number;
  updatedAt: number;
};

export type OwnerEnforcementAdmission = {
  suspended: boolean;
  throttled: boolean;
};

const isStatus = (value: unknown): value is OwnerEnforcementStatus =>
  typeof value === "string" &&
  (OWNER_ENFORCEMENT_STATUSES as readonly string[]).includes(value);

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

const secretsMatch = (presented: string | null, expected: string): boolean => {
  if (!presented) return false;
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export const ownerEnforcementAdmission = async (
  env: Pick<Env, "OWNER_ENFORCEMENT">,
  ownerId: string,
  now: number,
): Promise<OwnerEnforcementAdmission> => {
  const stored = await env.OWNER_ENFORCEMENT.get(ownerId, { cacheTtl: 60 });
  if (!stored) return { suspended: false, throttled: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { suspended: false, throttled: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { suspended: false, throttled: false };
  }
  const status = Reflect.get(parsed, "status");
  const until = Reflect.get(parsed, "until");
  if (!isStatus(status)) return { suspended: false, throttled: false };
  if (typeof until === "number" && Number.isFinite(until) && until <= now) {
    return { suspended: false, throttled: false };
  }
  return {
    suspended: status === "suspended",
    throttled: status === "throttled",
  };
};

export const handleOwnerEnforcement = async (args: {
  request: Request;
  env: Env;
  deps: GatewayDeps;
  traceId: string;
}): Promise<Response> => {
  if (
    !secretsMatch(bearerToken(args.request), args.env.GATEWAY_SERVICE_SECRET)
  ) {
    throw new GatewayError(
      401,
      "unauthorized",
      "The gateway service bearer is invalid.",
    );
  }
  const body = parseRequest(await readJsonObject(args.request));
  if (body.enforcement.status === "ok") {
    await args.env.OWNER_ENFORCEMENT.delete(body.ownerId);
  } else {
    const until = body.enforcement.until;
    const expirationTtl =
      until === undefined
        ? DEFAULT_ENFORCEMENT_TTL_SECONDS
        : Math.max(
            KV_MINIMUM_TTL_SECONDS,
            Math.ceil((until - args.deps.now()) / 1_000),
          );
    const stored: StoredOwnerEnforcement = {
      status: body.enforcement.status,
      ...(until !== undefined ? { until } : {}),
      updatedAt: body.updatedAt,
    };
    await args.env.OWNER_ENFORCEMENT.put(body.ownerId, JSON.stringify(stored), {
      expirationTtl,
    });
  }
  return jsonResponse(200, { ok: true }, args.traceId);
};
