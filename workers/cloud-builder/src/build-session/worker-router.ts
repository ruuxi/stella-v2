/**
 * The Worker's request router: every HTTP entry point the cloud builder
 * exposes, plus the route helpers only it uses.
 *
 * The Durable Object classes it addresses are bindings on `Env`, so this
 * module never imports `../index.js` — it depends only on `shared/*`, its
 * sibling build-session modules, and the plain `src/*` collaborators.
 *
 * @see src/index.ts for `export default worker`.
 */

import { GATEWAY_NETWORK_POLICY } from "@stella/contracts/gateway/api";
import { TURN_BROKER_HEADERS } from "@stella/contracts/turn-credential-broker";
import { BUILDER_OWNER_SNAPSHOT_CHANGED_PATH } from "@stella/contracts/turn-plane/owner-snapshot";
import { MEMORY_POLICY_CHANGE_PATH, parseMemoryPolicyChange } from "@stella/contracts/turn-plane/memory-policy";
import { MemoryPolicyError } from "../memory-policy.js";
import { withBrowserCors } from "../browser-cors.js";
import type {
  OwnerSnapshot,
  OwnerSnapshotChangedRequest,
} from "@stella/contracts/turn-plane/owner-snapshot";
import {
  buildMobilePairingChallenge,
  canonicalDispatchPayloadJson,
  hasMobilePairingProofHeaders,
  readMobilePairingProofHeaders,
  sha256Hex as pairingSha256Hex,
  verifyMobilePairingProof,
} from "@stella/contracts/turn-plane/pairing-proof";
import {
  DEVICES_PATH,
  DISPATCH_SUBMIT_PATH,
  PLACEMENT_PROTOCOL,
} from "@stella/contracts/turn-plane/placement";
import type { DispatchSubmitRequest } from "@stella/contracts/turn-plane/placement";
import {
  CONVERSATION_ID_PATTERN,
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
} from "@stella/contracts/turn-plane/turn-start";
import {
  isOwnerAppBuildPrefix,
  ownerAppBuildPrefix,
} from "../app-build-artifacts.js";
import { verifyConvexToken } from "../auth-jwt.js";
import {
  BoundedBodyError,
  readBoundedRequestText,
  readBoundedResponseBytes,
} from "../bounded-body.js";
import { handleUserCloudHomeRoute } from "../cloud-home-routes.js";
import { parseConversationEditRequest } from "../conversation-edit-protocol.js";
import {
  conversationEditErrorResponse,
  runConversationEdit,
} from "../conversation-edit-runner.js";
import {
  HEADER_ISSUER,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  isWebSocketUpgrade,
  refuseUpgrade,
  stripStellaHeaders,
  SUBPROTOCOL,
  tokenFromSubprotocol,
} from "../conversation-hub.js";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_INTERNAL,
  CLOSE_UNAUTHENTICATED,
} from "../conversation-types.js";
import { devAcceptanceProbesEnabled } from "../dev-acceptance-probes.js";
import {
  dispatchErrorResponse,
  parseDispatchSubmitRequest,
} from "../dispatch-policy.js";
import { sha256Hex } from "../hash.js";
import {
  MEMORY_WIPE_PROTOCOL_VERSION,
  MEMORY_WIPE_TARGET_COUNT,
  sweepMemoryWipePage,
} from "../memory-wipe.js";
import { handleMuseTranscribeSocket } from "../muse-transcribe-socket.js";
import { classifyNetwork } from "../../../shared/network-class.js";
import { deliverOutboxBatch, isOutboxEvent } from "../outbox.js";
import type { OwnerPurgeFence, OwnerPurgeMode } from "../owner-fence-do.js";
import {
  HEADER_PRESENCE_DEVICE_ID,
  OwnerGate,
  parseOwnerSnapshot,
} from "../owner-gate.js";
import { normalizeOwnerGeneration } from "../owner-generation.js";
import { parseOwnerProductTransferRequest } from "../owner-product-transfer.js";
import {
  createCoordinatorAttempt,
  OWNER_TRANSFER_OPERATION_ID_PATTERN,
  parseOwnerTransferControl,
  stableValueMarker,
} from "../owner-transfer-coordinator.js";
import { parseOwnerTransferRequest } from "../owner-transfer.js";
import { evaluateCloudBuilderReadiness } from "../readiness.js";
import {
  boundedBodyStatus,
  CLOUD_BUILDER_BODY_LIMITS,
  publicJsonBodyLimit,
  serviceJsonBodyLimit,
} from "../request-ingress.js";
import { verifyServiceBearerRequest } from "../service-bearer.js";
import { validateTurnBrokerTarget } from "../turn-credential-broker.js";
import {
  HEADER_TURN_AUTH_KIND,
  parseCloudAgentTurnStartRequest,
  parseCloudTurnStartRequest,
  serviceOnlyTurnFields,
  turnStartErrorResponse,
} from "../turn-start-request.js";
import type { TurnAuthKind } from "../turn-start-request.js";
import {
  previewSafeRequestLogPath,
  verifyPreviewAccessRouteCapability,
} from "../vite-preview-access.js";
import {
  abortTransferCoordinator,
  APP_SLUG_PATTERN,
  beginOwnerPurge,
  boundedIngressRequest,
  callOwnerFence,
  callTransferCoordinator,
  cloudHomeLeaseRunner,
  createTransferCoordinatorContext,
  handleWorldRoute,
  LEGACY_BUILD_PREFIX_PATTERN,
  parseTransferReservationEnvelope,
  purgeOwnerStorage,
  transferControl,
  transferOwnerProductStorage,
  withOwnerActivityLease,
  yieldTransferCoordinator,
} from "./owner-purge-transfer.js";
import { retireSandboxInstance } from "./session-sandbox.js";
import type { Env } from "./shared/env.js";
import {
  OwnerProductTransferConfigurationError,
  OwnerProductTransferConflictError,
  OwnerPurgeFenceError,
} from "./shared/errors.js";
import {
  conversationName,
  errorMessage,
  HEADER_BUILD_SESSION_NAME,
  HEADER_CONVERSATION_ID,
  HEADER_PREVIEW_BASE_URL,
  HEADER_PREVIEW_CAPABILITY,
  HEADER_TURN_BROKER_ENDPOINT,
  json,
  log,
  ORCHESTRATOR_INTERNAL_ORIGIN,
  sweepR2Prefix,
} from "./shared/keys.js";
import type {
  ConversationCaller,
  DispatchCaller,
  OwnerPurgeReport,
  OwnerPurgeRequest,
} from "./shared/types.js";
import { convexSiteBase } from "../convex-site.js";

// ---------------------------------------------------------------------------
// The user-authenticated conversation surfaces
//
// Every other route on this worker is server-to-server and gated by the shared
// service secret. These two are the exception: they carry a signed-in user's
// Convex JWT, which is NOT the service secret, so they are matched before that
// gate. Verification happens here rather than in the Durable Object so an
// unauthenticated connect never instantiates one, never takes a socket slot,
// and never touches the agent's thread.
// ---------------------------------------------------------------------------

/**
 * Verify the caller. `wantsSocket` decides only how a refusal is shaped: a
 * WebSocket client that gets an HTTP 4xx before the 101 sees close code 1006
 * and cannot tell "refresh your token" from "the network dropped" — opposite
 * responses — so refusals there complete the handshake and close with a real
 * code instead.
 */
const authenticateConversationCaller = async (
  request: Request,
  env: Env,
  wantsSocket: boolean,
  requestId: string,
): Promise<
  { ok: true; caller: ConversationCaller } | { ok: false; response: Response }
> => {
  const issuer = convexSiteBase(env);
  const deny = (
    closeCode: number,
    status: number,
    message: string,
    retryable: boolean,
  ): { ok: false; response: Response } => ({
    ok: false,
    response: wantsSocket
      ? refuseUpgrade(request, closeCode, message, {
          retryable,
          ref: requestId,
        })
      : json({ error: message, retryable, ref: requestId }, status),
  });

  if (!issuer) {
    // Fail closed and loudly. The alternative — treating a missing issuer as
    // "skip verification" — is how an auth check becomes optional in practice.
    log("error", "conversation_auth_unconfigured", { requestId });
    return deny(
      CLOSE_INTERNAL,
      503,
      "Stella can't open live conversations right now. Try again shortly.",
      true,
    );
  }

  let token = "";
  if (wantsSocket) {
    // The JWT rides in Sec-WebSocket-Protocol, never the query string:
    // browsers and React Native cannot set WebSocket request headers, and a
    // URL is the one part of a request that gets logged everywhere.
    const offer = tokenFromSubprotocol(request);
    if (!offer.offered) {
      return deny(CLOSE_BAD_REQUEST, 400, "Unsupported client.", false);
    }
    token = offer.token;
  } else {
    const header = request.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ")) token = header.slice(7).trim();
  }
  if (!token) {
    return deny(
      CLOSE_UNAUTHENTICATED,
      401,
      "Sign in to open this conversation.",
      false,
    );
  }

  const verified = await verifyConvexToken(token, issuer);
  if (!verified.ok) {
    // The reason is a log-only discriminator; the caller is told one thing.
    log("error", "conversation_auth_rejected", {
      requestId,
      reason: verified.reason,
    });
    return verified.retryable
      ? deny(
          CLOSE_INTERNAL,
          503,
          "Stella couldn't check your sign-in. Try again shortly.",
          true,
        )
      : deny(
          CLOSE_UNAUTHENTICATED,
          401,
          "Your sign-in expired. Sign in again to continue.",
          false,
        );
  }
  return { ok: true, caller: { ...verified.token, issuer } };
};

