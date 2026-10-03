import {
  mintWorkspaceAppAccess,
  serveWorkspaceApp,
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

import { GATEWAY_NETWORK_POLICY } from "@stella/contracts/gateway/api";
import { TURN_BROKER_HEADERS } from "@stella/contracts/turn-credential-broker";
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
import { classifyNetwork } from "../../../shared/network-class.js";
import { verifyUserToken } from "../auth-jwt.js";
import { noteOwnerIdentity } from "../owner-identity.js";
import { readBoundedRequestText } from "../bounded-body.js";
import { withBrowserCors } from "../browser-cors.js";
import { handleVoiceRoute, ownerDictationControl } from "../voice/routes.js";
import { handleBackendRoute } from "../owner-store/routes.js";
import { handleMediaRoute } from "../media/routes.js";
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
  publicJsonBodyLimit,
  serviceJsonBodyLimit,
} from "../request-ingress.js";
import { verifyServiceBearerRequest } from "../service-bearer.js";
import { handleBillingRoute } from "../billing/routes.js";
import { handleAdminRoute } from "../admin/routes.js";
import { handleStellaModelsRoute } from "../catalog/models.js";
import { handleDevicesRoute } from "../devices/routes.js";
import { validateTurnBrokerTarget } from "../turn-credential-broker.js";
import type { TurnAuthKind } from "../turn-start-request.js";
import {
  HEADER_TURN_AUTH_KIND,
  parseCloudAgentTurnStartRequest,
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
  conversationName,
  HEADER_BUILD_SESSION_NAME,
  HEADER_CONVERSATION_ID,
  HEADER_PREVIEW_BASE_URL,
  HEADER_TURN_BROKER_ENDPOINT,
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
      path: url.pathname.startsWith("/workspace-apps/")
        ? "/workspace-apps/[session]"
        : previewSafeRequestLogPath(url.pathname),
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
    if (request.method === "GET" && url.pathname === STELLA_PROMPTS_PATH) {
      return stellaPromptsResponse(request);
    }
    // Identity: Better Auth, loaded on first use to keep it off other wakes.
    if (url.pathname.startsWith("/api/auth/")) {
      const { handleAuthRoute } = await import("../auth/routes.js");
      return await handleAuthRoute(request, env);
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

    if (url.pathname.startsWith("/workspace-apps/"))
      return await serveWorkspaceApp(request, env);
    if (
      url.pathname === "/owners/me/apps" ||
      /^\/owners\/me\/apps\/[a-z][a-z0-9-]{0,31}\/session$/.test(url.pathname)
    ) {
      if (
        request.method !== (url.pathname === "/owners/me/apps" ? "GET" : "POST")
      )
        return json({ error: "Method not allowed" }, 405);
      const auth = await authenticateConversationCaller(
        request,
        env,
        false,
        requestId,
      );
      if (!auth.ok) return auth.response;
      const world = env.WORLDS.getByName(await worldName(auth.caller.ownerId));
      const generation = await ownerAccess(env, auth.caller.ownerId);
      const apps = await cloudHomeLeaseRunner(env)(
        auth.caller.ownerId,
        generation,
        `apps:${requestId}`,
        async (assertActive) => {
          await assertActive();
          return world.listWorkspaceApps();
        },
      );
      if (url.pathname === "/owners/me/apps" && request.method === "GET")
        return json({ apps });
      const slug = url.pathname.split("/")[4]!;
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405);
      if (!apps.some((app) => app.slug === slug && app.status === "ready"))
        return json({ error: "App not found" }, 404);
      return json(await mintWorkspaceAppAccess(env, auth.caller.ownerId, slug));
    }

    // ── User-authenticated routes ─────────────────────────────────────────
    // These MUST stay above the service-secret gate below: a signed-in user
    // presents a user JWT, not the shared secret, so matching them after the
    // gate would 401 every client. Both verify the JWT themselves and forward
    // the proven identity to the DO in x-stella-* headers, stripping whatever
    // the client sent under those names first.
    const backendResponse = await handleBackendRoute(request, env);
    if (backendResponse) return backendResponse;
    // Public: the model catalog (an optional bearer picks the audience).
    const modelsResponse = await handleStellaModelsRoute(request, env);
    if (modelsResponse) return modelsResponse;
    // Managed media and music; fal's webhook carries its own signed token.
    const mediaResponse = await handleMediaRoute(request, env);
    if (mediaResponse) return mediaResponse;
    // GitHub App: the install callback carries a signed state, the webhook
    // GitHub's own signature.
    const projectsResponse = await handleProjectsRoute(request, env);
    if (projectsResponse) return projectsResponse;
    // Public: upstream read access for callers without an account.
    const bootstrapResponse = await handleAppSourceBootstrap(request, env);
    if (bootstrapResponse) return bootstrapResponse;
    // Owner-uploaded browser renderers (signed-in PUT, public GET).
    const webRendererResponse = await handleWebRendererRoute(request, env, (promise) => ctx.waitUntil(promise));
    if (webRendererResponse) return webRendererResponse;
    // Stripe signs its webhooks; the internal billing routes check the
    // service secret themselves.
    const billingResponse = await handleBillingRoute(request, env);
    if (billingResponse) return billingResponse;
    // Operator routes check STELLA_ADMIN_API_SECRET themselves.
    const adminResponse = await handleAdminRoute(request, env);
    if (adminResponse) return adminResponse;
    const devicesResponse = await handleDevicesRoute(request, env);
    if (devicesResponse) return devicesResponse;
    // Voice checks the user's JWT itself; the HLS GETs carry a signed ticket.
    const voiceResponse = await handleVoiceRoute(request, env);
    if (voiceResponse) return voiceResponse;
    // Store integrations and X check the user's JWT (or the admin secret)
    // themselves; X's OAuth callback carries a signed state.
    const integrationsResponse = await handleIntegrationsRoute(request, env);
    if (integrationsResponse) return integrationsResponse;
    if (url.pathname === "/dictation/socket") {
      if (request.method !== "GET" || !isWebSocketUpgrade(request)) {
        return json({ error: "This endpoint speaks WebSocket only." }, 426);
      }
      const receivedAt = Date.now();
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
        control: ownerDictationControl(env, auth.caller.ownerId),
        waitUntil: (promise) => ctx.waitUntil(promise),
        timing: { requestId, receivedAt, authMs: Date.now() - receivedAt },
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
    const historyQueryMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/history\/query$/,
    );
    if (request.method === "POST" && historyQueryMatch) {
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
        conversationName(historyQueryMatch[1]!),
        "/history/query",
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
        // `ownerId` is the JWT `sub`; the raw JWT `sub` is
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
      // The desktop dispatch, execution placement's agent branch and a
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
    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;

export const worker = {
  ...router,
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withBrowserCors(request, () => router.fetch(request, env, ctx));
  },
  async scheduled(controller, env, ctx) {
    const { runScheduled } = await import("../cron.js");
    await runScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
