import {
  mintWorkspaceAppAccess,
  serveWorkspaceApp,
  serveWorkspaceAppPreview,
} from "../workspace-app-access.js";
import { worldName } from "../workspace.js";
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

import { handleSlackRoute } from "../slack/routes.js";
import { Hono, type MiddlewareHandler } from "hono";
import { GATEWAY_NETWORK_POLICY } from "@stella/contracts/gateway/api";
import { TURN_BROKER_HEADERS } from "@stella/contracts/turn-credential-broker";
import { JOURNAL_CHECKPOINT_PATH, JOURNAL_CHECKPOINT_SUMMARY_MAX_BYTES } from "@stella/contracts/journal-checkpoint";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  buildMobilePairingChallenge,
  canonicalDispatchPayloadJson,
  hasMobilePairingProofHeaders,
  sha256Hex as pairingSha256Hex,
  readMobilePairingProofHeaders,
  verifyMobilePairingProof,
} from "@stella/contracts/turn-plane/pairing-proof";
import type { DispatchSubmitRequest } from "@stella/contracts/turn-plane/placement";
import {
  DEVICES_PATH,
  DISPATCH_SUBMIT_PATH,
  PLACEMENT_PROTOCOL,
} from "@stella/contracts/turn-plane/placement";
import {
  CONVERSATION_ID_PATTERN,
  TURN_OWNER_GENERATION_HEADER,
  TURN_OWNER_ID_HEADER,
} from "@stella/contracts/turn-plane/turn-start";
import { bearerCredential } from "../../../shared/bearer.js";
import { classifyNetwork } from "../../../shared/network-class.js";
import { verifyUserToken } from "../auth-jwt.js";
import { noteOwnerIdentity } from "../owner-identity.js";
import { readBoundedRequestText } from "../bounded-body.js";
import { withBrowserCors } from "../browser-cors.js";
import { handleVoiceRoute, ownerDictationControl } from "../voice/routes.js";
import { handleBackendRoute } from "../owner-store/routes.js";
import { handleMediaRoute } from "../media/routes.js";
import { handleMapsRoute } from "../maps/routes.js";
import { handleDictationTranscribeRoute } from "../dictation/transcribe-route.js";
import { handleIntegrationsRoute } from "../integrations/routes.js";
import { handleProjectsRoute } from "../projects/routes.js";
import { handleAppSourceBootstrap } from "../app-source-bootstrap.js";
import { handleWebRendererRoute } from "../web-renderer.js";
import { handleUserCloudHomeRoute, ownerAccess } from "../cloud-home-routes.js";
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
import { handleMuseTranscribeSocket } from "../muse-transcribe-socket.js";
import { STELLA_PROMPTS_PATH } from "@stella/contracts/stella-api";
import { stellaPromptsResponse } from "../prompts/route.js";
import {
  HEADER_PRESENCE_DEVICE_ID,
  OwnerGate,
} from "../owner-gate.js";
import { normalizeOwnerGeneration } from "../owner-generation.js";
import { evaluateCloudBuilderReadiness } from "../readiness.js";
import {
  boundedBodyStatus,
  CLOUD_BUILDER_BODY_LIMITS,
} from "../request-ingress.js";
import { verifyServiceBearerRequest } from "../service-bearer.js";
import { handleBillingRoute } from "../billing/routes.js";
import { handleAdminRoute } from "../admin/routes.js";
import { handleStellaModelsRoute } from "../catalog/models.js";
import { handleDevicesRoute } from "../devices/routes.js";
import { handleUserAsksRoute } from "../user-asks/routes.js";
import { handleDeviceRequestRoute } from "../devices/device-request-route.js";
import { handleDeviceToolRoute } from "../devices/device-tool-route.js";
import { DEVICE_TOOL_LIMITS } from "@stella/contracts/turn-plane/device-tools";
import { DEVICE_REQUEST_LIMITS } from "@stella/contracts/turn-plane/device-requests";
import { validateTurnBrokerTarget } from "../turn-credential-broker.js";
import type { TurnAuthKind } from "../turn-start-request.js";
import {
  HEADER_TURN_AUTH_KIND,
  parseCloudTurnStartRequest,
  serviceOnlyTurnFields,
  turnStartErrorResponse,
} from "../turn-start-request.js";
import { previewSafeRequestLogPath } from "../vite-preview-access.js";
import {
  boundedIngressRequest,
  cloudHomeLeaseRunner,
  handleWorldRoute,
} from "./owner-purge-transfer.js";
import { retireSandboxInstance } from "./session-sandbox.js";
import type { Env } from "./shared/env.js";
import {
  HEADER_CONVERSATION_ID,
  json,
  log,
  ORCHESTRATOR_INTERNAL_ORIGIN,
} from "./shared/keys.js";
import type { ConversationCaller, DispatchCaller } from "./shared/types.js";