const refusesAnonymousNetwork = async (
  request: Request,
  env: Env,
): Promise<boolean> => {
  const networkClass = await classifyNetwork(request, env.ASN_POLICY);
  return GATEWAY_NETWORK_POLICY.anonymousRefused.some(
    (refused) => refused === networkClass,
  );
};

const forwardToConversation = async (
  request: Request,
  env: Env,
  conversationId: string,
  doPath: string,
  caller: ConversationCaller,
): Promise<Response> => {
  const source = new URL(request.url);
  const target = new URL(ORCHESTRATOR_INTERNAL_ORIGIN);
  target.pathname = doPath;
  target.search = source.search;
  const forwarded = new Request(target.toString(), request);
  // A client must never be able to assert its own identity to the DO. This
  // strip is one line and its absence is a full account-takeover, so it comes
  // before every header we then set.
  stripStellaHeaders(forwarded.headers);
  forwarded.headers.set(HEADER_OWNER, caller.ownerId);
  forwarded.headers.set(HEADER_SUBJECT, caller.subject);
  if (caller.sessionId) forwarded.headers.set(HEADER_SESSION, caller.sessionId);
  forwarded.headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  forwarded.headers.set(HEADER_ISSUER, caller.issuer);
  forwarded.headers.set(HEADER_CONVERSATION_ID, conversationId);
  forwarded.headers.delete("authorization");
  try {
    // The token has done its job. Keep the offer so the DO can echo a valid
    // subprotocol, but drop the bearer half so it cannot reach a log line.
    if (forwarded.headers.has("sec-websocket-protocol")) {
      forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
    }
  } catch {
    // Some runtimes guard Sec-* headers. Losing the scrub is acceptable —
    // the DO is inside the same trust boundary — but it is never fatal.
  }
  return await env.ORCHESTRATOR_SESSIONS.getByName(conversationId).fetch(
    forwarded,
  );
};

/**
 * `POST /conversations/:id/turns`: the one route both a signed-in user's JWT
 * and the service secret open. The Worker verifies the caller and does the
 * cheap refusals (shape, service-only fields); every admission decision is
 * the conversation Durable Object's. Identity reaches it on trusted headers
 * — never from the body, which cannot name an owner at all.
 */
const handleTurnStartRoute = async (
  request: Request,
  env: Env,
  segment: string,
  requestId: string,
): Promise<Response> => {
  const conversationId = conversationName(segment);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    return turnStartErrorResponse(
      "bad_request",
      "conversationId must be 8-128 URL-safe characters.",
      false,
    );
  }
  let ownerId: string;
  let authKind: TurnAuthKind;
  let ownerGeneration: string | null = null;
  let tokenExpiresAtMs: number | null = null;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    // Convex-originated: a schedule fire, placement's cloud branch, an
    // agent-completion wake. It names the owner it acts for and pins the
    // generation it read; the gate refuses a stale one.
    const headerOwner = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    ownerGeneration = normalizeOwnerGeneration(
      request.headers.get(TURN_OWNER_GENERATION_HEADER),
    );
    if (!headerOwner || headerOwner.length > 512 || !ownerGeneration) {
      return turnStartErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER} and ${TURN_OWNER_GENERATION_HEADER}.`,
        false,
      );
    }
    ownerId = headerOwner;
    authKind = "service";
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      // Re-shaped to the turn-start contract; the socket-oriented refusal
      // already logged the discriminator.
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? turnStartErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : turnStartErrorResponse(
            "unauthorized",
            "Sign in to send messages.",
            false,
          );
    }
    if (
      auth.caller.isAnonymous &&
      (await refusesAnonymousNetwork(request, env))
    ) {
      return turnStartErrorResponse(
        "sign_in_required",
        "Sign in to Stella to continue from this network.",
        false,
      );
    }
    ownerId = auth.caller.ownerId;
    tokenExpiresAtMs = auth.caller.expiresAtMs;
    authKind = "user";
  }
  let text: string;
  try {
    text = await readBoundedRequestText(
      request,
      CLOUD_BUILDER_BODY_LIMITS.turn,
      { requireBody: true },
    );
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return turnStartErrorResponse(
      "bad_request",
      status === 413 ? "Request body is too large." : "Malformed request body.",
      false,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return turnStartErrorResponse(
      "bad_request",
      "Malformed JSON request.",
      false,
    );
  }
  const parsed = parseCloudTurnStartRequest(body);
  if (!parsed.ok) {
    return turnStartErrorResponse("bad_request", parsed.message, false);
  }
  if (authKind === "user") {
    const restricted = serviceOnlyTurnFields(parsed.request);
    if (restricted.length > 0) {
      return turnStartErrorResponse(
        "forbidden",
        `${restricted.join(", ")} require service authentication.`,
        false,
      );
    }
  }
  // Built from scratch rather than cloned: nothing of the caller's headers
  // may reach the DO, and the trusted identity is exactly these four.
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(HEADER_OWNER, ownerId);
  headers.set(HEADER_TURN_AUTH_KIND, authKind);
  headers.set(HEADER_CONVERSATION_ID, conversationId);
  if (ownerGeneration)
    headers.set(TURN_OWNER_GENERATION_HEADER, ownerGeneration);
  if (tokenExpiresAtMs !== null) {
    headers.set(HEADER_TOKEN_EXP, String(tokenExpiresAtMs));
  }
  const response = await env.ORCHESTRATOR_SESSIONS.getByName(
    conversationId,
  ).fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`, {
    method: "POST",
    headers,
    body: text,
  });
  log("info", "conversation_turn_start", {
    requestId,
    authKind,
    lane: parsed.request.lane ?? "chat",
    status: response.status,
  });
  return response;
};

/**
 * `GET /owners/me/devices/:deviceId/presence`. The device's socket lands on
 * its owner's gate, which is where presence, offers, and claims all live —
 * the JWT proves the account, the Ed25519 proof inside the socket proves the
 * device.
 */
const forwardToDevicePresence = async (
  request: Request,
  env: Env,
  deviceId: string,
  caller: ConversationCaller,
): Promise<Response> => {
  const forwarded = new Request("https://owner-gate/presence", request);
  stripStellaHeaders(forwarded.headers);
  forwarded.headers.set(HEADER_OWNER, caller.ownerId);
  forwarded.headers.set(HEADER_TOKEN_EXP, String(caller.expiresAtMs));
  forwarded.headers.set(HEADER_PRESENCE_DEVICE_ID, deviceId);
  forwarded.headers.delete("authorization");
  try {
    forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
  } catch {
    // Some runtimes guard Sec-* headers. The DO is in the same trust boundary.
  }
  return await env.OWNER_GATES.getByName(caller.ownerId).fetch(forwarded);
};

