import { sha256Hex } from "./hash.js";

/**
 * Deliberately narrow, dev-only controls used by the impartial acceptance run.
 *
 * The service secret remains the authentication boundary. These checks are a
 * second, fail-closed scope fence: even a correctly authenticated internal
 * caller cannot point a probe at a normal user's conversation, a production
 * deployment, or an unmarked run.
 */
export const DEV_ACCEPTANCE_PROBE_VERSION = 1 as const;
export const DEV_ACCEPTANCE_PROBE_STATE_KEY = "devAcceptanceProbeState:v1";
export const DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY =
  "devAcceptanceProviderDispatchCount:v1";
export const DEV_ACCEPTANCE_CONVERSATION_TITLE_PREFIX =
  "stella-cloud-acceptance:";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NON_PRODUCTION_DEPLOYMENT_PATTERN = /^(?:dev|preview|staging|local):/u;

export type DevAcceptanceProbeEnvironment = {
  BUILDER_SERVICE_SECRET?: string;
  ENABLE_DEV_ACCEPTANCE_PROBES?: string;
  STELLA_DEPLOYMENT_IDENTITY?: string;
};

export type DevAcceptanceFault = "canonical_prompt" | "canonical_history";
export type DevAcceptanceProbeOperation = "status" | "self_abort" | "arm_fault";

export type DevAcceptanceProbeRequest = {
  version: typeof DEV_ACCEPTANCE_PROBE_VERSION;
  operation: DevAcceptanceProbeOperation;
  runId: string;
  requestId: string;
  ownerId: string;
  ownerGeneration: string;
  acceptanceOwnerMarkerSha256: string;
  fault?: DevAcceptanceFault;
};

export type DevAcceptanceProbeMeta = {
  ownerId: string;
  ownerGeneration?: string;
  conversationId: string;
  title: string;
};

export type DevAcceptanceProbeReceipt = {
  requestIdSha256: string;
  fingerprintSha256: string;
  operation: DevAcceptanceProbeOperation;
  createdAt: number;
};

export type DevAcceptanceProbeState = {
  version: typeof DEV_ACCEPTANCE_PROBE_VERSION;
  runIdSha256: string;
  ownerIdSha256: string;
  conversationIdSha256: string;
  receipts: DevAcceptanceProbeReceipt[];
  promptFaultArmed?: boolean;
  /** Each typed destructive fault may be armed at most once per run. */
  usedFaults?: DevAcceptanceFault[];
};

export type DevAcceptanceProbeAuthorization =
  | {
      ok: true;
      request: DevAcceptanceProbeRequest;
      runIdSha256: string;
      ownerIdSha256: string;
      conversationIdSha256: string;
      requestIdSha256: string;
      fingerprintSha256: string;
    }
  | { ok: false; status: 404 | 409; code: string };

const exactKeys = (value: Record<string, unknown>): boolean => {
  const allowed = new Set([
    "version",
    "operation",
    "runId",
    "requestId",
    "ownerId",
    "ownerGeneration",
    "acceptanceOwnerMarkerSha256",
    "fault",
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
};

const boundedString = (value: unknown, maximum = 512): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};

export const acceptanceConversationTitle = (runId: string): string =>
  `${DEV_ACCEPTANCE_CONVERSATION_TITLE_PREFIX}${runId}`;

export const acceptanceOwnerMarkerSha256 = async (
  runId: string,
  ownerId: string,
): Promise<string> =>
  sha256Hex(`stella-cloud-acceptance-owner-v1\n${runId}\n${ownerId}`);

export const parseDevAcceptanceProbeRequest = (
  value: unknown,
): DevAcceptanceProbeRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input) || input.version !== DEV_ACCEPTANCE_PROBE_VERSION) {
    return null;
  }
  const operation = input.operation;
  if (
    operation !== "status" &&
    operation !== "self_abort" &&
    operation !== "arm_fault"
  ) {
    return null;
  }
  const runId = boundedString(input.runId, 64);
  const requestId = boundedString(input.requestId, 160);
  const ownerId = boundedString(input.ownerId);
  const ownerGeneration = boundedString(input.ownerGeneration);
  const acceptanceOwnerMarker = boundedString(
    input.acceptanceOwnerMarkerSha256,
    64,
  );
  if (
    !runId ||
    !UUID_PATTERN.test(runId) ||
    !requestId ||
    !BOUNDED_ID_PATTERN.test(requestId) ||
    !ownerId ||
    !ownerGeneration ||
    !acceptanceOwnerMarker ||
    !SHA256_PATTERN.test(acceptanceOwnerMarker)
  ) {
    return null;
  }
  const fault = input.fault;
  if (
    operation === "arm_fault" &&
    fault !== "canonical_prompt" &&
    fault !== "canonical_history"
  ) {
    return null;
  }
  if (operation !== "arm_fault" && fault !== undefined) return null;
  return {
    version: DEV_ACCEPTANCE_PROBE_VERSION,
    operation,
    runId,
    requestId,
    ownerId,
    ownerGeneration,
    acceptanceOwnerMarkerSha256: acceptanceOwnerMarker,
    ...(operation === "arm_fault" ? { fault } : {}),
  } as DevAcceptanceProbeRequest;
};

