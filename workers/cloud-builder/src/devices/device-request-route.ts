/**
 * `POST /owners/me/devices/:deviceId/requests`: a paired phone asks one of
 * the owner's computers for something (a file, an office preview, its voice
 * tools), relayed by the owner gate over that computer's presence socket.
 *
 * The user JWT proves the account; the pairing proof proves this phone was
 * paired with this computer and binds the proof to this exact request. The
 * computer then applies its own file-access policy.
 */

import {
  DEVICE_REQUEST_LIMITS,
  buildDeviceRequestChallenge,
  deviceRequestParamsHash,
  isDeviceRequestMethod,
  type DeviceRequestBody,
} from "@stella/contracts/turn-plane/device-requests";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { verifyMobilePairingProof } from "@stella/contracts/turn-plane/pairing-proof";
import {
  HEADER_ANONYMOUS,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
} from "../conversation-types.js";
import { deviceRequestErrorResponse } from "../device-request-relay.js";
import {
  HEADER_DEVICE_REQUEST_ID,
  HEADER_DEVICE_REQUEST_METHOD,
  HEADER_DEVICE_REQUEST_MOBILE_ID,
  HEADER_PRESENCE_DEVICE_ID,
} from "../owner-gate.js";
import type { Env } from "../build-session/shared/env.js";
import { log } from "../build-session/shared/keys.js";
import type { ConversationCaller } from "../build-session/shared/types.js";

export const handleDeviceRequestRoute = async (
  request: Request,
  env: Env,
  deviceId: string,
  caller: ConversationCaller,
): Promise<Response> => {
  if (caller.isAnonymous) {
    return deviceRequestErrorResponse("unauthorized", "Sign in to reach your computer.");
  }
  const text = await request.text();
  if (text.length > DEVICE_REQUEST_LIMITS.paramsBytes + 1024) {
    return deviceRequestErrorResponse("bad_request", "Request body is too large.");
  }
  let body: Partial<DeviceRequestBody>;
  try {
    body = JSON.parse(text) as Partial<DeviceRequestBody>;
  } catch {
    return deviceRequestErrorResponse("bad_request", "Malformed JSON request.");
  }
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const method = body.method;
  const params = body.params;
  if (
    !requestId ||
    requestId.length > DEVICE_REQUEST_LIMITS.requestId ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId) ||
    !isDeviceRequestMethod(method) ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return deviceRequestErrorResponse("bad_request", "Malformed device request.");
  }
  const paramsJson = JSON.stringify(params);
  if (paramsJson.length > DEVICE_REQUEST_LIMITS.paramsBytes) {
    return deviceRequestErrorResponse("bad_request", "Request params are too large.");
  }

  const gate = env.OWNER_GATES.getByName(caller.ownerId);
  let snapshot: OwnerSnapshot;
  try {
    snapshot = await gate.snapshot();
  } catch {
    return deviceRequestErrorResponse("failed", "Stella can't check your pairing right now. Try again shortly.");
  }
  // Only a phone paired with this very computer may ask it for anything.
  const mobileDeviceId = request.headers.get("x-stella-mobile-device-id")?.trim() ?? "";
  const pairing = (snapshot.pairedDevices ?? []).find(
    (candidate) =>
      candidate.mobileDeviceId === mobileDeviceId &&
      candidate.desktopDeviceId === deviceId,
  );
  const verified = await verifyMobilePairingProof({
    headers: request.headers,
    publicKey: pairing?.mobilePublicKey,
    expectedChallenge: buildDeviceRequestChallenge({
      requestId,
      method,
      paramsHash: await deviceRequestParamsHash(paramsJson),
    }),
  });
  if (!verified.ok || verified.desktopDeviceId !== deviceId) {
    log("error", "device_request_proof_rejected", {
      ownerId: caller.ownerId,
      reason: verified.ok ? "device_mismatch" : verified.reason,
    });
    return deviceRequestErrorResponse(
      "forbidden",
      "This phone isn't connected to that computer. Connect it again in Settings.",
    );
  }

  const headers = new Headers({ "content-type": "application/json" });
  headers.set(HEADER_OWNER, caller.ownerId);
  headers.set(HEADER_SUBJECT, caller.subject);
  if (caller.sessionId) headers.set(HEADER_SESSION, caller.sessionId);
  headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  headers.set(HEADER_ANONYMOUS, "0");
  headers.set(HEADER_PRESENCE_DEVICE_ID, deviceId);
  headers.set(HEADER_DEVICE_REQUEST_MOBILE_ID, verified.mobileDeviceId);
  headers.set(HEADER_DEVICE_REQUEST_ID, requestId);
  headers.set(HEADER_DEVICE_REQUEST_METHOD, method);
  return await gate.fetch("https://owner-gate/device-request", {
    method: "POST",
    headers,
    body: paramsJson,
    signal: request.signal,
  });
};