// ---------------------------------------------------------------------------
// The user-authenticated conversation surfaces
//
// Every other route on this worker is server-to-server and gated by the shared
// service secret. These two are the exception: they carry a signed-in user's
// user JWT, which is NOT the service secret, so they are matched before that
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
  const issuer = (env.CLOUD_BUILDER_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
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
    token = bearerCredential(request.headers.get("authorization")) ?? "";
  }
  if (!token) {
    return deny(
      CLOSE_UNAUTHENTICATED,
      401,
      "Sign in to open this conversation.",
      false,
    );
  }

  const verified = await verifyUserToken(token, env);
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
  await noteOwnerIdentity(env, verified.token);
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
  conversationId: string,
  requestId: string,
): Promise<Response> => {
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
    // Service-originated: a schedule fire, placement's cloud branch, an
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

// ---------------------------------------------------------------------------
// The route table
//
// Hono runs handlers in registration order, and the order below is load
// bearing: every self-authenticating route (user JWT, signed callback, public)
// is registered before the service-secret gate, and every server-to-server
// route after it. A request that matches nothing above the gate is answered
// 401 unless it carries the service secret, so an unknown path never reveals
// whether it exists.
// ---------------------------------------------------------------------------

type RouterEnv = {
  Bindings: Env;
  Variables: { requestId: string; caller: ConversationCaller };
};

type SubRouter = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null | undefined>;

/** An area router that answers its own paths and returns null for the rest. */
const mount = (handle: SubRouter): MiddlewareHandler<RouterEnv> =>
  async (c, next) => {
    // `executionCtx` throws when the caller passed none; read it only on use.
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise),
      passThroughOnException: () => c.executionCtx.passThroughOnException(),
    } as ExecutionContext;
    const response = await handle(c.req.raw, c.env, ctx);
    if (response) return response;
    await next();
  };

/**
 * Verify the signed-in user's JWT and expose the proven identity as
 * `c.var.caller`. `socket` shapes refusals for a WebSocket client.
 */
const userAuth = (
  { socket }: { socket: boolean } = { socket: false },
): MiddlewareHandler<RouterEnv> =>
  async (c, next) => {
    const auth = await authenticateConversationCaller(
      c.req.raw,
      c.env,
      socket,
      c.var.requestId,
    );
    if (!auth.ok) return auth.response;
    c.set("caller", auth.caller);
    await next();
  };

/** Buffer and validate a JSON body before the handler forwards it. */
const jsonBody = (maxBytes: number): MiddlewareHandler<RouterEnv> =>
  async (c, next) => {
    const bounded = await boundedIngressRequest(c.req.raw, maxBytes);
    if (bounded instanceof Response) return bounded;
    c.req.raw = bounded;
    await next();
  };

const socketOnly: MiddlewareHandler<RouterEnv> = async (c, next) => {
  if (c.req.method !== "GET" || !isWebSocketUpgrade(c.req.raw)) {
    return json({ error: "This endpoint speaks WebSocket only." }, 426);
  }
  await next();
};

const methodNotAllowed = (message = "Method not allowed.") => () =>
  json({ error: message }, 405);

const serviceSecret: MiddlewareHandler<RouterEnv> = async (c, next) => {
  if (!(await verifyServiceBearerRequest(c.req.raw, c.env.BUILDER_SERVICE_SECRET))) {
    return json({ error: "Unauthorized." }, 401);
  }
  await next();
};

/** Hand the buffered body to a Durable Object path with nothing else attached. */
const forwardBody = async (
  stub: { fetch(url: string, init: RequestInit): Promise<Response> },
  url: string,
  request: Request,
  headers: Record<string, string> = {},
): Promise<Response> =>
  await stub.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: await request.text(),
  });

