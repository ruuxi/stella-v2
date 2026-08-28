import type {
  DeviceGrantConsumeResponse,
  DeviceGrantStatusResponse,
} from "./protocol.js";

export type AuthorizationState = Readonly<{
  schemaVersion: 1;
  userCode: string;
  deviceCodeDigest: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  /** Present only after a successful consume; safe to persist (not a secret). */
  consumedBy?: string;
  createdAt: number;
  expiresAt: number;
  cleanupAt?: number;
}>;

export type PublicDecisionOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "already_finalized";

const sameDigest = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const expireAuthorization = (
  state: AuthorizationState,
  now: number,
): AuthorizationState => {
  // A consumed grant stays replayable only to its bound consumer during the
  // short cleanup grace. The alarm deletes it at cleanupAt; it must not first
  // erase the consumer binding at the nominal authorization deadline.
  if (
    now < state.expiresAt ||
    state.status === "expired" ||
    state.status === "consumed"
  ) {
    return state;
  }
  return {
    ...state,
    status: "expired",
    cleanupAt: state.expiresAt + 5 * 60_000,
  };
};

export const applyPublicDecision = (
  current: AuthorizationState,
  decision: "approve" | "deny",
  now: number,
): Readonly<{ state: AuthorizationState; outcome: PublicDecisionOutcome }> => {
  const state = expireAuthorization(current, now);
  if (state.status === "expired") return { state, outcome: "expired" };
  if (state.status !== "pending") {
    return { state, outcome: "already_finalized" };
  }
  return {
    state: {
      ...state,
      status: decision === "approve" ? "approved" : "denied",
    },
    outcome: decision === "approve" ? "approved" : "denied",
  };
};

const verifiedState = (
  current: AuthorizationState | undefined,
  suppliedDigest: string,
  now: number,
): AuthorizationState | undefined => {
  if (
    current === undefined ||
    !sameDigest(current.deviceCodeDigest, suppliedDigest)
  ) {
    return undefined;
  }
  return expireAuthorization(current, now);
};

export const readGrantStatus = (
  current: AuthorizationState | undefined,
  suppliedDigest: string,
  now: number,
): Readonly<{
  state?: AuthorizationState;
  response: DeviceGrantStatusResponse;
}> => {
  const state = verifiedState(current, suppliedDigest, now);
  if (state === undefined) {
    return { response: { schemaVersion: 1, status: "invalid_grant" } };
  }
  const status =
    state.status === "pending"
      ? "authorization_pending"
      : state.status === "approved"
        ? "approved"
        : state.status === "denied"
          ? "access_denied"
          : state.status === "expired"
            ? "expired_token"
            : "already_consumed";
  return { state, response: { schemaVersion: 1, status } };
};

export const consumeGrant = (
  current: AuthorizationState | undefined,
  suppliedDigest: string,
  now: number,
  consumerId: string,
): Readonly<{
  state?: AuthorizationState;
  response: DeviceGrantConsumeResponse;
}> => {
  const status = readGrantStatus(current, suppliedDigest, now);
  if (status.state?.status === "approved") {
    return {
      state: {
        ...status.state,
        status: "consumed",
        consumedBy: consumerId,
        cleanupAt: status.state.expiresAt + 5 * 60_000,
      },
      response: { schemaVersion: 1, outcome: "approved" },
    };
  }
  if (
    status.state?.status === "consumed" &&
    status.state.consumedBy === consumerId
  ) {
    return {
      state: status.state,
      response: { schemaVersion: 1, outcome: "approved" },
    };
  }
  return {
    ...(status.state ? { state: status.state } : {}),
    response: { schemaVersion: 1, outcome: status.response.status },
  };
};