const handleDispatchSubmitRoute = async (
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> => {
  const receivedAt = Date.now();
  const startedAt = performance.now();
  let caller: DispatchCaller;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    const ownerId = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    const ownerGeneration = normalizeOwnerGeneration(
      request.headers.get(TURN_OWNER_GENERATION_HEADER),
    );
    if (!ownerId || ownerId.length > 512 || !ownerGeneration) {
      return dispatchErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER} and ${TURN_OWNER_GENERATION_HEADER}.`,
        false,
      );
    }
    caller = { kind: "service", ownerId, ownerGeneration };
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? dispatchErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : dispatchErrorResponse(
            "unauthorized",
            "Sign in to run this somewhere.",
            false,
          );
    }
    caller = {
      kind: "user",
      ownerId: auth.caller.ownerId,
      isAnonymous: auth.caller.isAnonymous,
    };
  }
  if (
    caller.kind !== "service" &&
    caller.isAnonymous &&
    (await refusesAnonymousNetwork(request, env))
  ) {
    return dispatchErrorResponse(
      "sign_in_required",
      "Sign in to Stella to continue from this network.",
      false,
    );
  }
  const authMs = Math.round(performance.now() - startedAt);
  let text: string;
  try {
    text = await readBoundedRequestText(
      request,
      CLOUD_BUILDER_BODY_LIMITS.turn,
      { requireBody: true },
    );
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return dispatchErrorResponse(
      "bad_request",
      status === 413 ? "Request body is too large." : "Malformed request body.",
      false,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return dispatchErrorResponse(
      "bad_request",
      "Malformed JSON request.",
      false,
    );
  }
  const parsed = parseDispatchSubmitRequest(body);
  if (!parsed.ok) {
    return dispatchErrorResponse("bad_request", parsed.message, false);
  }
  if (
    caller.kind !== "service" &&
    caller.isAnonymous &&
    parsed.request.kind === "agent"
  ) {
    return dispatchErrorResponse(
      "sign_in_required",
      "Sign in to Stella to use cloud agents.",
      false,
    );
  }
  let submitted: DispatchSubmitRequest = parsed.request;
  const gate = env.OWNER_GATES.getByName(caller.ownerId);

  if (caller.kind === "user" && hasMobilePairingProofHeaders(request.headers)) {
    // A phone has no device key the cloud can verify; the pairing key in the
    // owner snapshot is what stands in for one. The challenge is rebuilt from
    // the request the worker is about to act on, so a proof minted for other
    // bytes cannot authorize these.
    const fields = readMobilePairingProofHeaders(request.headers);
    if (!fields) {
      return dispatchErrorResponse(
        "forbidden",
        "This phone credential is incomplete.",
        false,
      );
    }
    let snapshot: OwnerSnapshot;
    try {
      snapshot = await gate.snapshot();
    } catch {
      return dispatchErrorResponse(
        "internal",
        "Stella can't check your pairing right now. Try again shortly.",
        true,
      );
    }
    const pairing = (snapshot.pairedDevices ?? []).find(
      (candidate) =>
        candidate.mobileDeviceId === fields.mobileDeviceId &&
        candidate.desktopDeviceId === fields.desktopDeviceId,
    );
    const payloadHash = await pairingSha256Hex(
      canonicalDispatchPayloadJson(submitted.payload),
    );
    const verified = await verifyMobilePairingProof({
      fields,
      publicKey: pairing?.mobilePublicKey,
      expectedChallenge: buildMobilePairingChallenge({
        idempotencyKey: submitted.idempotencyKey,
        conversationId: submitted.conversationId,
        payloadHash,
        kind: submitted.kind,
        subject: submitted.subject,
        ...(submitted.targetMode !== undefined
          ? { targetMode: submitted.targetMode }
          : {}),
        ...(submitted.targetDeviceId
          ? { targetDeviceId: submitted.targetDeviceId }
          : {}),
      }),
    });
    if (!verified.ok) {
      log("error", "dispatch_pairing_proof_rejected", {
        requestId,
        reason: verified.reason,
      });
      return dispatchErrorResponse(
        "forbidden",
        "This phone credential is invalid.",
        false,
      );
    }
    caller = {
      kind: "mobile",
      ownerId: caller.ownerId,
      isAnonymous: caller.isAnonymous,
      mobileDeviceId: verified.mobileDeviceId,
      desktopDeviceId: verified.desktopDeviceId,
    };
    submitted = {
      ...submitted,
      ingress: "mobile",
      requestingDeviceId: verified.mobileDeviceId,
    };
  } else if (
    caller.kind === "user" &&
    submitted.ingress !== "desktop" &&
    submitted.ingress !== "browser" &&
    submitted.ingress !== "mobile"
  ) {
    return dispatchErrorResponse(
      "forbidden",
      `${submitted.ingress} ingress requires service authentication or a paired phone credential.`,
      false,
    );
  }

  if (caller.kind === "user" && submitted.ingress === "mobile") {
    // A user JWT authorizes cloud chat. Only a verified pairing proof may
    // supply the phone identity used to offer work to a computer.
    const { requestingDeviceId: _unverifiedDeviceId, ...unpaired } = submitted;
    submitted = unpaired;
  }

  const gateAt = Date.now();
  const preparationMs = Math.round(performance.now() - startedAt);
  let result: Awaited<ReturnType<OwnerGate["submit"]>>;
  try {
    result = await gate.submit({
      request: submitted,
      ...(caller.kind === "service"
        ? { expectedGeneration: caller.ownerGeneration }
        : {}),
      ...(caller.kind === "mobile"
        ? { pairGrantDeviceId: caller.desktopDeviceId }
        : {}),
    });
  } catch (error) {
    log("error", "dispatch_submit_failed", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return dispatchErrorResponse(
      "internal",
      "Stella can't place this right now. Try again shortly.",
      true,
    );
  }
  if (!result.ok) {
    return dispatchErrorResponse(
      result.error.code,
      result.error.message,
      result.error.retryable,
      result.error.retryAfterMs,
    );
  }
  log("info", "dispatch_submitted", {
    requestId,
    dispatchId: result.response.dispatch.dispatchId,
    originUserMessageId: submitted.payload.userMessageEventId,
    ingress: submitted.ingress,
    kind: submitted.kind,
    state: result.response.dispatch.state,
    replayed: result.response.replayed,
    receivedAt,
    gateAt,
    authMs,
    preparationMs,
    totalMs: Math.round(performance.now() - startedAt),
  });
  return Response.json(result.response, {
    status: result.response.replayed ? 200 : 201,
    headers: { "cache-control": "no-store" },
  });
};

/**
 * Status and cancel. Both are owner-bound: the gate is addressed by the owner
 * the caller proved, so a dispatch id from another account simply is not in
 * this object and answers `not_found`.
 */
const handleDispatchControlRoute = async (
  request: Request,
  env: Env,
  dispatchId: string,
  action: "status" | "cancel",
  requestId: string,
): Promise<Response> => {
  let ownerId: string;
  if (await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET)) {
    ownerId = request.headers.get(TURN_OWNER_ID_HEADER)?.trim() ?? "";
    if (!ownerId || ownerId.length > 512) {
      return dispatchErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_ID_HEADER}.`,
        false,
      );
    }
  } else {
    const auth = await authenticateConversationCaller(
      request,
      env,
      false,
      requestId,
    );
    if (!auth.ok) {
      const status = auth.response.status;
      await auth.response.body?.cancel().catch(() => undefined);
      return status === 503
        ? dispatchErrorResponse(
            "internal",
            "Stella couldn't check your sign-in. Try again shortly.",
            true,
          )
        : dispatchErrorResponse("unauthorized", "Sign in to continue.", false);
    }
    ownerId = auth.caller.ownerId;
  }
  const gate = env.OWNER_GATES.getByName(ownerId);
  try {
    if (action === "status") {
      const status = await gate.dispatchStatus(dispatchId);
      return status.ok
        ? Response.json(status.response, {
            headers: { "cache-control": "no-store" },
          })
        : dispatchErrorResponse(
            status.error.code,
            status.error.message,
            status.error.retryable,
          );
    }
    let raw: { cancelRequestId?: unknown; reason?: unknown } | null = null;
    try {
      raw = JSON.parse(
        await readBoundedRequestText(
          request,
          CLOUD_BUILDER_BODY_LIMITS.tinyControl,
          { requireBody: true },
        ),
      ) as { cancelRequestId?: unknown; reason?: unknown };
    } catch (error) {
      const status = boundedBodyStatus(error);
      return dispatchErrorResponse(
        "bad_request",
        status === 413
          ? "Request body is too large."
          : "Malformed JSON request.",
        false,
      );
    }
    const cancelRequestId =
      typeof raw?.cancelRequestId === "string"
        ? raw.cancelRequestId.trim()
        : "";
    if (!cancelRequestId || cancelRequestId.length > 128) {
      return dispatchErrorResponse(
        "bad_request",
        "cancelRequestId is required.",
        false,
      );
    }
    const canceled = await gate.cancelDispatch({
      dispatchId,
      cancelRequestId,
      ...(typeof raw?.reason === "string" && raw.reason.trim()
        ? { reason: raw.reason.trim() }
        : {}),
    });
    return canceled.ok
      ? Response.json(canceled.response, {
          headers: { "cache-control": "no-store" },
        })
      : dispatchErrorResponse(
          canceled.error.code,
          canceled.error.message,
          canceled.error.retryable,
        );
  } catch (error) {
    log("error", "dispatch_control_failed", {
      requestId,
      action,
      message: error instanceof Error ? error.message : String(error),
    });
    return dispatchErrorResponse(
      "internal",
      "Stella can't reach this dispatch right now. Try again shortly.",
      true,
    );
  }
};