const WORLD_KEY = "[0-9a-f]{64}:[0-9a-f]{64}";
const APP_SLUG = "[a-z][a-z0-9-]{0,31}";
/**
 * A broker session may also be the orchestrator's `orch:<conversationId>`
 * thread, whose name reaches this route percent-encoded
 * (`encodeURIComponent`); the parameter decodes back to the exact name.
 */
const BROKER_SESSION_ID = "(?:[A-Za-z0-9._~-]|%3[Aa]){1,160}";
const { tinyControl } = CLOUD_BUILDER_BODY_LIMITS;

const app = new Hono<RouterEnv>();

app.use(async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  log("info", "request_started", {
    requestId,
    method: c.req.method,
    path: c.req.path.startsWith("/workspace-apps/")
      ? "/workspace-apps/[session]"
      : previewSafeRequestLogPath(new URL(c.req.url).pathname),
  });
  await next();
});

// ── Public ────────────────────────────────────────────────────────────────

app.get("/healthz", () => json({ ok: true, service: "stella-v2-cloud-builder" }));
app.get("/readyz", (c) => {
  const readiness = evaluateCloudBuilderReadiness(c.env);
  return json(
    {
      ok: readiness.ready,
      service: "stella-v2-cloud-builder",
      checks: { missing: readiness.missing, invalid: readiness.invalid },
    },
    readiness.ready ? 200 : 503,
  );
});
app.get(STELLA_PROMPTS_PATH, (c) => stellaPromptsResponse(c.req.raw));
// Identity: Better Auth, loaded on first use to keep it off other wakes.
app.all("/api/auth/:rest{.*}", async (c) => {
  const { handleAuthRoute } = await import("../auth/routes.js");
  return await handleAuthRoute(c.req.raw, c.env);
});

// World sync carries its own capability; the handler checks it.
app.all(`/internal/worlds/:world{${WORLD_KEY}}/:op{export|changes|push}`, (c) => {
  const op = c.req.param("op") as "export" | "changes" | "push";
  return handleWorldRoute(c.req.raw, c.env, c.req.param("world"), { kind: op });
});
app.all(`/internal/worlds/:world{${WORLD_KEY}}/blob/:sha256{[0-9a-f]{64}}`, (c) =>
  handleWorldRoute(c.req.raw, c.env, c.req.param("world"), {
    kind: "blob",
    sha256: c.req.param("sha256"),
  }),
);

app.all("/workspace-apps/:rest{.*}", (c) => serveWorkspaceApp(c.req.raw, c.env));

// ── User-authenticated ────────────────────────────────────────────────────
// A signed-in user presents a user JWT, not the shared secret. Each route
// verifies it and forwards the proven identity to the DO in x-stella-*
// headers, stripping whatever the client sent under those names first.

// Listing, minting an app URL and serving a preview only read owner state, so
// none of them takes an activity lease: a lease would turn every poll into
// durable register/assert/unregister writes, and a stale read cannot outlive a
// purge because the minted capability carries the generation.
const listOwnerApps = async (env: Env, ownerId: string) => {
  const world = env.WORLDS.getByName(await worldName(ownerId));
  await ownerAccess(env, ownerId);
  const apps = await world.listWorkspaceApps();
  return { world, apps };
};
app.get("/owners/me/apps", userAuth(), async (c) => {
  const { apps } = await listOwnerApps(c.env, c.var.caller.ownerId);
  return json({ apps });
});
app.all("/owners/me/apps", methodNotAllowed("Method not allowed"));
app.post(`/owners/me/apps/:slug{${APP_SLUG}}/session`, userAuth(), async (c) => {
  const { ownerId } = c.var.caller;
  const slug = c.req.param("slug");
  const { apps } = await listOwnerApps(c.env, ownerId);
  if (!apps.some((app) => app.slug === slug && app.status === "ready"))
    return json({ error: "App not found" }, 404);
  return json(await mintWorkspaceAppAccess(c.env, ownerId, slug));
});
app.all(`/owners/me/apps/:slug{${APP_SLUG}}/session`, methodNotAllowed("Method not allowed"));
app.get(`/owners/me/apps/:slug{${APP_SLUG}}/preview`, userAuth(), async (c) => {
  const { ownerId } = c.var.caller;
  const slug = c.req.param("slug");
  const { world, apps } = await listOwnerApps(c.env, ownerId);
  const app = apps.find((entry) => entry.slug === slug && entry.status === "ready");
  if (!app) return json({ error: "App not found" }, 404);
  return await serveWorkspaceAppPreview(c.env, ownerId, app, world);
});
app.all(`/owners/me/apps/:slug{${APP_SLUG}}/preview`, methodNotAllowed("Method not allowed"));