export const devAcceptanceProbesEnabled = (
  env: DevAcceptanceProbeEnvironment,
): boolean => {
  const deploymentIdentity = env.STELLA_DEPLOYMENT_IDENTITY?.trim() ?? "";
  return (
    env.ENABLE_DEV_ACCEPTANCE_PROBES === "1" &&
    NON_PRODUCTION_DEPLOYMENT_PATTERN.test(deploymentIdentity) &&
    !/prod(?:uction)?/iu.test(deploymentIdentity)
  );
};

const sameSecret = (left: string, right: string): boolean => {
  if (left.length !== right.length || left.length === 0) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
};

export const authorizeDevAcceptanceProbe = async (args: {
  env: DevAcceptanceProbeEnvironment;
  suppliedServiceSecret: string | null;
  body: unknown;
  meta: DevAcceptanceProbeMeta;
}): Promise<DevAcceptanceProbeAuthorization> => {
  if (!devAcceptanceProbesEnabled(args.env)) {
    return { ok: false, status: 404, code: "probe_disabled" };
  }
  const expectedSecret = args.env.BUILDER_SERVICE_SECRET?.trim() ?? "";
  if (!sameSecret(args.suppliedServiceSecret ?? "", expectedSecret)) {
    return { ok: false, status: 404, code: "probe_not_found" };
  }
  const request = parseDevAcceptanceProbeRequest(args.body);
  if (!request) {
    return { ok: false, status: 404, code: "probe_not_found" };
  }
  const expectedMarker = await acceptanceOwnerMarkerSha256(
    request.runId,
    request.ownerId,
  );
  if (
    request.acceptanceOwnerMarkerSha256 !== expectedMarker ||
    args.meta.ownerId !== request.ownerId ||
    args.meta.ownerGeneration !== request.ownerGeneration ||
    args.meta.title !== acceptanceConversationTitle(request.runId) ||
    !args.meta.conversationId
  ) {
    return { ok: false, status: 404, code: "probe_scope_mismatch" };
  }
  const [runIdSha256, ownerIdSha256, conversationIdSha256, requestIdSha256] =
    await Promise.all([
      sha256Hex(request.runId),
      sha256Hex(request.ownerId),
      sha256Hex(args.meta.conversationId),
      sha256Hex(request.requestId),
    ]);
  const fingerprintSha256 = await sha256Hex(
    JSON.stringify({
      version: request.version,
      operation: request.operation,
      fault: request.fault ?? null,
      runIdSha256,
      ownerIdSha256,
      conversationIdSha256,
    }),
  );
  return {
    ok: true,
    request,
    runIdSha256,
    ownerIdSha256,
    conversationIdSha256,
    requestIdSha256,
    fingerprintSha256,
  };
};

const MAX_RECEIPTS = 64;

export const recordDevAcceptanceProbeReceipt = (args: {
  current: DevAcceptanceProbeState | undefined;
  authorization: Extract<DevAcceptanceProbeAuthorization, { ok: true }>;
  now: number;
}):
  | { status: "recorded"; state: DevAcceptanceProbeState }
  | { status: "replayed"; state: DevAcceptanceProbeState }
  | { status: "conflict" } => {
  const { authorization } = args;
  const current = args.current;
  if (
    current &&
    (current.version !== DEV_ACCEPTANCE_PROBE_VERSION ||
      current.runIdSha256 !== authorization.runIdSha256 ||
      current.ownerIdSha256 !== authorization.ownerIdSha256 ||
      current.conversationIdSha256 !== authorization.conversationIdSha256)
  ) {
    return { status: "conflict" };
  }
  const state: DevAcceptanceProbeState = current
    ? { ...current, receipts: [...current.receipts] }
    : {
        version: DEV_ACCEPTANCE_PROBE_VERSION,
        runIdSha256: authorization.runIdSha256,
        ownerIdSha256: authorization.ownerIdSha256,
        conversationIdSha256: authorization.conversationIdSha256,
        receipts: [],
      };
  const replay = state.receipts.find(
    (entry) => entry.requestIdSha256 === authorization.requestIdSha256,
  );
  if (replay) {
    return replay.fingerprintSha256 === authorization.fingerprintSha256
      ? { status: "replayed", state }
      : { status: "conflict" };
  }
  state.receipts.push({
    requestIdSha256: authorization.requestIdSha256,
    fingerprintSha256: authorization.fingerprintSha256,
    operation: authorization.request.operation,
    createdAt: args.now,
  });
  if (state.receipts.length > MAX_RECEIPTS) {
    state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS);
  }
  return { status: "recorded", state };
};