const router = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: previewSafeRequestLogPath(url.pathname),
    });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = evaluateCloudBuilderReadiness(env);
      return json(
        {
          ok: readiness.ready,
          service: "stella-v2-cloud-builder",
          checks: {
            missing: readiness.missing,
            invalid: readiness.invalid,
          },
        },
        readiness.ready ? 200 : 503,
      );
    }

    const worldRoute =
      /^\/internal\/worlds\/([0-9a-f]{64}:[0-9a-f]{64})\/(export|changes|push)$/u.exec(
        url.pathname,
      );
    if (worldRoute) {
      return await handleWorldRoute(
        request,
        env,
        worldRoute[1]!,
        worldRoute[2] === "export"
          ? { kind: "export" }
          : worldRoute[2] === "changes"
            ? { kind: "changes" }
            : { kind: "push" },
      );
    }
    const worldBlobRoute =
      /^\/internal\/worlds\/([0-9a-f]{64}:[0-9a-f]{64})\/blob\/([0-9a-f]{64})$/u.exec(
        url.pathname,
      );
    if (worldBlobRoute) {
      return await handleWorldRoute(request, env, worldBlobRoute[1]!, {
        kind: "blob",
        sha256: worldBlobRoute[2]!,
      });
    }

    const vitePreviewMatch = url.pathname.match(
      /^\/internal\/previews\/([A-Za-z0-9._~-]{1,128})\/(pv1\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43})(\/.*)?$/,
    );
    if (vitePreviewMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method not allowed." }, 405);
      }
      const routing = await verifyPreviewAccessRouteCapability({
        capability: vitePreviewMatch[2]!,
        secret: env.BUILDER_SERVICE_SECRET,
        expectedBuildSessionName: vitePreviewMatch[1]!,
        now: Date.now(),
      }).catch(() => ({ ok: false as const, code: "bad_signature" as const }));
      if (!routing.ok) {
        return json({ error: "Preview access was rejected." }, 403);
      }
      const forwardedHeaders = new Headers();
      for (const name of ["accept", "accept-language", "range"]) {
        const value = request.headers.get(name);
        if (value) forwardedHeaders.set(name, value);
      }
      forwardedHeaders.set(HEADER_PREVIEW_CAPABILITY, vitePreviewMatch[2]!);
      const suffix = vitePreviewMatch[3] || "/";
      return await env.BUILD_SESSIONS.getByName(vitePreviewMatch[1]!).fetch(
        `https://build-session/vite-preview${suffix}${url.search}`,
        {
          method: request.method,
          headers: forwardedHeaders,
        },
      );
    }

    // ── User-authenticated routes ─────────────────────────────────────────
    // These MUST stay above the service-secret gate below: a signed-in user
    // presents a Convex JWT, not the shared secret, so matching them after the
    // gate would 401 every client. Both verify the JWT themselves and forward
    // the proven identity to the DO in x-stella-* headers, stripping whatever
    // the client sent under those names first.
    if (url.pathname === "/dictation/socket") {
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await handleMuseTranscribeSocket({
        request,
        env,
        ownerId: auth.caller.ownerId,
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
    }
    const presenceMatch = url.pathname.match(
      /^\/owners\/me\/devices\/([A-Za-z0-9._~-]{1,256})\/presence$/,
    );
    if (presenceMatch) {
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToDevicePresence(
        request,
        env,
        presenceMatch[1]!,
        auth.caller,
      );
    }
    if (request.method === "GET" && url.pathname === DEVICES_PATH) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      try {
        return Response.json(
          await env.OWNER_GATES.getByName(auth.caller.ownerId).devices(),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        log("error", "owner_devices_failed", {
          requestId,
          message: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          {
            protocol: PLACEMENT_PROTOCOL,
            error: "Stella can't list your computers right now.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
    // Placement. `POST` accepts the service secret as well as a user JWT, so
    // it sits here with the other self-authenticating routes rather than
    // behind the shared-secret gate below.
    if (request.method === "POST" && url.pathname === DISPATCH_SUBMIT_PATH) {
      return await handleDispatchSubmitRoute(request, env, requestId);
    }
    // Dispatch ids carry a colon (`dsp:<uuid>`), and every client builds this
    // path with `encodeURIComponent`, so the segment arrives as `dsp%3A…`.
    // The class admits the escape and the handler decodes it; a pattern that
    // rejected `%` let every status poll fall through to the service gate.
    const dispatchMatch = url.pathname.match(
      /^\/owners\/me\/dispatches\/([A-Za-z0-9._:~%-]{1,96})(\/cancel)?$/,
    );
    if (dispatchMatch) {
      const cancel = Boolean(dispatchMatch[2]);
      if (cancel ? request.method !== "POST" : request.method !== "GET") {
        return json({ error: "Method not allowed." }, 405);
      }
      return await handleDispatchControlRoute(
        request,
        env,
        decodeURIComponent(dispatchMatch[1]!),
        cancel ? "cancel" : "status",
        requestId,
      );
    }
    const socketMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/socket$/,
    );
    if (socketMatch) {
      const conversationId = conversationName(socketMatch[1]!);
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const auth = await authenticateConversationCaller(
        request,
        env,
        true,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToConversation(
        request,
        env,
        conversationId,
        "/socket",
        auth.caller,
      );
    }
    const turnStartMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/turns$/,
    );
    if (request.method === "POST" && turnStartMatch) {
      return await handleTurnStartRoute(
        request,
        env,
        turnStartMatch[1]!,
        requestId,
      );
    }
    const historyMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/history$/,
    );
    if (request.method === "GET" && historyMatch) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      return await forwardToConversation(
        request,
        env,
        conversationName(historyMatch[1]!),
        "/history",
        auth.caller,
      );
    }
    const journalAppendMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/journal$/,
    );
    if (request.method === "POST" && journalAppendMatch) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const bodyLimit = publicJsonBodyLimit(request.method, url.pathname)!;
      const bounded = await boundedIngressRequest(request, bodyLimit);
      if (bounded instanceof Response) return bounded;
      return await forwardToConversation(
        bounded,
        env,
        conversationName(journalAppendMatch[1]!),
        "/journal",
        auth.caller,
      );
    }
    const localTurnMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/local-turns\/(begin|finish)$/,
    );
    if (request.method === "POST" && localTurnMatch) {
      const timingStartedAt = performance.now();
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const authMs = Math.round(performance.now() - timingStartedAt);
      const bodyLimit = publicJsonBodyLimit(request.method, url.pathname)!;
      const bounded = await boundedIngressRequest(request, bodyLimit);
      if (bounded instanceof Response) return bounded;
      const forwardStartedAt = performance.now();
      const response = await forwardToConversation(
        bounded,
        env,
        conversationName(localTurnMatch[1]!),
        `/local-turns/${localTurnMatch[2]!}`,
        auth.caller,
      );
      log("info", "conversation_local_turn_request_timing", {
        requestId,
        operation: localTurnMatch[2]!,
        status: response.status,
        authMs,
        durableObjectMs: Math.round(performance.now() - forwardStartedAt),
        totalMs: Math.round(performance.now() - timingStartedAt),
      });
      return response;
    }
    if (url.pathname.startsWith("/cloud-home/")) {
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const response = await handleUserCloudHomeRoute({
        request,
        env,
        ownerId: auth.caller.ownerId,
        // `ownerId` is the full Convex tokenIdentifier; the raw JWT `sub` is
        // deliberately insufficient for a cross-issuer session fence.
        subject: auth.caller.ownerId,
        withLease: cloudHomeLeaseRunner(env),
      });
      if (response) return response;
    }

    // ── Service-secret gate ───────────────────────────────────────────────
    // Sandbox-originated broker calls authenticate with their one-time
    // capability inside the exact BuildSession. They intentionally sit above
    // the service-secret gate; no other route shares this exception.
    const publicTurnBrokerMatch = url.pathname.match(
      /^\/sessions\/([A-Za-z0-9._~-]{1,128})\/turn-broker$/,
    );
    if (publicTurnBrokerMatch) {
      const brokerSessionId = publicTurnBrokerMatch[1]!;
      const response = await env.BUILD_SESSIONS.getByName(
        brokerSessionId,
      ).fetch(new Request("https://build-session/turn-broker", request));
      if (devAcceptanceProbesEnabled(env)) {
        const diagnosticTarget = validateTurnBrokerTarget(
          request.headers.get(TURN_BROKER_HEADERS.targetMethod),
          request.headers.get(TURN_BROKER_HEADERS.targetPath),
        );
        // The outer Worker sees only the broker's already-scrubbed response.
        // Record an allowlisted target kind and numeric status for preview
        // acceptance without reading token-bearing data or the response body.
        log("info", "turn_broker_public_response", {
          threadId: brokerSessionId,
          targetKind: diagnosticTarget?.kind ?? "rejected",
          status: response.status,
        });
      }
      return response;
    }
    // Everything past this check is server-to-server. Nothing may fall
    // through it without another explicit authentication boundary.
    if (
      !(await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET))
    ) {
      return json({ error: "Unauthorized." }, 401);
    }
    const serviceBodyLimit = serviceJsonBodyLimit(request.method, url.pathname);
    if (serviceBodyLimit !== null) {
      const bounded = await boundedIngressRequest(request, serviceBodyLimit);
      if (bounded instanceof Response) return bounded;
      request = bounded;
    }
    if (
      request.method === "POST" &&
      [
        "/internal/interactions/status",
        "/internal/interactions/live-view",
        "/internal/interactions/session-transfer-capability",
        "/internal/interactions/session-transfer",
        "/internal/interactions/decision",
        "/internal/owners/profile/reset",
      ].includes(url.pathname)
    ) {
      if (!env.BROWSER_GATEWAY) {
        return json(
          { code: "unavailable", message: "Cloud browser is unavailable." },
          503,
        );
      }
      if (
        !/^application\/json(?:\s*;|$)/iu.test(
          request.headers.get("content-type") ?? "",
        )
      ) {
        return json(
          { code: "bad_request", message: "JSON request required." },
          415,
        );
      }
      const body = await request.arrayBuffer();
      if (body.byteLength === 0 || body.byteLength > 64 * 1024) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      try {
        const upstream = await env.BROWSER_GATEWAY.fetch(
          `https://browser-gateway${url.pathname}`,
          {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/json" },
            body,
          },
        );
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel().catch(() => undefined);
          return json(
            {
              code: "upstream_failure",
              message: "Cloud browser response was invalid.",
            },
            502,
          );
        }
        let upstreamBody: Uint8Array;
        try {
          upstreamBody = await readBoundedResponseBytes(upstream, 64 * 1024);
        } catch (error) {
          if (!(error instanceof BoundedBodyError)) throw error;
          return json(
            {
              code: "upstream_failure",
              message: "Cloud browser response was invalid.",
            },
            502,
          );
        }
        return new Response(upstreamBody, {
          status: upstream.status,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        });
      } catch {
        log("error", "browser_gateway_control_failed", {
          requestId,
          path: url.pathname,
          errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
        });
        return json(
          {
            code: "upstream_failure",
            message: "Cloud browser request failed.",
          },
          502,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/activity/register"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        activityId?: unknown;
        ownerGeneration?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const activityId =
        typeof body?.activityId === "string" ? body.activityId.trim() : "";
      const ownerGeneration =
        normalizeOwnerGeneration(body?.ownerGeneration) ?? "";
      if (
        !ownerId ||
        ownerId.length > 512 ||
        !activityId ||
        activityId.length > 512 ||
        !ownerGeneration ||
        ownerGeneration.length > 512
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const leaseId = crypto.randomUUID();
      const sessionId = `control-plane:${activityId}`;
      const turnId = activityId;
      const expiresAt = Date.now() + 9 * 60_000;
      const registered = await callOwnerFence(env, ownerId, "register", {
        leaseId,
        sessionId,
        turnId,
        ownerGeneration,
        namespace: "activity",
        role: "activity",
        expiresAt,
      });
      const registration = (await registered.json().catch(() => null)) as {
        generation?: string;
      } | null;
      if (!registered.ok || !registration?.generation) {
        return json(
          {
            code: "owner_purge",
            message: "Account data is being deleted or reset.",
          },
          409,
        );
      }
      return json({
        ownerId,
        ownerGeneration,
        generation: registration.generation,
        leaseId,
        sessionId,
        turnId,
        expiresAt,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/activity/unregister"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        generation?: unknown;
        leaseId?: unknown;
        sessionId?: unknown;
        turnId?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const generation =
        typeof body?.generation === "string" ? body.generation.trim() : "";
      const ownerGeneration =
        normalizeOwnerGeneration(body?.ownerGeneration) ?? "";
      const leaseId =
        typeof body?.leaseId === "string" ? body.leaseId.trim() : "";
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
      if (
        !ownerId ||
        !ownerGeneration ||
        !generation ||
        !leaseId ||
        !sessionId ||
        !turnId
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const unregistered = await callOwnerFence(env, ownerId, "unregister", {
        generation,
        ownerGeneration,
        leaseId,
        sessionId,
        turnId,
      });
      return unregistered.ok
        ? json({ unregistered: true })
        : json(
            {
              code: "owner_purge",
              message: "Account activity lease could not be released.",
            },
            409,
          );
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/conversation-edits/run"
    ) {
      const edit = parseConversationEditRequest(
        await request.json().catch(() => null),
      );
      if (!edit) {
        return json(
          { code: "bad_request", message: "Malformed conversation edit." },
          400,
        );
      }
      try {
        const result = await withOwnerActivityLease(
          env,
          edit.ownerId,
          edit.ownerGeneration,
          `conversation-edit:${edit.operationId}`,
          async () => await runConversationEdit(env, edit),
        );
        return json(result, result.complete ? 200 : 202);
      } catch (error) {
        return conversationEditErrorResponse(error);
      }
    }
    const ownerTransferMatch = url.pathname.match(
      /^\/internal\/conversations\/([^/]+)\/transfer-owner$/,
    );
    if (request.method === "POST" && ownerTransferMatch) {
      const conversationId = ownerTransferMatch[1]!;
      const rawBody = await request.text();
      const transfer = parseOwnerTransferRequest(
        await new Response(rawBody).json().catch(() => null),
      );
      if (!transfer) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const coordinator = await createTransferCoordinatorContext({
        env,
        control: transferControl(transfer),
        fromOwnerId: transfer.fromOwnerId,
        toOwnerId: transfer.toOwnerId,
        operationScope: `conversation:${conversationId}`,
        plan: { kind: "conversation", conversationId },
      });
      try {
        const reserved = await callTransferCoordinator(coordinator, "/reserve");
        const reservation = (await reserved
          .clone()
          .json()
          .catch(() => null)) as {
          status?: string;
          result?: unknown;
        } | null;
        if (!reserved.ok) return reserved;
        if (
          reservation?.status === "copy_complete" ||
          reservation?.status === "acknowledged"
        ) {
          const replay = reservation.result as Record<string, unknown> | null;
          return replay?.transferred === true
            ? json(replay)
            : json(
                {
                  code: "owner_transfer_failed",
                  message:
                    "The durable conversation transfer receipt is invalid.",
                },
                502,
              );
        }
        const forwarded = await env.ORCHESTRATOR_SESSIONS.getByName(
          conversationName(conversationId),
        ).fetch("https://orchestrator-session/internal/transfer-owner", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        });
        const verdict = (await forwarded
          .clone()
          .json()
          .catch(() => null)) as {
          transferred?: unknown;
          code?: unknown;
        } | null;
        if (forwarded.ok && verdict?.transferred === true) {
          const result = {
            transferred: true,
            transferOperationId: coordinator.operationId,
            transferPlanFingerprint: coordinator.planFingerprint,
            ackRequired: true,
          };
          const copied = await callTransferCoordinator(coordinator, "/copied", {
            result,
          });
          if (!copied.ok) {
            return copied;
          }
          return json(result);
        }
        if (
          forwarded.status === 409 &&
          (verdict?.code === "owner_mismatch" ||
            verdict?.code === "owner_transfer_conflict")
        ) {
          await abortTransferCoordinator(coordinator, true);
        } else {
          await yieldTransferCoordinator(coordinator);
        }
        return forwarded;
      } catch (error) {
        await yieldTransferCoordinator(coordinator);
        log("error", "conversation_owner_transfer_failed", {
          requestId,
          operationRef: coordinator.operationId.slice(0, 16),
          message: errorMessage(error),
        });
        return json(
          {
            code: "transfer_unavailable",
            message:
              "Conversation ownership transfer is temporarily unavailable.",
            retryAfterMs: 5_000,
          },
          503,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/transfer-product-state"
    ) {
      const transfer = parseOwnerProductTransferRequest(
        await request.json().catch(() => null),
      );
      if (!transfer) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const coordinator = await createTransferCoordinatorContext({
        env,
        control: transferControl(transfer),
        fromOwnerId: transfer.fromOwnerId,
        toOwnerId: transfer.toOwnerId,
        operationScope: `product:${await stableValueMarker({
          agentHome: transfer.agentHome,
          world: transfer.world,
          appSlugs: transfer.appSlugs,
        })}`,
        plan: {
          kind: "product",
          agentHome: transfer.agentHome,
          world: transfer.world,
          appSlugs: transfer.appSlugs,
        },
      });
      try {
        const reserved = await callTransferCoordinator(coordinator, "/reserve");
        const reservation = (await reserved
          .clone()
          .json()
          .catch(() => null)) as {
          status?: string;
          result?: unknown;
          reservation?: unknown;
        } | null;
        if (!reserved.ok) return reserved;
        if (
          reservation?.status === "copy_complete" ||
          reservation?.status === "acknowledged"
        ) {
          const replay = reservation.result as Record<string, unknown> | null;
          return replay?.transferred === true
            ? json(replay)
            : json(
                {
                  code: "owner_transfer_failed",
                  message: "The durable product transfer receipt is invalid.",
                },
                502,
              );
        }
        coordinator.reservation =
          parseTransferReservationEnvelope(
            reservation?.reservation,
            coordinator.operationId,
          ) ?? undefined;
        if (!coordinator.reservation) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              code: "transfer_unavailable",
              message: "The durable product transfer reservation is invalid.",
              retryAfterMs: 5_000,
            },
            503,
          );
        }
        const result = await transferOwnerProductStorage(
          env,
          transfer,
          coordinator,
        );
        if (!result.complete) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              transferred: false,
              code: "copy_in_progress",
              message: "Owner product state copy is still in progress.",
              retryAfterMs: 1_000,
            },
            202,
          );
        }
        const response = {
          transferred: true,
          ...result,
          transferOperationId: coordinator.operationId,
          transferPlanFingerprint: coordinator.planFingerprint,
          ackRequired: true,
        };
        const copied = await callTransferCoordinator(coordinator, "/copied", {
          result: response,
        });
        if (!copied.ok) {
          return copied;
        }
        return json(response);
      } catch (error) {
        if (error instanceof OwnerProductTransferConfigurationError) {
          await yieldTransferCoordinator(coordinator);
          return json(
            {
              code: "missing_binding",
              message: error.message,
              retryAfterMs: 60_000,
            },
            503,
          );
        }
        if (error instanceof OwnerProductTransferConflictError) {
          const retryable =
            error.code === "owner_purge_temporary" ||
            error.code === "transfer_busy";
          log("info", "owner_product_transfer_conflict", {
            requestId,
            operationRef: coordinator.operationId.slice(0, 16),
            code: error.code,
          });
          if (retryable) {
            await yieldTransferCoordinator(coordinator);
          } else {
            await abortTransferCoordinator(coordinator, true);
          }
          return json(
            {
              code: error.code,
              message: error.message,
              ...(retryable ? { retryAfterMs: 5_000 } : {}),
            },
            409,
          );
        }
        await yieldTransferCoordinator(coordinator);
        log("error", "owner_product_transfer_failed", {
          requestId,
          operationRef: coordinator.operationId.slice(0, 16),
          message: errorMessage(error),
        });
        return json(
          {
            code: "transfer_unavailable",
            message: "Owner product state transfer failed.",
            retryAfterMs: 5_000,
          },
          503,
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/owners/transfer-ack"
    ) {
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const control = body ? parseOwnerTransferControl(body) : null;
      const fromOwnerId =
        typeof body?.fromOwnerId === "string" ? body.fromOwnerId.trim() : "";
      const toOwnerId =
        typeof body?.toOwnerId === "string" ? body.toOwnerId.trim() : "";
      const operationId =
        typeof body?.transferOperationId === "string"
          ? body.transferOperationId
          : "";
      const planFingerprint =
        typeof body?.transferPlanFingerprint === "string"
          ? body.transferPlanFingerprint
          : "";
      if (
        !control ||
        !fromOwnerId ||
        !toOwnerId ||
        fromOwnerId === toOwnerId ||
        fromOwnerId.length > 512 ||
        toOwnerId.length > 512 ||
        !OWNER_TRANSFER_OPERATION_ID_PATTERN.test(operationId) ||
        !OWNER_TRANSFER_OPERATION_ID_PATTERN.test(planFingerprint)
      ) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const attempt = await createCoordinatorAttempt({
        control,
        operationId,
        planFingerprint,
        fromOwnerId,
        toOwnerId,
      });
      return await env.OWNER_TRANSFER_COORDINATORS.getByName(
        `owner-transfer-${operationId}`,
      ).fetch("https://owner-transfer-coordinator/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
      });
    }
    if (request.method === "POST" && url.pathname === "/m0/echo") {
      return env.BUILD_SESSIONS.getByName("m0-echo").fetch(
        "https://build-session/echo",
        {
          method: "POST",
        },
      );
    }
    const turnMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns$/);
    if (request.method === "POST" && turnMatch) {
      const buildSessionName = turnMatch[1]!;
      if (!/^[A-Za-z0-9._~-]{1,128}$/.test(buildSessionName)) {
        return json({ error: "Invalid build session name." }, 400);
      }
      const turnBrokerEndpoint = new URL(
        `/sessions/${encodeURIComponent(buildSessionName)}/turn-broker`,
        url.origin,
      ).toString();
      const previewBaseUrl = new URL(
        `/internal/previews/${encodeURIComponent(buildSessionName)}/`,
        url.origin,
      ).toString();
      const text = await request.text();
      // Convex's desktop dispatch, execution placement's agent branch and a
      // hosted-browser resume all arrive here. Refuse a malformed agent body
      // at the edge rather than instantiating the session for it; the session
      // repeats the same parse, because it trusts nothing it did not check.
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return json({ error: "Malformed JSON request." }, 400);
      }
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as { kind?: unknown }).kind === "agent"
      ) {
        const parsed = parseCloudAgentTurnStartRequest(payload);
        if (!parsed.ok) return json({ error: parsed.message }, 400);
        if (parsed.request.threadId !== buildSessionName) {
          return json(
            { error: "threadId must match the session in the path." },
            400,
          );
        }
      }
      // Built from scratch: nothing the caller sent may reach the session
      // under a trusted name, including the orchestrator's gate-admitted
      // marker — a turn that comes through this route is admitted there.
      return env.BUILD_SESSIONS.getByName(buildSessionName).fetch(
        "https://build-session/turn",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [HEADER_BUILD_SESSION_NAME]: buildSessionName,
            [HEADER_TURN_BROKER_ENDPOINT]: turnBrokerEndpoint,
            [HEADER_PREVIEW_BASE_URL]: previewBaseUrl,
          },
          body: text,
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/internal/owners/home-context/changed") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || !("ownerId" in body) || typeof body.ownerId !== "string" || !body.ownerId || body.ownerId.length > 512 ||
          !("ownerGeneration" in body) || typeof body.ownerGeneration !== "string" || !body.ownerGeneration || body.ownerGeneration.length > 128 ||
          !("revision" in body) || typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1) {
        return json({ error: "Invalid context revision." }, 400);
      }
      await env.OWNER_GATES.getByName(body.ownerId).homeContextChanged(body.ownerGeneration, body.revision);
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === MEMORY_POLICY_CHANGE_PATH) {
      const change = parseMemoryPolicyChange(await request.json().catch(() => null));
      if (!change) return json({ error: "Invalid memory policy change." }, 400);
      try {
        const result = await env.OWNER_GATES.getByName(change.ownerId).changeMemoryPolicy(change);
        return result.ok ? json({ ok: true }) : json({ error: result.code }, result.status);
      } catch (error) {
        return json({ error: error instanceof MemoryPolicyError ? error.code : "MEMORY_POLICY_UNAVAILABLE" },
          error instanceof MemoryPolicyError ? error.status : 503);
      }
    }
    // Convex learned an owner's plan, generation, engines or pairing changed.
    // A complete push pre-warms the gate; a snapshot-less push marks it stale.
    if (
      request.method === "POST" &&
      url.pathname === BUILDER_OWNER_SNAPSHOT_CHANGED_PATH
    ) {
      const body = (await request
        .json()
        .catch(() => null)) as Partial<OwnerSnapshotChangedRequest> | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      if (!ownerId || ownerId.length > 512) {
        return json({ error: "ownerId is required." }, 400);
      }
      const gate = env.OWNER_GATES.getByName(ownerId);
      if (body?.snapshot !== undefined) {
        const snapshot = parseOwnerSnapshot(body.snapshot, ownerId);
        if (!snapshot) {
          return json({ error: "snapshot is malformed." }, 400);
        }
        await gate.replaceSnapshot(snapshot);
      } else {
        await gate.invalidate();
      }
      log("info", "owner_snapshot_changed", {
        requestId,
        reason: typeof body?.reason === "string" ? body.reason : "unknown",
        pushedSnapshot: body?.snapshot !== undefined,
      });
      return json({ ok: true });
    }
    const chatCancelMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/cancel$/,
    );
    if (request.method === "POST" && chatCancelMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(chatCancelMatch[1]!),
      ).fetch("https://orchestrator-session/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Exact placement turn + cancellation identity must survive the
        // gateway. Dropping this body regresses to conversation-wide Stop and
        // can cancel a newer turn after a delayed retry.
        body: await request.text(),
      });
    }
    // Convex-driven writes into a conversation's journal, plus the operator
    // surfaces. Pure pass-throughs: the DO owns every decision, this worker
    // only proves the caller holds the service secret.
    const conversationAdminMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/(cards|purge)$/,
    );
    if (request.method === "POST" && conversationAdminMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(conversationAdminMatch[1]!),
      ).fetch(`https://orchestrator-session/${conversationAdminMatch[2]!}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }
    const devAcceptanceProbeMatch = url.pathname.match(
      /^\/internal\/dev-acceptance\/conversations\/([^/]+)\/probe$/,
    );
    if (request.method === "POST" && devAcceptanceProbeMatch) {
      // Hide the route entirely unless this exact deployment was built as a
      // non-production acceptance target. The DO repeats this gate and checks
      // the disposable owner/conversation markers before any side effect.
      if (!devAcceptanceProbesEnabled(env)) {
        return json({ error: "Not found." }, 404);
      }
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(devAcceptanceProbeMatch[1]!),
      ).fetch("https://orchestrator-session/internal/dev-acceptance/probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-acceptance-service-secret": env.BUILDER_SERVICE_SECRET,
        },
        body: await request.text(),
      });
    }
    // The journal probe reads the canonical journal exactly the way a client
    // does, including through R2 segments.
    const journalProbeMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/journal$/,
    );
    if (request.method === "GET" && journalProbeMatch) {
      const probe = new URL("https://orchestrator-session/journal");
      probe.search = url.search;
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(journalProbeMatch[1]!),
      ).fetch(probe.toString(), { method: "GET" });
    }
    const steerMatch = url.pathname.match(/^\/sessions\/([^/]+)\/steer$/);
    if (request.method === "POST" && steerMatch) {
      return env.BUILD_SESSIONS.getByName(steerMatch[1]!).fetch(
        "https://build-session/steer",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      return env.BUILD_SESSIONS.getByName(cancelMatch[1]!).fetch(
        "https://build-session/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    // Operator surface for a thread stuck "running": expire its watchdog now.
    // The DO interrupts a hung local fiber and re-arms its alarm so the
    // ordinary timeout path delivers the terminal
    // while the container's teardown stays alarm-owned debt.
    const expireMatch = url.pathname.match(/^\/sessions\/([^/]+)\/expire$/);
    if (request.method === "POST" && expireMatch) {
      return env.BUILD_SESSIONS.getByName(expireMatch[1]!).fetch(
        "https://build-session/expire-agent-turn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    // Operator surface for a container the inventory says is live but no
    // Durable Object still owns. Wrangler cannot stop one instance and only the
    // sandbox object holds the container handle, so retirement is a keep-alive
    // release plus destroy on the exact tuple, by name.
    if (
      request.method === "POST" &&
      url.pathname === "/internal/sandboxes/retire"
    ) {
      return await retireSandboxInstance(env, request);
    }
    // Owner-level object storage sweep, the storage half of account deletion.
    // Convex holds no credential for any bucket here and cannot enumerate this
    // worker's KV, so everything outside Convex is reached from this one route.
    // See the store table above `OwnerPurgeRequest` for the list it walks and
    // why each entry needs the shape it has.
    //
    // Contract with the caller (convex/cloud_purge.ts):
    //   - It is idempotent. Every step is "delete if present".
    //   - It never reports success it did not achieve: anything it could not
    //     finish comes back in `pending`, and the caller keeps the Convex rows
    //     that name those bytes until a later pass returns `pending: []`.
    //   - The named stores (`appSlugs` and legacy
    //     `buildPrefixes`) cannot all be derived from the owner id, so Convex
    //     reads them off the rows and sends them here BEFORE deleting those
    //     rows. New app builds are additionally swept by their owner-hash root
    //     above, which catches uploads that never acquired a Convex row.
    // Retire ONE superseded build's artifacts. Deliberately not the owner
    // purge: that route fences the owner, refuses while turns run, and walks
    // every store. Activating a new app build must not touch anything else.
    if (
      request.method === "POST" &&
      url.pathname === "/internal/apps/builds/retire"
    ) {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        artifactPrefix?: unknown;
      } | null;
      const ownerId = typeof body?.ownerId === "string" ? body.ownerId : "";
      const prefix =
        typeof body?.artifactPrefix === "string" ? body.artifactPrefix : "";
      if (!ownerId || !prefix) {
        return json({ error: "ownerId and artifactPrefix required." }, 400);
      }
      const ownerHash = await sha256Hex(ownerId);
      if (
        !(
          LEGACY_BUILD_PREFIX_PATTERN.test(prefix) ||
          isOwnerAppBuildPrefix(prefix, ownerHash)
        )
      ) {
        return json({ error: "artifactPrefix does not belong to owner." }, 403);
      }
      try {
        const swept = await sweepR2Prefix(env.APP_BUILDS, `${prefix}/`);
        return json({ ok: true, deleted: swept.deleted, done: swept.done });
      } catch (error) {
        return json({ error: errorMessage(error) }, 503);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge/begin") {
      const body = (await request.json()) as {
        ownerId?: string;
        mode?: OwnerPurgeMode;
        requestId?: string;
        expectedGeneration?: string;
      };
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      const requestId = normalizeOwnerGeneration(body.requestId);
      if (!ownerId || !requestId) {
        return json({ error: "ownerId and requestId required." }, 400);
      }
      try {
        return json(
          await beginOwnerPurge(
            env,
            ownerId,
            body.mode === "permanent" ? "permanent" : "temporary",
            requestId,
            body.expectedGeneration,
          ),
        );
      } catch (error) {
        return json({ error: errorMessage(error) }, 409);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge/release") {
      const body = (await request.json()) as {
        ownerId?: string;
        purgeGeneration?: string;
      };
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      if (!ownerId || !body.purgeGeneration) {
        return json({ error: "ownerId and purgeGeneration required." }, 400);
      }
      const released = await callOwnerFence(env, ownerId, "release", {
        generation: body.purgeGeneration,
      });
      return released;
    }
    if (request.method === "POST" && url.pathname === "/owners/memory-wipe") {
      const body = (await request.json().catch(() => null)) as {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        operationId?: unknown;
        memoryEpoch?: unknown;
        purgeGeneration?: unknown;
        protocolVersion?: unknown;
        cursor?: unknown;
        startAfter?: unknown;
      } | null;
      const ownerId =
        typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration = normalizeOwnerGeneration(body?.ownerGeneration);
      const operationId = normalizeOwnerGeneration(body?.operationId);
      const memoryEpoch = normalizeOwnerGeneration(body?.memoryEpoch);
      const purgeGeneration = normalizeOwnerGeneration(body?.purgeGeneration);
      const cursor = body?.cursor;
      if (
        !ownerId ||
        ownerId.length > 512 ||
        !ownerGeneration ||
        !operationId ||
        !memoryEpoch ||
        !purgeGeneration ||
        body?.protocolVersion !== MEMORY_WIPE_PROTOCOL_VERSION ||
        !Number.isSafeInteger(cursor) ||
        (cursor as number) < 0 ||
        (cursor as number) > MEMORY_WIPE_TARGET_COUNT ||
        (body?.startAfter !== undefined &&
          (typeof body.startAfter !== "string" ||
            body.startAfter.length === 0 ||
            body.startAfter.length > 1_024))
      ) {
        return json({ error: "Malformed memory wipe request." }, 400);
      }
      const fenced = await callOwnerFence(env, ownerId, "assert-blocked", {
        generation: purgeGeneration,
      });
      const fenceState = (await fenced.json().catch(() => null)) as {
        active?: OwnerPurgeFence["active"];
        beginRequestId?: unknown;
      } | null;
      if (
        !fenced.ok ||
        fenceState?.beginRequestId !== `memory-wipe:${operationId}`
      ) {
        return json({ error: "Memory wipe fence is not active." }, 409);
      }
      if (Object.keys(fenceState.active ?? {}).length > 0) {
        return json({ error: "Owner cloud activity is still active." }, 409);
      }
      if (!env.AGENT_HOME) {
        return json({ error: "Cloud home storage is unavailable." }, 503);
      }
      try {
        const result = await sweepMemoryWipePage(env.AGENT_HOME, {
          ownerId,
          ownerGeneration,
          cursor: cursor as number,
          ...(typeof body?.startAfter === "string"
            ? { startAfter: body.startAfter }
            : {}),
        });
        log("info", "cloud_memory_wipe_page", {
          ownerId,
          operationId,
          memoryEpoch,
          cursor: result.cursor,
          deleted: result.deleted,
          complete: result.complete,
        });
        return json(result, result.complete ? 200 : 202);
      } catch {
        log("error", "cloud_memory_wipe_page_failed", {
          ownerId,
          operationId,
          cursor,
          // R2 failures can contain internal URLs or object locators. Keep the
          // durable retry observable without copying provider detail to logs.
          errorCode: "MEMORY_WIPE_STORAGE_FAILURE",
        });
        return json({ error: "Cloud memory storage wipe failed." }, 502);
      }
    }
    if (request.method === "POST" && url.pathname === "/owners/purge") {
      const body = (await request.json()) as OwnerPurgeRequest;
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      const browserProfiles = body.browserProfiles ?? [];
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      if (!ownerId || !body.purgeGeneration) {
        return json({ error: "ownerId and purgeGeneration required." }, 400);
      }
      if (
        !Array.isArray(browserProfiles) ||
        browserProfiles.length > 1 ||
        browserProfiles.some((profile) => profile !== "default") ||
        new Set(browserProfiles).size !== browserProfiles.length ||
        (browserProfiles.length > 0 && !ownerGeneration)
      ) {
        return json({ error: "Malformed browser profile purge request." }, 400);
      }
      const fenced = await callOwnerFence(env, ownerId, "assert-blocked", {
        generation: body.purgeGeneration,
      });
      if (!fenced.ok) {
        return json({ error: "Owner is not fenced for this purge." }, 409);
      }
      const fenceState = (await fenced.json()) as {
        active?: OwnerPurgeFence["active"];
      };
      if (Object.keys(fenceState.active ?? {}).length > 0) {
        return json({ error: "Owner cloud turns are still active." }, 409);
      }
      let turnStateDeleted = 0;
      let turnStatePending = false;
      try {
        const turnStatePurge = await callOwnerFence(
          env,
          ownerId,
          "turn-state/purge",
          {
            schemaVersion: 1,
            generation: body.purgeGeneration,
          },
        );
        const result = (await turnStatePurge.json().catch(() => null)) as {
          deleted?: unknown;
          pending?: unknown;
        } | null;
        if (
          !turnStatePurge.ok ||
          !result ||
          !Number.isSafeInteger(result.deleted) ||
          (result.deleted as number) < 0 ||
          typeof result.pending !== "boolean"
        ) {
          turnStatePending = true;
        } else {
          turnStateDeleted = result.deleted as number;
          turnStatePending = result.pending;
        }
      } catch (error) {
        turnStatePending = true;
        log("error", "owner_storage_purge_step_failed", {
          store: "turn-state",
          message: errorMessage(error),
        });
      }
      let browserProfilesDeleted = 0;
      const browserProfilePending: string[] = [];
      if (browserProfiles.includes("default")) {
        const browserPurgeRequestId = crypto.randomUUID();
        if (!env.BROWSER_GATEWAY) {
          browserProfilePending.push("browser-profile:default");
        } else {
          try {
            const browserPurge = await env.BROWSER_GATEWAY.fetch(
              "https://browser-gateway/internal/owners/purge",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  schemaVersion: 1,
                  ownerId,
                  requestId: browserPurgeRequestId,
                }),
              },
            );
            const result = (await browserPurge.json().catch(() => null)) as {
              schemaVersion?: unknown;
              requestId?: unknown;
              profileId?: unknown;
              purged?: unknown;
            } | null;
            if (
              !browserPurge.ok ||
              result?.schemaVersion !== 1 ||
              result.requestId !== browserPurgeRequestId ||
              result.profileId !== "default" ||
              result.purged !== true
            ) {
              browserProfilePending.push("browser-profile:default");
            } else {
              browserProfilesDeleted = 1;
            }
          } catch {
            browserProfilePending.push("browser-profile:default");
            log("error", "owner_storage_purge_step_failed", {
              store: "browser-profile:default",
              errorCode: "BROWSER_GATEWAY_UPSTREAM_FAILURE",
            });
          }
        }
      }
      const legacyReport = await purgeOwnerStorage(env, ownerId, body);
      const report: OwnerPurgeReport = {
        ok: true,
        deleted:
          legacyReport.deleted + turnStateDeleted + browserProfilesDeleted,
        pending: Array.from(
          new Set([
            ...legacyReport.pending,
            ...(turnStatePending ? ["turn-state"] : []),
            ...browserProfilePending,
          ]),
        ),
      };
      log("info", "owner_storage_purged", {
        requestId,
        deleted: report.deleted,
        pending: report.pending,
      });
      return json(report);
    }
    if (request.method === "POST" && url.pathname === "/routes/activate") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
        ownerGeneration: string;
        buildId: string;
        artifactPrefix: string;
      };
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      let expectedArtifactPrefix: string;
      try {
        if (
          typeof body.ownerId !== "string" ||
          !body.ownerId ||
          body.ownerId.length > 512 ||
          typeof body.appId !== "string" ||
          !body.appId ||
          body.appId.length > 512 ||
          typeof body.slug !== "string" ||
          !APP_SLUG_PATTERN.test(body.slug) ||
          typeof body.buildId !== "string" ||
          typeof body.artifactPrefix !== "string" ||
          !ownerGeneration
        ) {
          throw new Error("Invalid route activation.");
        }
        expectedArtifactPrefix = ownerAppBuildPrefix(
          await sha256Hex(body.ownerId),
          body.buildId,
        );
      } catch {
        return json({ error: "Malformed app route." }, 400);
      }
      if (body.artifactPrefix !== expectedArtifactPrefix) {
        return json({ error: "App route artifact owner does not match." }, 400);
      }
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          ownerGeneration,
          requestId,
          async (generation, leaseId) => {
            await env.APP_ROUTES.put(
              `app:${body.slug}`,
              JSON.stringify({
                slug: body.slug,
                appId: body.appId,
                ownerId: body.ownerId,
                buildId: body.buildId,
                artifactPrefix: body.artifactPrefix,
                suspended: false,
                updatedAt: Date.now(),
              }),
            );
            const fenced = await callOwnerFence(env, body.ownerId, "assert", {
              generation,
              leaseId,
              ownerGeneration,
            });
            if (!fenced.ok) throw new OwnerPurgeFenceError();
          },
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        throw error;
      }
      log("info", "route_activated", {
        requestId,
        slug: body.slug,
        appId: body.appId,
        buildId: body.buildId,
      });
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/routes/suspend") {
      const body = (await request.json()) as {
        slug: string;
        appId: string;
        ownerId: string;
        ownerGeneration: string;
      };
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      if (
        typeof body.ownerId !== "string" ||
        !body.ownerId ||
        body.ownerId.length > 512 ||
        typeof body.appId !== "string" ||
        !body.appId ||
        body.appId.length > 512 ||
        typeof body.slug !== "string" ||
        !APP_SLUG_PATTERN.test(body.slug) ||
        !ownerGeneration
      ) {
        return json({ error: "Malformed app route." }, 400);
      }
      const route = await env.APP_ROUTES.get<Record<string, unknown>>(
        `app:${body.slug}`,
        "json",
      );
      if (
        !route ||
        route.appId !== body.appId ||
        route.ownerId !== body.ownerId
      ) {
        return json({ error: "App route not found." }, 404);
      }
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          ownerGeneration,
          requestId,
          async (generation, leaseId) => {
            await env.APP_ROUTES.put(
              `app:${body.slug}`,
              JSON.stringify({
                ...route,
                suspended: true,
                updatedAt: Date.now(),
              }),
            );
            const fenced = await callOwnerFence(env, body.ownerId, "assert", {
              generation,
              leaseId,
              ownerGeneration,
            });
            if (!fenced.ok) throw new OwnerPurgeFenceError();
          },
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        throw error;
      }
      log("info", "route_suspended", {
        requestId,
        slug: body.slug,
        appId: body.appId,
      });
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  },

  /**
   * The outbox consumer. Every batch is one `POST /api/cloud/outbox`; the
   * verdict decides ack versus retry (see `deliverOutboxBatch`), and after
   * `max_retries` the queue parks the batch on the dead-letter queue.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Persist terminal receipts before acknowledging queue delivery. Mobile
    // polls the owner gate, while transcript events are projected to Convex.
    try {
      for (const { body } of batch.messages) {
        if (!isOutboxEvent(body) || body.kind !== "turn.event" || !body.terminal) continue;
        const outcome = body.terminalStatus;
        if (outcome !== "completed" && outcome !== "failed" && outcome !== "canceled") continue;
        await env.OWNER_GATES.getByName(body.ownerId).recordCloudDispatchTerminal({
          ownerGeneration: body.ownerGeneration, turnId: body.turnId, outcome,
          ...(body.resultJson ? { resultJson: body.resultJson } : {}),
          ...(body.errorMessage ? { errorMessage: body.errorMessage } : {}),
        });
      }
    } catch {
      batch.retryAll();
      return;
    }
    const delivery = await deliverOutboxBatch(batch, env);
    log(delivery.disposition === "retried" ? "error" : "info", "outbox_batch", {
      queue: batch.queue,
      ...delivery,
    });
  },
} satisfies ExportedHandler<Env>;

export const worker = {
  ...router,
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withBrowserCors(request, () => router.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