// Area routers. Each authenticates its own routes: the owner store and voice
// check the user's JWT; media, projects, billing and integrations also take
// signed webhooks and callbacks; admin checks STELLA_ADMIN_API_SECRET; the
// model catalog and app-source bootstrap are public.
app.use(mount(handleBackendRoute));
app.use(mount(handleStellaModelsRoute));
app.use(mount(handleMediaRoute));
app.use(mount(handleMapsRoute));
app.use(mount(handleDictationTranscribeRoute));
app.use(mount(handleProjectsRoute));
app.use(mount(handleAppSourceBootstrap));
app.use(
  mount((request, env, ctx) =>
    handleWebRendererRoute(request, env, (promise) => ctx.waitUntil(promise)),
  ),
);
app.use(mount(handleBillingRoute));
app.use(mount(handleAdminRoute));
app.use(mount(handleDevicesRoute));
app.use(mount(handleUserAsksRoute));
app.use(mount(handleVoiceRoute));
app.use(mount(handleIntegrationsRoute));
// Slack signs its own requests; the link pages carry signed state.
app.use(mount(handleSlackRoute));

app.all("/dictation/socket", socketOnly, async (c) => {
  const receivedAt = Date.now();
  const auth = await authenticateConversationCaller(
    c.req.raw,
    c.env,
    true,
    c.var.requestId,
  );
  if (!auth.ok) return auth.response;
  return await handleMuseTranscribeSocket({
    request: c.req.raw,
    env: c.env,
    control: ownerDictationControl(c.env, auth.caller.ownerId),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    timing: {
      requestId: c.var.requestId,
      receivedAt,
      authMs: Date.now() - receivedAt,
    },
  });
});
app.all(
  "/owners/me/devices/:deviceId{[A-Za-z0-9._~-]{1,256}}/presence",
  socketOnly,
  userAuth({ socket: true }),
  (c) =>
    forwardToDevicePresence(c.req.raw, c.env, c.req.param("deviceId"), c.var.caller),
);
app.post(
  "/owners/me/devices/:deviceId{[A-Za-z0-9._~-]{1,256}}/requests",
  userAuth(),
  jsonBody(DEVICE_REQUEST_LIMITS.paramsBytes + 1024),
  (c) =>
    handleDeviceRequestRoute(c.req.raw, c.env, c.req.param("deviceId"), c.var.caller),
);
// One of the owner's computers runs a tool call on another, for its own
// conversation's tools (`@stella/contracts/turn-plane/device-tools`).
app.post(
  "/owners/me/devices/:deviceId{[A-Za-z0-9._~-]{1,256}}/tool-calls",
  userAuth(),
  jsonBody(DEVICE_TOOL_LIMITS.callBytes + 4096),
  (c) => handleDeviceToolRoute(c.req.raw, c.env, c.req.param("deviceId"), c.var.caller, "call"),
);
app.post(
  "/owners/me/devices/:deviceId{[A-Za-z0-9._~-]{1,256}}/tool-calls/cancel",
  userAuth(),
  jsonBody(tinyControl),
  (c) => handleDeviceToolRoute(c.req.raw, c.env, c.req.param("deviceId"), c.var.caller, "cancel"),
);
app.get(DEVICES_PATH, userAuth(), async (c) => {
  try {
    return Response.json(
      await c.env.OWNER_GATES.getByName(c.var.caller.ownerId).devices(),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    log("error", "owner_devices_failed", {
      requestId: c.var.requestId,
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
});

// Placement and turn starts accept the service secret as well as a user JWT,
// so they authenticate inside their handlers and sit above the gate.
app.post(DISPATCH_SUBMIT_PATH, (c) =>
  handleDispatchSubmitRoute(c.req.raw, c.env, c.var.requestId),
);
// Dispatch ids carry a colon (`dsp:<uuid>`), and every client builds this
// path with `encodeURIComponent`, so the segment arrives as `dsp%3A…`. The
// class admits the escape; the param arrives decoded.
const DISPATCH_ID = "[A-Za-z0-9._:~%-]{1,96}";
app.get(`${DISPATCH_SUBMIT_PATH}/:dispatchId{${DISPATCH_ID}}`, (c) =>
  handleDispatchControlRoute(c.req.raw, c.env, c.req.param("dispatchId"), "status", c.var.requestId),
);
app.post(`${DISPATCH_SUBMIT_PATH}/:dispatchId{${DISPATCH_ID}}/cancel`, (c) =>
  handleDispatchControlRoute(c.req.raw, c.env, c.req.param("dispatchId"), "cancel", c.var.requestId),
);
app.all(`${DISPATCH_SUBMIT_PATH}/:dispatchId{${DISPATCH_ID}}`, methodNotAllowed());
app.all(`${DISPATCH_SUBMIT_PATH}/:dispatchId{${DISPATCH_ID}}/cancel`, methodNotAllowed());

app.all("/conversations/:id/socket", socketOnly, userAuth({ socket: true }), (c) =>
  forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/socket", c.var.caller),
);
app.post("/conversations/:id/turns", (c) =>
  handleTurnStartRoute(c.req.raw, c.env, c.req.param("id"), c.var.requestId),
);
app.get("/conversations/:id/history", userAuth(), (c) =>
  forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/history", c.var.caller),
);
app.post("/conversations/:id/history/query", userAuth(), jsonBody(tinyControl), (c) =>
  forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/history/query", c.var.caller),
);
// A computer's compaction, as the conversation's checkpoint for every host.
app.post(
  `/conversations/:id${JOURNAL_CHECKPOINT_PATH}`,
  userAuth(),
  jsonBody(JOURNAL_CHECKPOINT_SUMMARY_MAX_BYTES + 4096),
  (c) => forwardToConversation(c.req.raw, c.env, c.req.param("id"), JOURNAL_CHECKPOINT_PATH, c.var.caller),
);
// Where the conversation's Stella runs, read and moved by the owner's devices.
app.get("/conversations/:id/pi-brain", userAuth(), (c) =>
  forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/pi-brain", c.var.caller),
);
app.post("/conversations/:id/pi-brain", userAuth(), jsonBody(tinyControl), (c) =>
  forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/pi-brain", c.var.caller),
);
// A computer's own conversation whose tools it moved to the cloud: a call in
// the container the conversation's object holds for it, or its release.
app.post(
  "/conversations/:id/pi-workspace",
  userAuth(),
  jsonBody(DEVICE_TOOL_LIMITS.callBytes + 4096),
  (c) => forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/pi-workspace", c.var.caller),
);
app.post(
  "/conversations/:id/journal",
  userAuth(),
  jsonBody(CLOUD_BUILDER_BODY_LIMITS.conversationAppend),
  (c) => forwardToConversation(c.req.raw, c.env, c.req.param("id"), "/journal", c.var.caller),
);
const localTurn = (operation: "begin" | "finish", maxBytes: number) => {
  app.post(`/conversations/:id/local-turns/${operation}`, async (c) => {
    const timingStartedAt = performance.now();
    const auth = await authenticateConversationCaller(
      c.req.raw,
      c.env,
      false,
      c.var.requestId,
    );
    if (!auth.ok) return auth.response;
    const authMs = Math.round(performance.now() - timingStartedAt);
    const bounded = await boundedIngressRequest(c.req.raw, maxBytes);
    if (bounded instanceof Response) return bounded;
    const forwardStartedAt = performance.now();
    const response = await forwardToConversation(
      bounded,
      c.env,
      c.req.param("id"),
      `/local-turns/${operation}`,
      auth.caller,
    );
    log("info", "conversation_local_turn_request_timing", {
      requestId: c.var.requestId,
      operation,
      status: response.status,
      authMs,
      durableObjectMs: Math.round(performance.now() - forwardStartedAt),
      totalMs: Math.round(performance.now() - timingStartedAt),
    });
    return response;
  });
};
localTurn("begin", CLOUD_BUILDER_BODY_LIMITS.localTurnBegin);
localTurn("finish", CLOUD_BUILDER_BODY_LIMITS.localTurnFinish);

app.all("/cloud-home/:rest{.*}", userAuth(), async (c, next) => {
  const response = await handleUserCloudHomeRoute({
    request: c.req.raw,
    env: c.env,
    ownerId: c.var.caller.ownerId,
    withLease: cloudHomeLeaseRunner(c.env),
  });
  if (response) return response;
  await next();
});

// Sandbox-originated broker calls authenticate with their one-time capability
// inside the exact BuildSession. They intentionally sit above the
// service-secret gate; no other route shares this exception.
app.all(`/sessions/:sessionId{${BROKER_SESSION_ID}}/turn-broker`, async (c) => {
  const brokerSessionId = c.req.param("sessionId");
  const request = c.req.raw;
  // A pi agent's container presents `pi:<conversation>`: its broker is that
  // conversation's orchestrator object, which holds the agent's lease.
  const piConversation = /^pi(?::|%3[Aa])([A-Za-z0-9._~-]{1,128})$/u.exec(brokerSessionId)?.[1];
  const response = piConversation
    ? await c.env.ORCHESTRATOR_SESSIONS.getByName(piConversation).fetch(
        new Request("https://orchestrator-session/pi-turn-broker", request),
      )
    : await c.env.BUILD_SESSIONS.getByName(brokerSessionId).fetch(
        new Request("https://build-session/turn-broker", request),
      );
  if (devAcceptanceProbesEnabled(c.env)) {
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
});

// ── Service-secret gate ───────────────────────────────────────────────────
// Everything past this point is server-to-server. Nothing may be registered
// below it without the gate in front.

app.use(serviceSecret);

// Exact placement turn + cancellation identity must survive the gateway.
// Dropping this body regresses to conversation-wide Stop and can cancel a
// newer turn after a delayed retry.
app.post("/conversations/:id/cancel", jsonBody(tinyControl), (c) =>
  forwardBody(
    c.env.ORCHESTRATOR_SESSIONS.getByName(c.req.param("id")),
    "https://orchestrator-session/cancel",
    c.req.raw,
  ),
);
app.post(
  "/internal/dev-acceptance/conversations/:id/probe",
  jsonBody(tinyControl),
  (c) => {
    // Hidden unless this exact deployment was built as a non-production
    // acceptance target. The DO repeats this gate and checks the disposable
    // owner/conversation markers before any side effect.
    if (!devAcceptanceProbesEnabled(c.env)) return json({ error: "Not found." }, 404);
    return forwardBody(
      c.env.ORCHESTRATOR_SESSIONS.getByName(c.req.param("id")),
      "https://orchestrator-session/internal/dev-acceptance/probe",
      c.req.raw,
      { "x-stella-acceptance-service-secret": c.env.BUILDER_SERVICE_SECRET },
    );
  },
);
// The journal probe reads the canonical journal exactly the way a client
// does, including through R2 segments.
app.get("/conversations/:id/journal", (c) => {
  const probe = new URL("https://orchestrator-session/journal");
  probe.search = new URL(c.req.url).search;
  return c.env.ORCHESTRATOR_SESSIONS.getByName(c.req.param("id")).fetch(
    probe.toString(),
    { method: "GET" },
  );
});
app.post("/sessions/:sessionId/cancel", jsonBody(tinyControl), (c) =>
  forwardBody(
    c.env.BUILD_SESSIONS.getByName(c.req.param("sessionId")),
    "https://build-session/cancel",
    c.req.raw,
  ),
);
// Operator surface for a thread stuck "running": expire its watchdog now.
// The DO interrupts a hung local fiber and re-arms its alarm so the ordinary
// timeout path delivers the terminal while the container's teardown stays
// alarm-owned debt.
app.post("/sessions/:sessionId/expire", jsonBody(tinyControl), (c) =>
  forwardBody(
    c.env.BUILD_SESSIONS.getByName(c.req.param("sessionId")),
    "https://build-session/expire-agent-turn",
    c.req.raw,
  ),
);
// Operator surface for a container the inventory says is live but no Durable
// Object still owns. Wrangler cannot stop one instance and only the sandbox
// object holds the container handle, so retirement is a keep-alive release
// plus destroy on the exact tuple, by name.
app.post("/internal/sandboxes/retire", jsonBody(tinyControl), (c) =>
  retireSandboxInstance(c.env, c.req.raw),
);

app.notFound(() => json({ error: "Not found." }, 404));
// Uncaught errors leave the Worker as they always have, so the runtime's
// exception reporting still sees them.
app.onError((error) => {
  throw error;
});

export const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withBrowserCors(request, async () => await app.fetch(request, env, ctx), env);
  },
  async scheduled(controller, env, ctx) {
    const { runScheduled } = await import("../cron.js");
    await runScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
