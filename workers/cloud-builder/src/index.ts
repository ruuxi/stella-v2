import { DurableObject } from "cloudflare:workers";
import {
  getSandbox,
  Sandbox as SandboxBase,
  type DirectoryBackup,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { OrchestratorSession } from "./orchestrator-session.js";
import { sha256BytesHex, sha256Hex } from "./hash.js";
import {
  checkpointBackupName,
  checkpointKey,
  instanceSizeKey,
  resolveWorkspace,
} from "./workspace.js";
import {
  INSTANCE_TIERS,
  asInstanceSize,
  initialInstanceSize,
  isOutOfMemoryFailure,
  type InstanceSize,
} from "./instance-size.js";
// Side-effect import: this is what registers the socket implementation with
// the conversation DO. Without it the DO falls back to NullConversationHub and
// every non-socket behaviour keeps working — which is the intended revert.
import "./conversation-hub.js";
import {
  HEADER_ISSUER,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  SUBPROTOCOL,
  isWebSocketUpgrade,
  refuseUpgrade,
  stripStellaHeaders,
  tokenFromSubprotocol,
} from "./conversation-hub.js";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_INTERNAL,
  CLOSE_UNAUTHENTICATED,
} from "./conversation-types.js";
import { verifyConvexToken } from "./auth-jwt.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

export { Sandbox } from "@cloudflare/sandbox";
export { OrchestratorSession };

/**
 * The small rung of the instance ladder. Container size is declared per class
 * in wrangler.jsonc and cannot be chosen per request, so a second class over
 * the same image is the only way to run a cheap turn cheaply. Behaviorally
 * identical to `Sandbox`.
 */
export class SandboxSmall extends SandboxBase<Env> {}

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  // Optional: a deployment without the binding runs every turn on `Sandbox`,
  // which is exactly the pre-ladder behavior.
  SANDBOX_SMALL?: DurableObjectNamespace<SandboxType>;
  BUILD_SESSIONS: DurableObjectNamespace<BuildSession>;
  ORCHESTRATOR_SESSIONS: DurableObjectNamespace<OrchestratorSession>;
  APP_BUILDS: R2Bucket;
  APP_ROUTES: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  AGENT_HOME?: R2Bucket;
  // Rolled-over conversation segments and oversize-row spills. The DO reads it
  // through its own Env; this worker needs it only for the owner-level sweep
  // at `POST /owners/purge`.
  CONVERSATION_ARCHIVE?: R2Bucket;
  BUILDER_SERVICE_SECRET: string;
  TURN_TIMEOUT_MS: string;
  SANDBOX_IDLE_TIMEOUT_MS: string;
  APPS_HOST_BASE_URL: string;
  // The Convex site origin. Pinned issuer for every user JWT this worker
  // verifies, and the JWKS base. Optional in the type so a deployment that has
  // not set it fails closed on the socket routes instead of failing to boot —
  // but the socket surface is dead until it is present.
  STELLA_CONVEX_SITE_URL?: string;
  STELLA_CONVEX_CLOUD_URL?: string;
};

/**
 * Clone credentials for a `project:` workspace, fetched fresh at turn start.
 * The token is a short-lived GitHub App installation token and is held in a
 * local for the length of one attempt: never a log line, never DO storage,
 * never an event payload — and never the turn-input file the agent can read
 * (see {@link projectCredentialsPath}).
 */
type ProjectHandoff = {
  remoteUrl: string;
  token?: string;
  defaultBranch: string;
  branch: string;
  setupScript?: string;
  /** Commit identity: the GitHub user who connected the installation. */
  authorName?: string;
  authorEmail?: string;
};

/**
 * Where the installation token is handed to the executor: a one-shot file the
 * executor reads and unlinks before it builds the agent's tool host, so no
 * agent tool ever runs while it exists. It sits above the workspace root
 * (`/workspace/<kind>`) so it is outside the checkpointed directory, and the
 * name is random so nothing can be waiting on a known path.
 *
 * Deliberately not an env var on the exec session: the executor's own
 * environment is inherited by every shell the agent spawns, and `unsetenv`
 * does not scrub `/proc/<pid>/environ`, so an env handoff stays readable for
 * the whole turn — which is the defect this avoids.
 */
const projectCredentialsPath = (): string =>
  `/workspace/.project-credentials-${crypto.randomUUID()}.json`;

/** An error whose message is safe to show the user verbatim. */
class AgentTurnError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "AgentTurnError";
  }
}

type Execution = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type TurnRequest = {
  // "agent" runs a spawned general agent against a persistent workspace;
  // absent/anything else is the legacy app-build turn.
  kind?: string;
  ownerId: string;
  appId: string;
  turnId: string;
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
  autoActivate?: boolean;
  preflightDelayMs?: number;
  watchdogMs?: number;
  conversationId?: string;
  threadId?: string;
  workspace?: string;
  /** Exact immutable route selected by Convex for this turn. */
  execution?: CloudExecutionSelection;
  /** Worker-issued lease. Callers cannot choose this value. */
  ownerPurgeGeneration?: string;
  ownerPurgeLeaseId?: string;
};

type OwnerPurgeMode = "temporary" | "permanent";
type OwnerPurgeFence = {
  generation: string;
  state: "open" | "blocked";
  mode?: OwnerPurgeMode;
  active: Record<
    string,
    {
      leaseId: string;
      sessionId: string;
      turnId: string;
      namespace: "build" | "orchestrator" | "activity";
      role: "run" | "aux" | "orchestrator" | "activity";
      workspace?: string;
    }
  >;
};

class OwnerPurgeFenceError extends Error {
  constructor() {
    super("This owner's cloud activity is being purged.");
    this.name = "OwnerPurgeFenceError";
  }
}

type AgentExecutorResult = {
  ok: boolean;
  finalText?: string;
  error?: string;
  usage?: Record<string, unknown>;
  // Present on `project:` turns: what the executor did with the repository,
  // plus the setup command it had to infer because the project had none.
  project?: {
    mode?: string;
    branch?: string;
    setupCommand?: string;
    setupSource?: string;
  };
};

type InteriorBuildOutput = {
  schemaVersion: 1;
  sourceRevision: string;
  baseRevision?: string;
  upstreamSeedRevision: string;
  outputRoot: string;
  entries: {
    full: "index.html";
    mini: "mini.html";
    overlay: "overlay.html";
    pet: "pet.html";
  };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    contentType: string;
  }>;
  artifactSha256: string;
  size: number;
};

const INTERIOR_BRIDGE_ABI = 1;
const INTERIOR_MIN_SHELL_VERSION = "0.0.0";
const INTERIOR_MAX_FILES = 2_000;
const INTERIOR_MAX_BYTES = 100 * 1024 * 1024;
const INTERIOR_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A terminal state that has been decided but may not have reached Convex yet.
 *
 * It is written to DO storage before the first delivery attempt so the alarm
 * can re-deliver exactly this, unchanged. Without it the success path was the
 * one terminal path with no retry, and it is the one carrying the only copy of
 * the agent's report.
 */
type PendingTerminal = {
  /** Fences a stale payload against a successor turn on the same DO. */
  turnId: string;
  kind: "completed" | "failed" | "canceled";
  /** Optional turn-event kind when the thread status uses a coarser value. */
  eventKind?: "timeout";
  payload: Record<string, unknown>;
  /** Message for the thread's final state; a completed turn sends its report. */
  threadError?: string;
  /**
   * Cancellation is not complete until the sandbox process is gone. This flag
   * makes that requirement durable: if container teardown fails or the DO is
   * evicted mid-cancel, the alarm retries teardown before it delivers the
   * terminal state.
   */
  terminateSandbox?: boolean;
};

type PendingTurnCancel = {
  turnId: string;
  reason: string;
};

type ExecutorResult = {
  ok: true;
  runtimeTools: string[];
  metrics: {
    dependencyHydrationMs: number;
    productionBuildMs: number;
    activeCpuSeconds: number;
    peakMemoryBytes: number;
    workspaceDiskBytes: number;
  };
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const authorized = (request: Request, env: Env): boolean =>
  request.headers.get("authorization") ===
  `Bearer ${env.BUILDER_SERVICE_SECRET}`;

/**
 * The single spelling of a conversation id, used as the Durable Object name.
 *
 * Four callers build these URLs — Convex (raw), the socket client, the runtime
 * journal writer, and the dev probe — and two of them percent-encode. Two
 * spellings of one id would address two DIFFERENT Durable Objects, which is a
 * split-brain no amount of downstream care recovers from. Decoding once here
 * makes every spelling converge; conversation ids are `crypto.randomUUID()`, so
 * decode is the identity for every id that exists today and this only closes
 * the latent case. A segment that is not valid percent-encoding is used as-is
 * rather than throwing — it cannot match a real conversation either way.
 */
const conversationName = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

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

const ORCHESTRATOR_INTERNAL_ORIGIN = "https://orchestrator-session";
const HEADER_CONVERSATION_ID = "x-stella-conversation-id";

type ConversationCaller = {
  ownerId: string;
  subject: string;
  sessionId: string;
  expiresAtMs: number;
  issuer: string;
};

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
  const issuer = (env.STELLA_CONVEX_SITE_URL ?? "").trim().replace(/\/+$/, "");
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

const sessionName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

const contentType = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".map")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
};

const requirePublicOrigin = (
  value: string | undefined,
  label: string,
): string => {
  try {
    const parsed = new URL(value?.trim() ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an HTTPS origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(`${label} must be configured as an HTTPS origin.`);
  }
};

// Stella's editable source is product state, not an ephemeral task cache.
// Cloudflare backups require a positive TTL and default to only three days;
// refresh a ten-year retention window on every successful checkpoint.
const STELLA_SOURCE_BACKUP_TTL_SECONDS = 10 * 365 * 86_400;
const ORDINARY_WORKSPACE_BACKUP_TTL_SECONDS = 30 * 86_400;
/** Longer than the 30s callback timeout; covers an evicted isolate's last send. */
const OWNER_PURGE_STALE_LEASE_GRACE_MS = 35_000;
const backupDebtKey = (workspaceKey: string): string =>
  `${workspaceKey}:backup-debt`;
type WorkspaceBackupDebt = { backupIds: string[] };

export class BuildSession extends DurableObject<Env> {
  private readonly runningTurns = new Map<string, Set<Promise<unknown>>>();

  private trackTurn<T>(turnId: string, work: Promise<T>): Promise<T> {
    const active = this.runningTurns.get(turnId) ?? new Set<Promise<unknown>>();
    const tracked = work.finally(() => {
      active.delete(tracked);
      if (active.size === 0) {
        this.runningTurns.delete(turnId);
      }
    });
    active.add(tracked);
    this.runningTurns.set(turnId, active);
    return tracked;
  }

  private async ownerFence(ownerId: string) {
    const ownerHash = await sha256Hex(ownerId);
    return this.env.BUILD_SESSIONS.getByName(`owner-purge-${ownerHash}`);
  }

  private async callOwnerFence(
    ownerId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return (await this.ownerFence(ownerId)).fetch(
      `https://build-session/owner-fence/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  private async registerTurn(
    turn: TurnRequest,
    freshLease = false,
  ): Promise<string> {
    if (freshLease || !turn.ownerPurgeLeaseId) {
      turn.ownerPurgeLeaseId = crypto.randomUUID();
    }
    const leasedWorkspace =
      !freshLease && turn.kind === "agent"
        ? resolveWorkspace(turn.workspace)?.canonical
        : undefined;
    const response = await this.callOwnerFence(turn.ownerId, "register", {
      leaseId: turn.ownerPurgeLeaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      role: freshLease ? "aux" : "run",
      ...(leasedWorkspace ? { workspace: leasedWorkspace } : {}),
      ...(turn.ownerPurgeGeneration
        ? { generation: turn.ownerPurgeGeneration }
        : {}),
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
    const body = (await response.json()) as { generation?: string };
    if (!body.generation) throw new OwnerPurgeFenceError();
    return body.generation;
  }

  private async unregisterTurn(turn: TurnRequest): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) return;
    const hasTransientWrites =
      Boolean(
        await this.ctx.storage.get<string>(`transientBackup:${turn.turnId}`),
      ) ||
      Boolean(
        await this.ctx.storage.get<string>(`transientBuild:${turn.turnId}`),
      );
    if (hasTransientWrites) {
      try {
        // A callback whose response was lost may already have committed the
        // row that names a build. Preserve it during ordinary operation. Once
        // purge changes the generation, the turn's lease stays active until
        // these otherwise-unnameable bytes are verifiably gone.
        await this.assertTurnWritable(turn);
        return;
      } catch (error) {
        if (!(error instanceof OwnerPurgeFenceError)) return;
        try {
          await this.cleanupTransientWrites(turn);
        } catch (cleanupError) {
          log("error", "owner_purge_transient_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
          return;
        }
      }
    }
    await this.unregisterTurnLease(
      turn,
      turn.ownerPurgeLeaseId,
      turn.ownerPurgeGeneration,
    );
  }

  private async unregisterTurnLease(
    turn: TurnRequest,
    leaseId: string,
    generation: string,
  ): Promise<void> {
    await this.callOwnerFence(turn.ownerId, "unregister", {
      leaseId,
      sessionId: this.ctx.id.toString(),
      turnId: turn.turnId,
      generation,
    }).catch(() => undefined);
  }

  private async appendWorkspaceBackupDebt(
    workspaceKey: string,
    backupId: string,
  ): Promise<void> {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw new Error("Invalid transient workspace backup id.");
    }
    const debtKey = backupDebtKey(workspaceKey);
    const existing = (await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
      debtKey,
      "json",
    )) ?? { backupIds: [] };
    const backupIds = [...new Set([...existing.backupIds, backupId])];
    if (backupIds.length > 100) {
      throw new Error("Workspace backup cleanup debt is too large.");
    }
    await this.env.APP_ROUTES.put(
      debtKey,
      JSON.stringify({ backupIds } satisfies WorkspaceBackupDebt),
    );
  }

  /**
   * Move the only random identifier for an unswept attempt backup out of DO
   * storage before terminal deleteAll(). The workspace debt is durable and is
   * retried by the normal checkpoint/purge sweep paths.
   */
  private async settleAgentTransientBackup(
    turn: TurnRequest,
  ): Promise<boolean> {
    const backupKey = `transientBackup:${turn.turnId}`;
    const workspaceKeyKey = `transientBackupWorkspace:${turn.turnId}`;
    const backupId = await this.ctx.storage.get<string>(backupKey);
    if (!backupId) {
      await this.ctx.storage.delete(workspaceKeyKey);
      return true;
    }
    const workspaceKey = await this.ctx.storage.get<string>(workspaceKeyKey);
    if (!workspaceKey) {
      log("error", "transient_backup_debt_workspace_missing", {
        turnId: turn.turnId,
        backupId,
      });
      return false;
    }
    try {
      await this.appendWorkspaceBackupDebt(workspaceKey, backupId);
      await this.ctx.storage.delete([backupKey, workspaceKeyKey]);
      return true;
    } catch (error) {
      log("error", "transient_backup_debt_persist_failed", {
        turnId: turn.turnId,
        backupId,
        message: errorMessage(error),
      });
      return false;
    }
  }

  private async cleanupTransientWrites(turn: TurnRequest): Promise<void> {
    const backupKey = `transientBackup:${turn.turnId}`;
    const buildKey = `transientBuild:${turn.turnId}`;
    const backupId = await this.ctx.storage.get<string>(backupKey);
    const buildPrefix = await this.ctx.storage.get<string>(buildKey);
    if (backupId) {
      const swept = await sweepR2Prefix(
        this.env.BACKUP_BUCKET,
        `backups/${backupId}/`,
      );
      if (!swept.done)
        throw new Error("Transient backup cleanup was truncated.");
      await this.ctx.storage.delete([
        backupKey,
        `transientBackupWorkspace:${turn.turnId}`,
      ]);
    }
    if (buildPrefix) {
      const swept = await sweepR2Prefix(this.env.APP_BUILDS, `${buildPrefix}/`);
      if (!swept.done)
        throw new Error("Transient build cleanup was truncated.");
      await this.ctx.storage.delete(buildKey);
    }
  }

  private async cancelForOwnerPurge(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      ownerId?: string;
      turnId?: string;
      generation?: string;
      leaseId?: string;
    };
    const stored = await this.ctx.storage.get<TurnRequest>("turn");
    const turnId = body.turnId ?? stored?.turnId;
    const ownerId = body.ownerId ?? stored?.ownerId;
    const generation = body.generation ?? stored?.ownerPurgeGeneration;
    const leaseId = body.leaseId ?? stored?.ownerPurgeLeaseId;
    if (!turnId || !ownerId || !generation || !leaseId) {
      return json({ error: "Owner purge lease identity required." }, 400);
    }
    const turn =
      stored?.turnId === turnId
        ? stored
        : ({
            ownerId,
            turnId,
            ownerPurgeGeneration: generation,
            ownerPurgeLeaseId: leaseId,
          } as TurnRequest);
    turn.ownerPurgeGeneration = generation;
    turn.ownerPurgeLeaseId = leaseId;

    await this.ctx.storage.put("terminal", true);
    await this.ctx.storage.deleteAlarm().catch(() => undefined);
    await (await this.currentSandbox())?.destroy().catch(() => undefined);

    const running = [...(this.runningTurns.get(turnId) ?? [])];
    if (running.length > 0) {
      const settled = await Promise.race([
        Promise.allSettled(running).then(() => true),
        scheduler.wait(OWNER_PURGE_STALE_LEASE_GRACE_MS).then(() => false),
      ]);
      if (!settled) {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
    } else {
      // No promise means this lease was recovered after isolate loss (or the
      // turn ended before clearing its durable registration). An outbound
      // callback dispatched by the old isolate may still be completing.
      const key = `ownerPurgeCancelAt:${leaseId}`;
      const startedAt = (await this.ctx.storage.get<number>(key)) ?? Date.now();
      await this.ctx.storage.put(key, startedAt);
      if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
        return json({ error: "Reconciling stale owner turn lease." }, 409);
      }
      await this.ctx.storage.delete(key);
    }

    await this.cleanupTransientWrites(turn);
    // Do not depend on a vanished run's `finally`: remove the exact durable
    // lease idempotently from the owner fence here.
    await this.callOwnerFence(ownerId, "unregister", {
      leaseId,
      sessionId: this.ctx.id.toString(),
      turnId,
      generation,
    });
    return json({ canceled: true, turnId, unregistered: true });
  }

  private async redeliverOrphan(
    turn: TurnRequest,
    pending: PendingTerminal,
  ): Promise<void> {
    try {
      turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
      await this.assertTurnWritable(turn);
      await this.deliverTerminal(turn, pending);
    } catch (error) {
      if (!(error instanceof OwnerPurgeFenceError)) throw error;
    } finally {
      await this.unregisterTurn(turn);
    }
  }

  private async assertTurnWritable(turn: TurnRequest): Promise<void> {
    if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
      throw new OwnerPurgeFenceError();
    }
    const response = await this.callOwnerFence(turn.ownerId, "assert", {
      generation: turn.ownerPurgeGeneration,
      leaseId: turn.ownerPurgeLeaseId,
    });
    if (!response.ok) throw new OwnerPurgeFenceError();
  }

  private async assertAgentTurnActive(turn: TurnRequest): Promise<void> {
    await this.assertTurnWritable(turn);
    if (
      !(await this.ownsTurn(turn.turnId)) ||
      (await this.ctx.storage.get<boolean>("terminal"))
    ) {
      throw new Error("The agent turn is no longer active.");
    }
  }

  private async ownerFenceFetch(
    path: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as {
      generation?: string;
      leaseId?: string;
      mode?: OwnerPurgeMode;
      sessionId?: string;
      turnId?: string;
      namespace?: "build" | "orchestrator" | "activity";
      role?: "run" | "aux" | "orchestrator" | "activity";
      workspace?: string;
    };
    const current = (await this.ctx.storage.get<OwnerPurgeFence>(
      "ownerPurgeFence",
    )) ?? {
      generation: crypto.randomUUID(),
      state: "open",
      active: {},
    };
    if (path === "register") {
      const workspaceBusy =
        body.role === "run" &&
        body.workspace &&
        Object.values(current.active).some(
          (lease) =>
            lease.role === "run" &&
            lease.workspace === body.workspace &&
            lease.leaseId !== body.leaseId,
        );
      if (
        current.state !== "open" ||
        (body.generation !== undefined &&
          body.generation !== current.generation) ||
        !body.leaseId ||
        !body.sessionId ||
        !body.turnId ||
        workspaceBusy
      ) {
        return json({ error: "Owner purge is active." }, 409);
      }
      current.active[body.leaseId] = {
        leaseId: body.leaseId,
        sessionId: body.sessionId,
        turnId: body.turnId,
        namespace:
          body.namespace === "orchestrator"
            ? "orchestrator"
            : body.namespace === "activity"
              ? "activity"
              : "build",
        role:
          body.role === "run"
            ? "run"
            : body.role === "orchestrator"
              ? "orchestrator"
              : body.role === "activity"
                ? "activity"
                : "aux",
        ...(body.workspace ? { workspace: body.workspace } : {}),
      };
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ generation: current.generation });
    }
    if (path === "unregister") {
      if (
        body.leaseId &&
        body.sessionId &&
        body.turnId &&
        current.active[body.leaseId]?.sessionId === body.sessionId &&
        current.active[body.leaseId]?.turnId === body.turnId
      ) {
        delete current.active[body.leaseId];
        await this.ctx.storage.put("ownerPurgeFence", current);
      }
      return json({ ok: true });
    }
    if (path === "assert") {
      return current.state === "open" &&
        body.generation === current.generation &&
        Boolean(body.leaseId && current.active[body.leaseId])
        ? json({ ok: true })
        : json({ error: "Owner purge fence changed." }, 409);
    }
    if (path === "assert-blocked") {
      return current.state === "blocked" &&
        body.generation === current.generation
        ? json({ ok: true, active: current.active })
        : json({ error: "Owner purge generation is not active." }, 409);
    }
    if (path === "begin") {
      if (current.state === "open") {
        current.generation = crypto.randomUUID();
        current.state = "blocked";
        current.mode = body.mode === "permanent" ? "permanent" : "temporary";
      } else if (body.mode === "permanent") {
        current.mode = "permanent";
      }
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({
        generation: current.generation,
        mode: current.mode,
        active: current.active,
      });
    }
    if (path === "release") {
      if (
        current.state !== "blocked" ||
        current.mode !== "temporary" ||
        body.generation !== current.generation ||
        Object.keys(current.active).length > 0
      ) {
        return json({ error: "Owner purge fence cannot be released." }, 409);
      }
      current.generation = crypto.randomUUID();
      current.state = "open";
      delete current.mode;
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ ok: true, generation: current.generation });
    }
    return json({ error: "Not found." }, 404);
  }

  private sandbox(id: string, size: InstanceSize = "large") {
    const namespace =
      size === "small" && this.env.SANDBOX_SMALL
        ? this.env.SANDBOX_SMALL
        : this.env.Sandbox;
    return getSandbox(namespace, id, {
      transport: "rpc",
      enableDefaultSession: false,
      keepAlive: true,
      normalizeId: true,
      containerTimeouts: {
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 120_000,
      },
      labels: { service: "stella-v2", workload: "app-build" },
    });
  }

  /**
   * The sandbox this DO is currently responsible for. Size matters as much as
   * id: the two container classes are separate namespaces, so destroying by
   * id alone against the wrong one silently leaves a live container behind.
   */
  private async currentSandbox() {
    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    if (!sandboxId) return undefined;
    const size =
      (await this.ctx.storage.get<InstanceSize>("sandboxSize")) ?? "large";
    return this.sandbox(sandboxId, size);
  }

  /**
   * Stop the command session first, then destroy its container. `destroy()` is
   * the authoritative boundary, while the explicit process kill makes a
   * native Claude Code/Codex child stop promptly instead of waiting for the
   * container teardown handshake.
   */
  private async terminateCurrentAgentSandbox(
    turn?: TurnRequest,
  ): Promise<void> {
    const sandbox = await this.currentSandbox();
    if (!sandbox) return;
    if (turn?.kind === "agent") {
      const size =
        (await this.ctx.storage.get<InstanceSize>("sandboxSize")) ?? "large";
      const executionSessionId = sessionName(
        `agent-run-${turn.turnId}-${size}`,
      );
      await sandbox.killAllProcesses(executionSessionId).catch((error) => {
        log("error", "agent_process_kill_failed", {
          turnId: turn.turnId,
          sessionId: executionSessionId,
          message: errorMessage(error),
        });
      });
    }
    await sandbox.destroy();
  }

  /**
   * Build and publish an immutable Stella-interior candidate.
   *
   * The source tree is agent-controlled, so the immutable executor script
   * applies the first set of bounds and this Worker repeats all trust-boundary
   * checks while reading the output. The callback records a candidate only;
   * activation remains an authenticated user/control-plane operation.
   */
  private async publishInteriorCandidate(
    turn: TurnRequest,
    sandbox: ReturnType<BuildSession["sandbox"]>,
    workspaceRoot: string,
    commandTimeoutMs: number,
  ): Promise<{
    buildId: string;
    artifactPrefix: string;
    previewUrl: string;
    digest: string;
    size: number;
    sourceRevision: string;
    baseRevision?: string;
  }> {
    await this.assertAgentTurnActive(turn);
    if (workspaceRoot !== "/workspace/stella" || !turn.threadId) {
      throw new Error("Invalid Stella interior build context.");
    }
    let unrecordedArtifactPrefix: string | undefined;
    let callbackAttempted = false;
    const buildRoot = `/workspace/.stella-interior-build/${sessionName(turn.turnId)}`;
    const outputRoot = `${buildRoot}/dist`;
    const session = await sandbox.createSession({
      id: sessionName(`interior-build-${turn.turnId}`),
      cwd: "/opt/stella",
      commandTimeoutMs,
      env: {
        STELLA_INTERIOR_SOURCE_ROOT: workspaceRoot,
        STELLA_INTERIOR_OUTPUT_ROOT: outputRoot,
        VITE_CONVEX_URL: requirePublicOrigin(
          this.env.STELLA_CONVEX_CLOUD_URL,
          "STELLA_CONVEX_CLOUD_URL",
        ),
        VITE_CONVEX_SITE_URL: requirePublicOrigin(
          this.env.STELLA_CONVEX_SITE_URL,
          "STELLA_CONVEX_SITE_URL",
        ),
        VITE_STELLA_APPS_HOST: requirePublicOrigin(
          this.env.APPS_HOST_BASE_URL,
          "APPS_HOST_BASE_URL",
        ),
        VITE_STELLA_PROTOCOL: "stella",
      },
    });
    try {
      const execution = (await session.exec(
        "bun packages/executor-cloud/src/interior-build.ts",
        { timeout: commandTimeoutMs },
      )) as Execution;
      if (!execution.success) {
        log("error", "interior_build_command_failed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          stderr: execution.stderr.slice(-4_000),
        });
        throw new Error("The Stella interior production build failed.");
      }
      const output = JSON.parse(
        execution.stdout.trim().split("\n").at(-1) ?? "{}",
      ) as InteriorBuildOutput;
      if (
        output.schemaVersion !== 1 ||
        output.outputRoot !== outputRoot ||
        !/^sha256:[0-9a-f]{64}$/.test(output.sourceRevision) ||
        !/^sha256:[0-9a-f]{64}$/.test(output.upstreamSeedRevision) ||
        (output.baseRevision !== undefined &&
          !/^sha256:[0-9a-f]{64}$/.test(output.baseRevision)) ||
        !SHA256_HEX.test(output.artifactSha256) ||
        !Number.isSafeInteger(output.size) ||
        output.size < 0 ||
        output.size > INTERIOR_MAX_BYTES ||
        !Array.isArray(output.files) ||
        output.files.length === 0 ||
        output.files.length > INTERIOR_MAX_FILES ||
        output.entries?.full !== "index.html" ||
        output.entries?.mini !== "mini.html" ||
        output.entries?.overlay !== "overlay.html" ||
        output.entries?.pet !== "pet.html"
      ) {
        throw new Error(
          "The Stella interior builder returned invalid metadata.",
        );
      }

      const paths = new Set<string>();
      const portablePaths = new Set<string>();
      let declaredBytes = 0;
      for (const file of output.files) {
        if (
          typeof file.path !== "string" ||
          !SAFE_ARTIFACT_PATH.test(file.path) ||
          file.path.length > 1_024 ||
          paths.has(file.path) ||
          portablePaths.has(file.path.toLowerCase()) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          file.size > INTERIOR_MAX_FILE_BYTES ||
          !SHA256_HEX.test(file.sha256)
        ) {
          throw new Error(
            "The Stella interior contains invalid artifact metadata.",
          );
        }
        paths.add(file.path);
        portablePaths.add(file.path.toLowerCase());
        declaredBytes += file.size;
        if (declaredBytes > INTERIOR_MAX_BYTES) {
          throw new Error("The Stella interior artifact is too large.");
        }
        const expectedContentType = contentType(file.path);
        if (file.contentType !== expectedContentType) {
          throw new Error(
            "The Stella interior content type manifest is invalid.",
          );
        }
      }
      const aggregateSource = JSON.stringify(
        output.files.map((file) => ({
          path: file.path,
          size: file.size,
          sha256: file.sha256,
        })),
      );
      if (
        declaredBytes !== output.size ||
        (await sha256Hex(aggregateSource)) !== output.artifactSha256 ||
        !Object.values(output.entries).every((entry) => paths.has(entry)) ||
        !output.files.some((file) => file.path.startsWith("assets/"))
      ) {
        throw new Error("The Stella interior artifact digest is invalid.");
      }

      const ownerHash = await sha256Hex(turn.ownerId);
      const buildId = `interior-${(
        await sha256Hex(
          `${turn.ownerId}\0${turn.turnId}\0${output.artifactSha256}`,
        )
      ).slice(0, 48)}`;
      const artifactPrefix = `interiors/${ownerHash}/${buildId}`;
      unrecordedArtifactPrefix = artifactPrefix;
      await this.ctx.storage.put(
        `transientBuild:${turn.turnId}`,
        artifactPrefix,
      );
      let appsHost: URL;
      try {
        appsHost = new URL(this.env.APPS_HOST_BASE_URL);
      } catch {
        throw new Error("The Stella apps host URL is invalid.");
      }
      if (
        appsHost.protocol !== "https:" ||
        appsHost.username ||
        appsHost.password ||
        appsHost.search ||
        appsHost.hash ||
        appsHost.pathname !== "/"
      ) {
        throw new Error("The Stella apps host URL is invalid.");
      }
      const assetBaseUrl = `${appsHost.origin}/interior-builds/${ownerHash}/${buildId}/`;
      const files = output.files.map((file) => ({
        path: file.path,
        url: `${assetBaseUrl}${file.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
      }));
      const manifest = {
        schemaVersion: 1,
        buildId,
        version: buildId,
        artifactPrefix,
        entries: output.entries,
        files,
        artifactSha256: output.artifactSha256,
        size: output.size,
        bridgeAbi: INTERIOR_BRIDGE_ABI,
        minShellVersion: INTERIOR_MIN_SHELL_VERSION,
      };
      const manifestJson = JSON.stringify(manifest);
      if (new TextEncoder().encode(manifestJson).byteLength > 240 * 1024) {
        throw new Error("The Stella interior artifact manifest is too large.");
      }
      const digest = `sha256:${output.artifactSha256}`;
      const manifestSha256 = `sha256:${await sha256Hex(manifestJson)}`;
      for (const file of output.files) {
        const read = await session.readFile(`${outputRoot}/${file.path}`, {
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(read.content), (char) =>
          char.charCodeAt(0),
        );
        if (
          bytes.byteLength !== file.size ||
          (await sha256BytesHex(bytes)) !== file.sha256
        ) {
          throw new Error(
            `Interior artifact changed while reading ${file.path}.`,
          );
        }
        await this.assertAgentTurnActive(turn);
        const objectKey = `${artifactPrefix}/${file.path}`;
        await this.env.APP_BUILDS.put(objectKey, bytes, {
          httpMetadata: {
            contentType: file.contentType,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: {
            buildId,
            ownerHash,
            kind: "stella-interior",
          },
        });
        try {
          await this.assertAgentTurnActive(turn);
        } catch (error) {
          await this.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
          throw error;
        }
      }

      // Re-check the DO fence after the expensive build/upload and before the
      // only durable control-plane effect. Uploaded bytes are immutable and
      // harmless if a successor won; no candidate row points to them.
      if (
        !(await this.ownsTurn(turn.turnId)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        throw new Error("The Stella interior turn was superseded.");
      }
      // Once the callback starts, a transport error is ambiguous: Convex may
      // have committed the immutable row before the response was lost. Keep
      // those bytes for bounded idempotent callback retries. Before this point
      // (partial upload, validation failure, or superseded turn), no row can
      // exist, so the prefix is safe to remove immediately.
      const callbackBody = {
        ownerId: turn.ownerId,
        buildId,
        turnId: turn.turnId,
        threadId: turn.threadId,
        ...(output.baseRevision ? { baseRevision: output.baseRevision } : {}),
        sourceRevision: output.sourceRevision,
        artifactPrefix,
        manifestJson,
        manifestSha256,
        digest,
        size: output.size,
        bridgeAbi: INTERIOR_BRIDGE_ABI,
        minShellVersion: INTERIOR_MIN_SHELL_VERSION,
      };
      callbackAttempted = true;
      let callbackSucceeded = false;
      let callbackError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.callback(turn, "/api/cloud/interior-builds", callbackBody);
          callbackSucceeded = true;
          break;
        } catch (error) {
          callbackError = error;
          if (attempt < 2) {
            await new Promise((resolve) =>
              setTimeout(resolve, 500 * 2 ** attempt),
            );
          }
        }
      }
      if (!callbackSucceeded) {
        throw callbackError instanceof Error
          ? callbackError
          : new Error("Stella interior candidate callback failed.");
      }
      await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);

      // This builder-owned state is checkpointed with the source but excluded
      // from the next source digest. It supplies the next candidate's explicit
      // baseRevision, including across sandbox destruction/restoration.
      await session.writeFile(
        `${workspaceRoot}/.stella/interior-source.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          sourceRevision: output.sourceRevision,
          upstreamSeedRevision: output.upstreamSeedRevision,
          buildId,
        })}\n`,
      );
      return {
        buildId,
        artifactPrefix,
        previewUrl: assetBaseUrl,
        digest,
        size: output.size,
        sourceRevision: output.sourceRevision,
        ...(output.baseRevision ? { baseRevision: output.baseRevision } : {}),
      };
    } catch (error) {
      if (unrecordedArtifactPrefix && !callbackAttempted) {
        const cleaned = await sweepR2Prefix(
          this.env.APP_BUILDS,
          `${unrecordedArtifactPrefix}/`,
        ).catch((cleanupError) => {
          log("error", "interior_orphan_cleanup_failed", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            artifactPrefix: unrecordedArtifactPrefix,
            message: errorMessage(cleanupError),
          });
          return undefined;
        });
        if (cleaned?.done) {
          await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);
        }
      }
      throw error;
    } finally {
      await session
        .exec("rm -rf /workspace/.stella-interior-build")
        .catch(() => undefined);
      await sandbox.deleteSession(session.id).catch(() => undefined);
    }
  }

  private async callback(
    turn: TurnRequest,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    await this.assertTurnWritable(turn);
    const response = await fetch(
      `${turn.convexCallbackBase.replace(/\/+$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Convex callback ${path} failed with ${response.status}.`,
      );
    }
    await this.assertTurnWritable(turn);
    return response
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
  }

  // The detached agent-turn promise and the alarm share this DO's storage;
  // a stale turn (superseded by a send_input continuation on the same
  // thread) must never mutate the successor's state or complete its thread.
  private async ownsTurn(turnId: string): Promise<boolean> {
    return (await this.ctx.storage.get<string>("turnId")) === turnId;
  }

  private event(
    turn: TurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
  ) {
    return this.callback(turn, "/api/cloud/events", {
      turnId: turn.turnId,
      sessionId: turn.threadId ?? this.ctx.id.toString(),
      seq,
      kind,
      payload,
      terminal,
    });
  }

  /**
   * Atomically claim this DO's one terminal decision. Cancel, timeout and the
   * normal process unwind are separate async paths; a read-then-write fence
   * lets the loser overwrite the winner between awaits.
   */
  private async claimTerminalDecision(
    turn: TurnRequest,
    pending: PendingTerminal,
  ): Promise<boolean> {
    return await this.ctx.storage.transaction(async (txn) => {
      const [currentTurnId, terminalAlreadyDecided, decided] =
        await Promise.all([
          txn.get<string>("turnId"),
          txn.get<boolean>("terminal"),
          txn.get<PendingTerminal>("pendingTerminal"),
        ]);
      if (currentTurnId !== turn.turnId) return false;
      if (
        terminalAlreadyDecided &&
        (!decided ||
          decided.turnId !== pending.turnId ||
          decided.kind !== pending.kind ||
          decided.eventKind !== pending.eventKind)
      ) {
        return false;
      }
      await txn.put({
        terminal: true,
        pendingTerminal: pending,
        alarmAttempts: 0,
      });
      return true;
    });
  }

  /**
   * Decide a turn's terminal state and get it to Convex, durably.
   *
   * Delivery is two callbacks — the terminal event, then the thread's final
   * state — and either can fail on a transient Convex 5xx. Both are recorded
   * in DO storage before the first attempt and retried by a re-armed alarm:
   * the success path used to throw straight into the failure handler, which
   * reported "The agent hit a problem and stopped" over a completed,
   * checkpointed turn and discarded the agent's report with it.
   *
   * Redelivery is safe: Convex rejects every event after the first terminal
   * one (answering `terminalAccepted: false` rather than an error) and the
   * thread mutation is a no-op once the thread is terminal, so a retry can
   * never produce a second terminal state.
   *
   * Returns whether the state is known to have landed; storage (and its
   * alarm) must stay intact when it has not.
   */
  private async deliverTerminal(
    turn: TurnRequest,
    pending: PendingTerminal,
  ): Promise<boolean> {
    // Fencing: a stale turn may still deliver its own outcome (Convex sorts
    // out which one is terminal), but it must not write over the successor's
    // storage or arm the successor's alarm.
    const owns = await this.ownsTurn(turn.turnId);
    // The second callback is *thread*-scoped, and the only thing that fences
    // it Convex-side is the thread not being "running" — which a successor
    // continuation has just undone. So a stale payload replayed here (the
    // orphan in acceptAgentTurn) would complete the thread out from under the
    // turn now running on it: the user is told the agent stopped, and the
    // live turn's own report is later dropped as a duplicate. Read the
    // successor once, before either callback, so a mid-delivery takeover
    // cannot flip the decision halfway through.
    const successor = owns
      ? undefined
      : await this.ctx.storage.get<TurnRequest>("turn");
    const supersededThread =
      successor !== undefined &&
      successor.turnId !== turn.turnId &&
      successor.threadId === turn.threadId;
    if (owns) {
      if (!(await this.claimTerminalDecision(turn, pending))) {
        const decided =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        log("info", "terminal_decision_superseded", {
          turnId: turn.turnId,
          attemptedKind: pending.kind,
          decidedKind: decided?.kind,
        });
        return false;
      }
    }
    try {
      // Turn-scoped and unconditional: this is what gives the turn — orphaned
      // or not — its one terminal state, and Convex rejects a second one.
      await this.event(
        turn,
        "auto",
        pending.eventKind ?? pending.kind,
        pending.payload,
        true,
      );
      if (turn.kind === "agent" && turn.threadId) {
        if (supersededThread) {
          log("info", "terminal_thread_completion_skipped", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            kind: pending.kind,
          });
        } else {
          const finalText =
            typeof pending.payload.finalText === "string"
              ? pending.payload.finalText
              : "";
          await this.callback(turn, "/api/cloud/threads/complete", {
            threadId: turn.threadId,
            turnId: turn.turnId,
            status: pending.kind,
            ...(pending.kind === "completed"
              ? { resultJson: JSON.stringify({ finalText }) }
              : { errorMessage: pending.threadError ?? "The agent stopped." }),
          });
        }
      }
      if (owns) {
        await this.ctx.storage.put("terminalDelivered", true);
        await this.ctx.storage.delete("pendingTerminal");
      }
      return true;
    } catch (error) {
      log("error", "terminal_delivery_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        kind: pending.kind,
        message: errorMessage(error),
      });
      if (!owns) return false;
      const attempts =
        ((await this.ctx.storage.get<number>("alarmAttempts")) ?? 0) + 1;
      await this.ctx.storage.put("alarmAttempts", attempts);
      const retryDelayMs = Math.min(
        15 * 60_000,
        30_000 * 2 ** Math.min(attempts - 1, 5),
      );
      await this.ctx.storage.setAlarm(Date.now() + retryDelayMs);
      if (attempts === 6 || attempts % 20 === 0) {
        log("error", "terminal_delivery_still_retrying", {
          turnId: turn.turnId,
          attempts,
          retryDelayMs,
          message: errorMessage(error),
        });
      }
      return false;
    }
  }

  async alarm(): Promise<void> {
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (!turn) return;
    if (
      (await this.ctx.storage.get<boolean>("terminalDelivered")) &&
      turn.kind !== "agent"
    )
      return;
    const alarmTurn = { ...turn };
    await this.trackTurn(turn.turnId, this.runAlarmWithLease(alarmTurn));
  }

  private async runAlarmWithLease(turn: TurnRequest): Promise<void> {
    const originalLeaseId = turn.ownerPurgeLeaseId;
    const originalGeneration = turn.ownerPurgeGeneration;
    let auxiliaryLeaseId: string | undefined;
    let auxiliaryGeneration: string | undefined;
    let retireOriginalLease = false;
    try {
      turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
      auxiliaryLeaseId = turn.ownerPurgeLeaseId;
      auxiliaryGeneration = turn.ownerPurgeGeneration;
      await this.assertTurnWritable(turn);
      await this.runAlarm(turn);
      retireOriginalLease = !(await this.ctx.storage.get<TurnRequest>("turn"));
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        await (await this.currentSandbox())?.destroy().catch(() => undefined);
        try {
          await this.cleanupTransientWrites(turn);
          await this.ctx.storage.deleteAll();
          retireOriginalLease = true;
        } catch (cleanupError) {
          log("error", "owner_purge_alarm_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
        }
        return;
      }
      throw error;
    } finally {
      if (auxiliaryLeaseId && auxiliaryGeneration) {
        // An auxiliary alarm lease never owns transient bytes. Release it
        // directly even when the original run lease must remain as the fence
        // for backup-debt persistence.
        await this.unregisterTurnLease(
          turn,
          auxiliaryLeaseId,
          auxiliaryGeneration,
        );
      }
      if (
        retireOriginalLease &&
        originalLeaseId &&
        originalGeneration &&
        originalLeaseId !== turn.ownerPurgeLeaseId
      ) {
        await this.unregisterTurnLease(
          turn,
          originalLeaseId,
          originalGeneration,
        );
      }
    }
  }

  private async runAlarm(turn: TurnRequest): Promise<void> {
    if (await this.ctx.storage.get<boolean>("terminalDelivered")) {
      if (
        turn.kind === "agent" &&
        !(await this.settleAgentTransientBackup(turn))
      ) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      await this.ctx.storage.deleteAll();
      return;
    }
    // A terminal state already decided is not a timeout: the run finished, its
    // workspace is checkpointed, and the only thing left is getting the result
    // to Convex. Redelivering that is the whole point of the alarm here.
    const pending =
      await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
    if (pending) {
      if (pending.turnId !== turn.turnId) {
        await this.ctx.storage.delete("pendingTerminal");
      } else {
        let deliverable = pending;
        if (pending.terminateSandbox) {
          try {
            await this.terminateCurrentAgentSandbox(turn);
          } catch (error) {
            log("error", "pending_terminal_sandbox_termination_failed", {
              turnId: turn.turnId,
              message: errorMessage(error),
            });
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
            return;
          }
          deliverable = { ...pending, terminateSandbox: false };
          await this.ctx.storage.put("pendingTerminal", deliverable);
        }
        if (
          (await this.deliverTerminal(turn, deliverable)) &&
          (await this.ownsTurn(turn.turnId))
        ) {
          if (
            turn.kind !== "agent" ||
            (await this.settleAgentTransientBackup(turn))
          ) {
            await this.ctx.storage.deleteAll();
          } else {
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
          }
        }
        return;
      }
    }
    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    let timeoutPending: PendingTerminal = {
      turnId: turn.turnId,
      kind: "failed",
      eventKind: "timeout",
      payload: {
        message:
          "This took longer than expected, so Stella stopped. Try again.",
      },
      threadError: "The agent ran out of time and was stopped.",
      terminateSandbox: true,
    };
    if (!(await this.claimTerminalDecision(turn, timeoutPending))) {
      // A normal completion or cancellation claimed the same instant. Let its
      // durable payload, rather than this timeout fallback, own the next alarm.
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    try {
      await this.terminateCurrentAgentSandbox(turn);
      timeoutPending = { ...timeoutPending, terminateSandbox: false };
      await this.ctx.storage.put("pendingTerminal", timeoutPending);
    } catch (error) {
      log("error", "timeout_sandbox_termination_failed", {
        turnId: turn.turnId,
        sandboxId,
        message: errorMessage(error),
      });
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    log("error", "turn_timed_out", {
      turnId: turn.turnId,
      appId: turn.appId,
      sandboxId,
    });
    const delivered = await this.deliverTerminal(turn, timeoutPending);
    if (delivered && (await this.ownsTurn(turn.turnId))) {
      if (
        turn.kind !== "agent" ||
        (await this.settleAgentTransientBackup(turn))
      ) {
        await this.ctx.storage.deleteAll();
      } else {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname.startsWith("/owner-fence/")) {
      return this.ownerFenceFetch(
        url.pathname.slice("/owner-fence/".length),
        request,
      );
    }
    if (url.pathname === "/owner-purge-cancel") {
      return this.cancelForOwnerPurge(request);
    }
    if (url.pathname === "/cancel") {
      const control = (await request.json().catch(() => ({}))) as {
        turnId?: string;
        reason?: string;
      };
      const stored = await this.ctx.storage.get<TurnRequest>("turn");
      if (control.turnId && !stored) {
        const pending =
          (await this.ctx.storage.get<PendingTurnCancel[]>(
            "pendingTurnCancels",
          )) ?? [];
        await this.ctx.storage.put<PendingTurnCancel[]>(
          "pendingTurnCancels",
          [
            ...pending.filter((entry) => entry.turnId !== control.turnId),
            {
              turnId: control.turnId,
              reason:
                control.reason === "Paused by orchestrator."
                  ? control.reason
                  : "The agent was stopped.",
            },
          ].slice(-10),
        );
        return json(
          {
            canceled: true,
            pending: true,
            currentTurnId: null,
          },
          202,
        );
      }
      if (control.turnId && stored?.turnId !== control.turnId) {
        return json(
          {
            canceled: false,
            reason: "stale_turn",
            currentTurnId: stored?.turnId ?? null,
          },
          409,
        );
      }
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (stored && (await this.ctx.storage.get<boolean>("terminal"))) {
        const pending =
          await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
        if (pending?.turnId === stored.turnId && pending.kind === "canceled") {
          return json(
            {
              canceled: true,
              pending: true,
              currentTurnId: stored.turnId,
            },
            202,
          );
        }
        return json(
          {
            canceled: false,
            reason: "terminal_already_decided",
            currentTurnId: stored.turnId,
          },
          409,
        );
      }
      if (stored) {
        const turn = { ...stored };
        let pending: PendingTerminal = {
          turnId: turn.turnId,
          kind: "canceled",
          payload: { message: "Stopped. Nothing was changed." },
          threadError:
            control.reason === "Paused by orchestrator."
              ? control.reason
              : "The agent was stopped.",
          terminateSandbox: true,
        };
        // Claim the terminal state before touching the process. This fences a
        // native CLI that exits while cancellation is in flight from
        // checkpointing or reporting completion over the cancel.
        if (!(await this.claimTerminalDecision(turn, pending))) {
          return json(
            {
              canceled: false,
              reason: "terminal_already_decided",
              currentTurnId: turn.turnId,
            },
            409,
          );
        }
        try {
          await this.terminateCurrentAgentSandbox(turn);
          pending = { ...pending, terminateSandbox: false };
          await this.ctx.storage.put("pendingTerminal", pending);
        } catch (error) {
          log("error", "cancel_sandbox_termination_failed", {
            turnId: turn.turnId,
            sandboxId,
            message: errorMessage(error),
          });
          // The pending terminal tells the alarm to retry process teardown
          // before it delivers the cancellation.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          return json(
            {
              canceled: false,
              reason: "sandbox_termination_failed",
              currentTurnId: turn.turnId,
            },
            502,
          );
        }
        let auxiliaryLeaseId: string | undefined;
        let auxiliaryGeneration: string | undefined;
        try {
          turn.ownerPurgeGeneration = await this.registerTurn(turn, true);
          auxiliaryLeaseId = turn.ownerPurgeLeaseId;
          auxiliaryGeneration = turn.ownerPurgeGeneration;
          await this.assertTurnWritable(turn);
          log("info", "turn_canceled", {
            turnId: turn.turnId,
            appId: turn.appId,
            sandboxId,
          });
          // Delivery failure here re-arms the alarm rather than stranding the
          // turn and its thread "running" forever.
          await this.deliverTerminal(turn, pending);
        } catch (error) {
          if (!(error instanceof OwnerPurgeFenceError)) throw error;
        } finally {
          if (auxiliaryLeaseId && auxiliaryGeneration) {
            await this.unregisterTurnLease(
              turn,
              auxiliaryLeaseId,
              auxiliaryGeneration,
            );
          }
        }
      }
      return json({ canceled: true });
    }
    if (url.pathname === "/echo") return this.runEcho();
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const turn = (await request.json()) as TurnRequest;
    try {
      delete turn.ownerPurgeGeneration;
      delete turn.ownerPurgeLeaseId;
      turn.ownerPurgeGeneration = await this.registerTurn(turn);
      await this.assertTurnWritable(turn);
      if (turn.kind === "agent") return this.acceptAgentTurn(turn);
      return this.trackTurn(turn.turnId, this.runTurn(turn));
    } catch (error) {
      await this.unregisterTurn(turn);
      if (error instanceof OwnerPurgeFenceError) {
        return json({ error: "Owner cloud activity is being purged." }, 409);
      }
      throw error;
    }
  }

  // Accept the dispatch immediately and run the turn in the background: a
  // sandbox turn takes minutes, and holding the POST open that long means a
  // mid-turn transport failure makes Convex mark a still-running turn (and
  // its thread) failed while the agent goes on to finish. Outcomes reach
  // Convex only through events/threads-complete callbacks.
  private async acceptAgentTurn(turn: TurnRequest): Promise<Response> {
    const pendingCancels =
      (await this.ctx.storage.get<PendingTurnCancel[]>("pendingTurnCancels")) ??
      [];
    const pendingCancel = pendingCancels.find(
      (entry) => entry.turnId === turn.turnId,
    );
    if (pendingCancel?.turnId === turn.turnId) {
      const remaining = pendingCancels.filter(
        (entry) => entry.turnId !== turn.turnId,
      );
      if (remaining.length > 0) {
        await this.ctx.storage.put("pendingTurnCancels", remaining);
      } else {
        await this.ctx.storage.delete("pendingTurnCancels");
      }
      const current = await this.ctx.storage.get<TurnRequest>("turn");
      if (current && current.turnId !== turn.turnId) {
        // The canceled dispatch arrived after a continuation had already
        // taken over this thread's DO. Convex has terminalized this exact
        // turn, so acknowledge it without touching the successor's storage.
        await this.unregisterTurn(turn);
        return json({ accepted: true, canceled: true }, 202);
      }
      await this.ctx.storage.put({
        turn,
        turnId: turn.turnId,
        terminal: false,
        terminalDelivered: false,
        alarmAttempts: 0,
        alarmReconcile: false,
      });
      const delivered = await this.deliverTerminal(turn, {
        turnId: turn.turnId,
        kind: "canceled",
        payload: { message: "Stopped. Nothing was changed." },
        threadError: pendingCancel.reason,
      });
      if (delivered && (await this.ownsTurn(turn.turnId))) {
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        await this.ctx.storage.deleteAll();
      }
      await this.unregisterTurn(turn);
      return json({ accepted: true, canceled: true }, 202);
    }
    const sandboxId = sessionName(`agent-${turn.turnId}`);
    // A predecessor whose terminal state never reached Convex left it here.
    // Taking over the DO takes the alarm with it, so this is its last chance:
    // it is delivered detached and, because the stored turnId is about to
    // change, `deliverTerminal` treats it as a stale turn — it touches no
    // storage and completes no thread, so all it can still do is give its own
    // turn the terminal state it never got. A payload for the turn now being
    // accepted (a redispatch of the same turnId) is dropped instead: that turn
    // is about to run and will decide its own outcome.
    const orphan =
      await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
    const orphanTurn = orphan
      ? await this.ctx.storage.get<TurnRequest>("turn")
      : undefined;
    await this.ctx.storage.put({
      sandboxId,
      turn,
      turnId: turn.turnId,
      terminal: false,
      terminalDelivered: false,
      alarmAttempts: 0,
      alarmReconcile: false,
    });
    await this.ctx.storage.delete("pendingTerminal");
    if (
      orphan &&
      orphanTurn &&
      orphan.turnId === orphanTurn.turnId &&
      orphan.turnId !== turn.turnId
    ) {
      this.ctx.waitUntil(
        this.trackTurn(
          orphanTurn.turnId,
          this.redeliverOrphan(orphanTurn, orphan),
        ).catch(() => undefined),
      );
    }
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
    );
    this.ctx.waitUntil(
      this.trackTurn(turn.turnId, this.runAgentTurn(turn, sandboxId)).catch(
        () => undefined,
      ),
    );
    return json({ accepted: true }, 202);
  }

  private async runEcho(): Promise<Response> {
    const sandboxId = `m0-${this.ctx.id.toString().slice(0, 24)}`;
    const sandbox = this.sandbox(sandboxId);
    await this.ctx.storage.put("sandboxId", sandboxId);
    try {
      const session = await sandbox.createSession({
        id: sessionName(`echo-${crypto.randomUUID()}`),
        cwd: "/opt/stella",
        commandTimeoutMs: Number(this.env.TURN_TIMEOUT_MS),
      });
      const execution = await session.exec(
        "bun packages/executor-cloud/src/cli.ts --stub",
        { timeout: Number(this.env.TURN_TIMEOUT_MS) },
      );
      await sandbox.deleteSession(session.id).catch(() => undefined);
      if (!execution.success) {
        return json(
          { error: "Executor echo failed", detail: execution.stderr },
          502,
        );
      }
      return json({
        ok: true,
        executor: JSON.parse(
          execution.stdout.trim().split("\n").at(-1) ?? "{}",
        ),
      });
    } catch (error) {
      return json(
        { error: "Sandbox echo failed", detail: errorMessage(error) },
        502,
      );
    } finally {
      await sandbox.destroy().catch(() => undefined);
      await this.ctx.storage.deleteAll();
    }
  }

  // A spawned general agent's turn: restore its workspace, run the real
  // runtime headless in the sandbox, checkpoint, report. The executor
  // streams its own progress events with the turn token; this method owns
  // workspace persistence and the terminal event. Runs detached from the
  // dispatch request (see acceptAgentTurn).
  private async runAgentTurn(
    turn: TurnRequest,
    sandboxId: string,
  ): Promise<void> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const workspace = resolveWorkspace(turn.workspace);
    const requestStarted = performance.now();
    let sandbox = this.sandbox(sandboxId);
    log("info", "agent_turn_started", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      workspace: workspace?.canonical ?? turn.workspace,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await this.assertTurnWritable(turn);
      if (!workspace || !workspace.mountPath) {
        throw new AgentTurnError(
          workspace?.kind === "computer"
            ? "The user's computer isn't reachable from the cloud. This has to run on their own machine."
            : `Stella doesn't recognize the workspace "${turn.workspace ?? ""}", so there was nothing to work in.`,
        );
      }
      const workspaceRoot = workspace.mountPath;
      const workspaceKey = await checkpointKey(
        turn.ownerId,
        workspace.canonical,
      );
      await this.event(turn, "auto", "started", {
        threadId: turn.threadId,
        workspace: workspace.canonical,
      });

      // Thread transcript for send_input continuations: the DO fetches it
      // (service secret) and hands it to the executor, which holds only the
      // turn token. Fetched once, before any sandbox exists, so an escalation
      // retry does not pay for it twice.
      let history: unknown[] = [];
      if (turn.threadId) {
        const contextResponse = await fetch(
          `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/context?conversationId=${encodeURIComponent(turn.threadId)}`,
          {
            headers: {
              authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            },
          },
        );
        if (contextResponse.ok) {
          const payload = (await contextResponse.json()) as {
            messages?: unknown[];
          };
          history = payload.messages ?? [];
        }
      }

      // Clone credentials are minted per turn and expire on their own; they
      // are held in this local only and handed to the executor through a
      // one-shot file it deletes before the agent can run.
      const projectContext =
        workspace.kind === "project" && workspace.slug
          ? await this.fetchProjectCredentials(turn, workspace.slug)
          : undefined;
      const project = projectContext?.handoff;

      // Read once here rather than per attempt: it decides the starting rung
      // (a cold repository has to clone and install) and an escalation retry
      // restores the same checkpoint the first attempt did.
      const descriptor = await this.env.APP_ROUTES.get<DirectoryBackup>(
        workspaceKey,
        "json",
      );
      // Without the small class bound there is only one rung, so start (and
      // stay) on the large one rather than pretending to size anything. A
      // workspace that has already been seen to need more memory overrides the
      // heuristic — that memory is what stops the OOM-escalate cycle from
      // repeating on every turn.
      const remembered =
        asInstanceSize(projectContext?.instanceSize) ??
        asInstanceSize(
          await this.env.APP_ROUTES.get(instanceSizeKey(workspaceKey)),
        );
      let size: InstanceSize = !this.env.SANDBOX_SMALL
        ? "large"
        : (remembered ??
          initialInstanceSize({
            workspaceKind: workspace.kind,
            prompt: turn.prompt,
            restored: Boolean(descriptor),
          }));
      await this.ctx.storage.put("sandboxSize", size);
      sandbox = this.sandbox(sandboxId, size);
      let escalated = false;
      let attempt = await this.runAgentAttempt({
        turn,
        sandbox,
        size,
        workspaceRoot,
        descriptor,
        history,
        project,
        commandTimeoutMs,
      });

      // One escalation, one retry. The failed attempt's sandbox is discarded
      // rather than checkpointed — an OOM-killed workspace is not a state
      // worth persisting — so the retry restores the same checkpoint the
      // first attempt did.
      if (
        attempt.oom &&
        size === "small" &&
        (await this.ownsTurn(turn.turnId)) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await sandbox.destroy().catch(() => undefined);
        size = "large";
        escalated = true;
        const escalatedId = sessionName(`agent-${turn.turnId}-lg`);
        await this.ctx.storage.put({
          sandboxId: escalatedId,
          sandboxSize: size,
        });
        // What this turn just learned, written before the retry so it survives
        // however the retry ends: this workspace does not fit on the small
        // rung. Every workspace kind learns here — `project:` additionally
        // records it in Convex below, where the user can see it. The TTL lets
        // a workspace that has since become light drift back down.
        await this.assertTurnWritable(turn);
        const sizeKey = instanceSizeKey(workspaceKey);
        await this.env.APP_ROUTES.put(sizeKey, size, {
          expirationTtl: 30 * 86_400,
        }).catch(() => undefined);
        try {
          await this.assertAgentTurnActive(turn);
        } catch (error) {
          await this.env.APP_ROUTES.delete(sizeKey).catch(() => undefined);
          throw error;
        }
        // The watchdog budget was spent on the attempt that died; without a
        // fresh one the retry is guaranteed to be cut off mid-run and the
        // escalation buys nothing.
        await this.ctx.storage.setAlarm(
          Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
        );
        log("info", "agent_turn_resized", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          instanceType: INSTANCE_TIERS[size].instanceType,
        });
        await this.event(turn, "auto", "resized", {
          reason: "out_of_memory",
          instanceType: INSTANCE_TIERS[size].instanceType,
        }).catch(() => undefined);
        sandbox = this.sandbox(escalatedId, size);
        attempt = await this.runAgentAttempt({
          turn,
          sandbox,
          size,
          workspaceRoot,
          descriptor,
          history,
          project,
          commandTimeoutMs,
        });
      }
      const { coldContainerStartMs, restoreMs } = attempt;
      let result = attempt.result;
      let interiorCandidate:
        | Awaited<ReturnType<BuildSession["publishInteriorCandidate"]>>
        | undefined;

      // A stale turn (alarm fired, or a successor continuation took over
      // this thread's DO) must not checkpoint over the successor's restore
      // or report on the shared thread.
      if (
        !(await this.ownsTurn(turn.turnId)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await sandbox.destroy().catch(() => undefined);
        log("info", "agent_turn_superseded", {
          turnId: turn.turnId,
          threadId: turn.threadId,
        });
        return;
      }

      if (result.ok && workspace.kind === "stella") {
        await this.event(turn, "auto", "interior_build_started", {
          sourceWorkspace: workspace.canonical,
        }).catch(() => undefined);
        try {
          interiorCandidate = await this.publishInteriorCandidate(
            turn,
            sandbox,
            workspaceRoot,
            commandTimeoutMs,
          );
          await this.event(turn, "auto", "interior_candidate_created", {
            buildId: interiorCandidate.buildId,
            previewUrl: interiorCandidate.previewUrl,
            digest: interiorCandidate.digest,
            size: interiorCandidate.size,
            sourceRevision: interiorCandidate.sourceRevision,
            baseRevision: interiorCandidate.baseRevision,
            activated: false,
          }).catch(() => undefined);
        } catch (error) {
          if (
            !(await this.ownsTurn(turn.turnId)) ||
            (await this.ctx.storage.get<boolean>("terminal"))
          ) {
            await sandbox.destroy().catch(() => undefined);
            return;
          }
          const buildError = errorMessage(error);
          log("error", "interior_candidate_failed", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: buildError,
          });
          await this.event(turn, "auto", "interior_build_failed", {
            message:
              "The updated Stella interior did not pass its production build.",
          }).catch(() => undefined);
          result = {
            ...result,
            ok: false,
            error:
              "The agent's source changes were kept, but the updated Stella interior did not pass its production build, so no candidate was created.",
          };
        }
      }

      // Checkpoint even after a failed loop — partial work in the workspace
      // is still the user's work.
      let checkpointMs = 0;
      let checkpointError: string | undefined;
      for (let retry = 0; retry < 2; retry += 1) {
        let pointerCommitted = false;
        let createdBackupId: string | undefined;
        try {
          await this.assertAgentTurnActive(turn);
          const checkpointStarted = performance.now();
          const backup = await sandbox.createBackup({
            dir: workspaceRoot,
            name: checkpointBackupName(workspaceKey),
            ttl:
              workspace.kind === "stella"
                ? STELLA_SOURCE_BACKUP_TTL_SECONDS
                : ORDINARY_WORKSPACE_BACKUP_TTL_SECONDS,
            localBucket: true,
            compression: { format: "zstd", threads: 2 },
          });
          createdBackupId = backup.id;
          await this.ctx.storage.put(
            `transientBackup:${turn.turnId}`,
            backup.id,
          );
          await this.ctx.storage.put(
            `transientBackupWorkspace:${turn.turnId}`,
            workspaceKey,
          );
          checkpointMs = Math.round(performance.now() - checkpointStarted);
          try {
            await this.assertAgentTurnActive(turn);
          } catch (error) {
            await sweepR2Prefix(
              this.env.BACKUP_BUCKET,
              `backups/${backup.id}/`,
            ).catch(() => undefined);
            throw error;
          }
          const priorBackupId =
            descriptor?.id &&
            BACKUP_ID_PATTERN.test(descriptor.id) &&
            descriptor.id !== backup.id
              ? descriptor.id
              : undefined;
          const debtKey = backupDebtKey(workspaceKey);
          if (priorBackupId) {
            const existingDebt =
              (await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
                debtKey,
                "json",
              )) ?? { backupIds: [] };
            const backupIds = [
              ...new Set([...existingDebt.backupIds, priorBackupId]),
            ];
            if (backupIds.length > 100) {
              throw new Error("Workspace backup cleanup debt is too large.");
            }
            await this.env.APP_ROUTES.put(
              debtKey,
              JSON.stringify({ backupIds } satisfies WorkspaceBackupDebt),
            );
            await this.assertAgentTurnActive(turn);
          }
          await this.env.APP_ROUTES.put(workspaceKey, JSON.stringify(backup));
          pointerCommitted = true;
          try {
            await this.assertAgentTurnActive(turn);
          } catch (error) {
            if (descriptor) {
              await this.env.APP_ROUTES.put(
                workspaceKey,
                JSON.stringify(descriptor),
              );
            } else {
              await this.env.APP_ROUTES.delete(workspaceKey);
            }
            await sweepR2Prefix(
              this.env.BACKUP_BUCKET,
              `backups/${backup.id}/`,
            ).catch(() => undefined);
            throw error;
          }
          await this.ctx.storage.delete([
            `transientBackup:${turn.turnId}`,
            `transientBackupWorkspace:${turn.turnId}`,
          ]);
          const cleanupDebt =
            (await this.env.APP_ROUTES.get<WorkspaceBackupDebt>(
              debtKey,
              "json",
            )) ?? { backupIds: [] };
          const remainingDebt: string[] = [];
          for (const backupId of cleanupDebt.backupIds) {
            if (!BACKUP_ID_PATTERN.test(backupId)) {
              remainingDebt.push(backupId);
              continue;
            }
            try {
              const swept = await sweepR2Prefix(
                this.env.BACKUP_BUCKET,
                `backups/${backupId}/`,
              );
              if (!swept.done) remainingDebt.push(backupId);
            } catch {
              remainingDebt.push(backupId);
            }
          }
          if (remainingDebt.length > 0) {
            await this.env.APP_ROUTES.put(
              debtKey,
              JSON.stringify({
                backupIds: remainingDebt,
              } satisfies WorkspaceBackupDebt),
            );
            throw new Error("Prior workspace backup cleanup remains pending.");
          } else if (cleanupDebt.backupIds.length > 0) {
            await this.env.APP_ROUTES.delete(debtKey);
          }
          checkpointError = undefined;
          break;
        } catch (error) {
          checkpointError = errorMessage(error);
          if (pointerCommitted) break;
          if (createdBackupId) {
            try {
              const swept = await sweepR2Prefix(
                this.env.BACKUP_BUCKET,
                `backups/${createdBackupId}/`,
              );
              if (!swept.done) {
                throw new Error("Transient backup cleanup was truncated.");
              }
              const tracked = await this.ctx.storage.get<string>(
                `transientBackup:${turn.turnId}`,
              );
              if (tracked === createdBackupId) {
                await this.ctx.storage.delete([
                  `transientBackup:${turn.turnId}`,
                  `transientBackupWorkspace:${turn.turnId}`,
                ]);
              }
            } catch (cleanupError) {
              checkpointError = `${checkpointError} Cleanup also failed: ${errorMessage(cleanupError)}`;
              try {
                await this.appendWorkspaceBackupDebt(
                  workspaceKey,
                  createdBackupId,
                );
                await this.ctx.storage.delete([
                  `transientBackup:${turn.turnId}`,
                  `transientBackupWorkspace:${turn.turnId}`,
                ]);
              } catch (debtError) {
                checkpointError = `${checkpointError} Cleanup debt persistence also failed: ${errorMessage(debtError)}`;
              }
              break;
            }
          }
        }
      }
      if (
        !(await this.ownsTurn(turn.turnId)) ||
        (await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await sandbox.destroy().catch(() => undefined);
        return;
      }
      if (checkpointError) {
        // The snapshot is the only durable copy of the workspace; losing it
        // must be visible in the report the orchestrator relays, not just a
        // log line next to a "completed" turn.
        log("error", "agent_checkpoint_failed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: checkpointError,
        });
        await this.event(turn, "auto", "checkpoint_failed", {
          message:
            "Saving the workspace after this turn failed; file changes may not persist.",
        }).catch(() => undefined);
        if (result.ok) {
          result = {
            ...result,
            finalText:
              `${result.finalText ?? ""}\n\nHeads up: saving the workspace after this turn failed, so file changes from this turn may not persist. Anything important should be recreated or the task retried.`.trim(),
          };
        }
      }

      const wallClockMs = Math.round(performance.now() - requestStarted);
      let pending: PendingTerminal;
      if (result.ok) {
        pending = {
          turnId: turn.turnId,
          kind: "completed",
          payload: {
            finalText: result.finalText ?? "",
            usage: result.usage,
            coldContainerStartMs,
            restoreMs,
            checkpointMs,
            wallClockMs,
            instanceType: INSTANCE_TIERS[size].instanceType,
            ...(interiorCandidate ? { interiorCandidate } : {}),
          },
        };
      } else {
        let message = result.error ?? "The agent failed.";
        if (checkpointError) {
          message = `${message} Files changed in the workspace during this attempt may not have been saved.`;
        }
        pending = {
          turnId: turn.turnId,
          kind: "failed",
          payload: { message },
          threadError: message,
        };
      }
      const delivered = await this.deliverTerminal(turn, pending);
      // What this turn learned about the project: the setup command it had to
      // infer, and the instance size it actually needed. Recording them is
      // what stops the next turn from rediscovering both the slow way.
      if (workspace.kind === "project") {
        const setupScript =
          result.project?.setupSource === "inferred"
            ? result.project.setupCommand
            : undefined;
        if (setupScript || escalated || !checkpointError) {
          await this.callback(turn, "/api/cloud/projects/setup", {
            ownerId: turn.ownerId,
            slug: workspace.slug,
            workspace: workspace.canonical,
            ...(setupScript ? { setupScript } : {}),
            ...(escalated ? { instanceSize: size } : {}),
            ...(checkpointError ? {} : { checkpointedAt: Date.now() }),
          }).catch(() => undefined);
        }
      }
      await sandbox.destroy().catch(() => undefined);
      // Storage is the redelivery's only memory: clear it once the terminal
      // state is in Convex, and leave it — with the alarm deliverTerminal
      // re-armed — when it is not.
      if (delivered && (await this.ownsTurn(turn.turnId))) {
        if (await this.settleAgentTransientBackup(turn)) {
          await this.ctx.storage.deleteAlarm().catch(() => undefined);
          await this.ctx.storage.deleteAll();
        } else {
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      log("info", "agent_turn_finished", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        ok: result.ok,
        wallClockMs,
      });
    } catch (error) {
      const message = errorMessage(error);
      await sandbox.destroy().catch(() => undefined);
      log("error", "agent_turn_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message,
      });
      // Fencing: a stale unwind (successor accepted on this thread's DO, or
      // the alarm already owns terminal delivery) must not fail the thread,
      // kill the successor's watchdog, or wipe shared storage.
      if (!(await this.ownsTurn(turn.turnId))) return;
      if (await this.ctx.storage.get<boolean>("terminal")) return;
      if (error instanceof OwnerPurgeFenceError) {
        try {
          await this.cleanupTransientWrites(turn);
          await this.ctx.storage.deleteAlarm().catch(() => undefined);
          await this.ctx.storage.deleteAll();
        } catch (cleanupError) {
          log("error", "owner_purge_agent_cleanup_failed", {
            turnId: turn.turnId,
            message: errorMessage(cleanupError),
          });
        }
        return;
      }
      // Raw infrastructure errors stay in logs; only messages written for a
      // person reach the thread and the event.
      const friendly =
        error instanceof AgentTurnError
          ? error.userMessage
          : "The agent hit a problem and stopped. Try again.";
      const delivered = await this.deliverTerminal(turn, {
        turnId: turn.turnId,
        kind: "failed",
        payload: { message: friendly },
        threadError: friendly,
      });
      // Undelivered leaves storage and the re-armed alarm in place, so the
      // turn cannot stay "running" forever.
      if (delivered && (await this.ownsTurn(turn.turnId))) {
        if (await this.settleAgentTransientBackup(turn)) {
          await this.ctx.storage.deleteAlarm().catch(() => undefined);
          await this.ctx.storage.deleteAll();
        } else {
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
    } finally {
      await this.unregisterTurn(turn);
    }
  }

  /**
   * One sandbox attempt at an agent turn: boot, restore the workspace, hand
   * the executor its input, run it. Kept separate from {@link runAgentTurn}
   * so an OOM escalation can repeat it on a bigger instance without
   * duplicating any of the turn's lifecycle or fencing.
   */
  private async runAgentAttempt(args: {
    turn: TurnRequest;
    sandbox: ReturnType<BuildSession["sandbox"]>;
    size: InstanceSize;
    workspaceRoot: string;
    /** The workspace's last checkpoint, or null on its first turn. */
    descriptor: DirectoryBackup | null;
    history: unknown[];
    project?: ProjectHandoff;
    commandTimeoutMs: number;
  }): Promise<{
    result: AgentExecutorResult;
    oom: boolean;
    coldContainerStartMs: number;
    restoreMs: number;
  }> {
    const { turn, sandbox, workspaceRoot, descriptor } = args;
    const coldStarted = performance.now();
    const session = await sandbox.createSession({
      id: sessionName(`agent-run-${turn.turnId}-${args.size}`),
      cwd: "/opt/stella",
      commandTimeoutMs: args.commandTimeoutMs,
      env: {
        STELLA_TURN_TOKEN: turn.turnToken,
        STELLA_CLOUD_WORKSPACE_ROOT: workspaceRoot,
      },
    });
    const coldContainerStartMs = Math.round(performance.now() - coldStarted);

    // Sandbox disk is a cache: restore the workspace's last checkpoint, or
    // start it empty on first use.
    let restoreMs = 0;
    if (descriptor) {
      const restoreStarted = performance.now();
      await sandbox.restoreBackup(descriptor);
      restoreMs = Math.round(performance.now() - restoreStarted);
      if (workspaceRoot === "/workspace/stella") {
        const readJson = async (filePath: string) => {
          const read = await session.readFile(filePath, {
            encoding: "base64",
          });
          return JSON.parse(atob(read.content)) as Record<string, unknown>;
        };
        const [workspaceState, imageSeed] = await Promise.all([
          readJson("/workspace/stella/.stella/interior-source.json"),
          readJson("/opt/stella/interior-seed.json"),
        ]);
        const workspaceSeedRevision =
          typeof workspaceState.upstreamSeedRevision === "string"
            ? workspaceState.upstreamSeedRevision
            : workspaceState.buildId === undefined &&
                typeof workspaceState.sourceRevision === "string"
              ? workspaceState.sourceRevision
              : null;
        if (
          !workspaceSeedRevision ||
          typeof imageSeed.sourceRevision !== "string" ||
          workspaceSeedRevision !== imageSeed.sourceRevision
        ) {
          throw new AgentTurnError(
            "Stella's packaged renderer changed since this cloud workspace was created. Its existing customizations need an upstream migration before another self-update can be built.",
          );
        }
      }
    } else if (workspaceRoot === "/workspace/stella") {
      // A first Stella workspace is a real, buildable renderer checkout from
      // the immutable image—not an empty directory the model has to invent.
      // All paths are fixed image/mount contract constants; no user value is
      // interpolated into this seeding command.
      const seeded = await session.exec(
        "set -eu; mkdir -p /workspace/stella; cp -a /opt/stella/packages/desktop-ui/. /workspace/stella/; ln -s /opt/stella/node_modules /workspace/stella/node_modules; mkdir -p /workspace/stella/.stella; cp /opt/stella/interior-seed.json /workspace/stella/.stella/interior-source.json",
      );
      if (!seeded.success) {
        throw new Error(
          "The Stella interior source seed could not be created.",
        );
      }
    } else {
      await session.exec(`mkdir -p ${workspaceRoot}`);
    }
    await this.event(turn, "auto", "sandbox_ready", {
      coldContainerStartMs,
      restoreMs,
      restored: Boolean(descriptor),
      instanceType: INSTANCE_TIERS[args.size].instanceType,
    });

    // The installation token is the one thing that does not go into
    // turn-input.json: that file survives the whole turn one directory above
    // the agent's cwd, so anything in it is one `cat ../turn-input.json` away
    // from a prompt-injected agent. It gets its own file instead, and the
    // executor deletes that file before it builds the agent's tool host.
    let credentialsPath: string | undefined;
    let projectInput: Record<string, unknown> | undefined;
    if (args.project) {
      const { token, ...handoff } = args.project;
      projectInput = handoff;
      if (token) {
        credentialsPath = projectCredentialsPath();
        await session.writeFile(credentialsPath, JSON.stringify({ token }));
        projectInput = { ...handoff, credentialsPath };
      }
    }

    // Everything from here on is inside the cleanup guard: once the
    // credentials file exists, no failure path may leave it behind in a
    // container that outlives this call.
    let execution: Execution;
    try {
      // turn-input.json sits above the workspace root on purpose: the
      // checkpoint only covers the root, so nothing here reaches a durable
      // backup.
      await session.writeFile(
        "/workspace/turn-input.json",
        JSON.stringify({
          kind: "agent",
          ownerId: turn.ownerId,
          conversationId: turn.conversationId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          prompt: turn.prompt,
          workspace: turn.workspace ?? "cloud",
          convexCallbackBase: turn.convexCallbackBase,
          history: args.history,
          ...(projectInput ? { project: projectInput } : {}),
          ...(turn.execution ? { execution: turn.execution } : {}),
        }),
      );
      execution = (await session.exec(
        "bun packages/executor-cloud/src/cli.ts --agent-turn",
        { timeout: args.commandTimeoutMs },
      )) as Execution;
    } finally {
      // The executor unlinks this the moment it has read it; this is the
      // backstop for an executor that died before it got that far, so the
      // token cannot outlive the process that needed it.
      if (credentialsPath) {
        await session.deleteFile(credentialsPath).catch(() => undefined);
      }
    }
    if (execution.success) {
      try {
        return {
          result: JSON.parse(
            execution.stdout.trim().split("\n").at(-1) ?? "{}",
          ) as AgentExecutorResult,
          oom: false,
          coldContainerStartMs,
          restoreMs,
        };
      } catch {
        return {
          result: { ok: false, error: "The agent's report was unreadable." },
          oom: false,
          coldContainerStartMs,
          restoreMs,
        };
      }
    }
    const oom = isOutOfMemoryFailure({
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
    });
    log("error", "agent_executor_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      oom,
      instanceType: INSTANCE_TIERS[args.size].instanceType,
      stderr: execution.stderr.slice(-4_000),
    });
    return {
      result: {
        ok: false,
        error: oom
          ? "The agent ran out of memory and stopped. Try again with a smaller slice of the work."
          : "The agent hit a problem and stopped. Try again.",
      },
      oom,
      coldContainerStartMs,
      restoreMs,
    };
  }

  /**
   * Short-lived clone credentials for a `project:` workspace. The response is
   * never logged and never persisted: it is read into the caller's local and
   * handed straight to the sandbox.
   */
  private async fetchProjectCredentials(
    turn: TurnRequest,
    slug: string,
  ): Promise<{ handoff?: ProjectHandoff; instanceSize?: string }> {
    let payload: {
      provider?: string;
      remoteUrl?: string | null;
      token?: string | null;
      defaultBranch?: string;
      setupScript?: string;
      instanceSize?: string;
      authorName?: string;
      authorEmail?: string;
      error?: string;
    };
    try {
      const response = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/projects/credentials`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ownerId: turn.ownerId,
            slug,
            threadId: turn.threadId,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        log("error", "project_credentials_failed", {
          turnId: turn.turnId,
          slug,
          status: response.status,
        });
        throw new AgentTurnError(
          "Stella couldn't get access to that project's repository. Reconnect the project and try again.",
        );
      }
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      if (error instanceof AgentTurnError) throw error;
      throw new AgentTurnError(
        "Stella couldn't reach that project's repository. Try again in a moment.",
      );
    }
    const instanceSize = payload.instanceSize?.trim();
    // Stella-hosted projects have no remote at all: the restored workspace is
    // the git home, so there is nothing to clone and no token to hand over.
    if (payload.provider === "stella" || !payload.remoteUrl) {
      return { ...(instanceSize ? { instanceSize } : {}) };
    }
    if (!payload.token) {
      throw new AgentTurnError(
        "That project's repository isn't connected to Stella's GitHub app yet, so the agent can't reach it.",
      );
    }
    const defaultBranch = payload.defaultBranch?.trim() || "main";
    return {
      handoff: {
        remoteUrl: payload.remoteUrl,
        token: payload.token,
        defaultBranch,
        // Agents work directly on the default branch, like a person at a
        // clone: each turn's sandbox is its own working copy, and the remote
        // reconciles concurrent work through ordinary fetch/rebase/push.
        branch: defaultBranch,
        ...(payload.setupScript ? { setupScript: payload.setupScript } : {}),
        ...(payload.authorName && payload.authorEmail
          ? {
              authorName: payload.authorName,
              authorEmail: payload.authorEmail,
            }
          : {}),
      },
      ...(instanceSize ? { instanceSize } : {}),
    };
  }

  private async runTurn(turn: TurnRequest): Promise<Response> {
    const commandTimeoutMs = Number(this.env.TURN_TIMEOUT_MS);
    const firstSandboxId = sessionName(`turn-${turn.turnId}`);
    const secondSandboxId = sessionName(`restore-${turn.turnId}`);
    const first = this.sandbox(firstSandboxId);
    await this.ctx.storage.put({
      sandboxId: firstSandboxId,
      turn,
      turnTokenHash: await sha256Hex(turn.turnToken),
      turnId: turn.turnId,
      terminal: false,
    });
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
    );
    let seq = 0;
    let transientBackupId: string | undefined;
    const requestStarted = performance.now();
    log("info", "turn_started", {
      turnId: turn.turnId,
      appId: turn.appId,
      sessionId: this.ctx.id.toString(),
      autoActivate: turn.autoActivate !== false,
    });
    try {
      await this.assertTurnWritable(turn);
      await this.event(turn, seq++, "started", { appId: turn.appId });
      if (turn.preflightDelayMs) {
        await scheduler.wait(turn.preflightDelayMs);
      }
      if (await this.ctx.storage.get<boolean>("terminal")) {
        throw new Error("Turn was canceled or timed out before execution.");
      }
      const coldStarted = performance.now();
      const session = await first.createSession({
        id: sessionName(`build-${turn.turnId}`),
        cwd: "/opt/stella",
        commandTimeoutMs,
        env: {
          STELLA_TURN_TOKEN: turn.turnToken,
          STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
        },
      });
      const coldContainerStartMs = Math.round(performance.now() - coldStarted);
      await this.event(turn, seq++, "sandbox_ready", { coldContainerStartMs });

      const modelStarted = performance.now();
      const modelResponse = await fetch(
        `${turn.convexCallbackBase.replace(/\/+$/, "")}/api/cloud/model`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prompt: turn.prompt }),
        },
      );
      const modelPayload = (await modelResponse.json()) as {
        spec?: unknown;
        usage?: Record<string, unknown>;
        error?: string;
      };
      if (!modelResponse.ok || !modelPayload.spec) {
        throw new Error(
          modelPayload.error ?? `Model relay failed (${modelResponse.status}).`,
        );
      }
      const appTitle =
        typeof (modelPayload.spec as { title?: unknown })?.title === "string"
          ? (modelPayload.spec as { title: string }).title
              .trim()
              .slice(0, 32) || undefined
          : undefined;
      await this.event(turn, seq++, "model_completed", {
        ...modelPayload.usage,
        roundTripMs: Math.round(performance.now() - modelStarted),
      });
      await session.writeFile(
        "/workspace/turn-input.json",
        JSON.stringify({ prompt: turn.prompt, spec: modelPayload.spec }),
      );
      const execution = (await session.exec(
        "bun packages/executor-cloud/src/cli.ts --app-turn",
        { timeout: commandTimeoutMs },
      )) as Execution;
      if (!execution.success) {
        log("error", "executor_failed", {
          turnId: turn.turnId,
          appId: turn.appId,
          stderr: execution.stderr.slice(-4_000),
        });
        throw new Error("Stella hit a problem while building. Try again.");
      }
      const executor = JSON.parse(
        execution.stdout.trim().split("\n").at(-1) ?? "{}",
      ) as ExecutorResult;
      await this.event(turn, seq++, "app_built", {
        runtimeTools: executor.runtimeTools,
        ...executor.metrics,
      });

      const viteStarted = performance.now();
      const vite = await session.startProcess(
        "/usr/local/bin/vite --host 0.0.0.0 --port 5173",
        { cwd: "/workspace/app" },
      );
      await vite.waitForPort(5173, {
        path: "/",
        status: 200,
        timeout: 120_000,
      });
      const tunnel = await first.tunnels.get(5173);
      const firstPreviewMs = Math.round(performance.now() - viteStarted);
      await this.event(turn, seq++, "live_preview", {
        url: tunnel.url,
        firstPreviewMs,
      });

      const checkpointStarted = performance.now();
      await this.assertTurnWritable(turn);
      const backup = await first.createBackup({
        dir: "/workspace/app",
        name: `stella-${turn.appId}`,
        ttl: 86_400,
        localBucket: true,
        compression: { format: "zstd", threads: 2 },
      });
      transientBackupId = backup.id;
      await this.ctx.storage.put(`transientBackup:${turn.turnId}`, backup.id);
      try {
        await this.assertTurnWritable(turn);
      } catch (error) {
        await sweepR2Prefix(
          this.env.BACKUP_BUCKET,
          `backups/${backup.id}/`,
        ).catch(() => undefined);
        throw error;
      }
      const checkpointMs = Math.round(performance.now() - checkpointStarted);
      await this.event(turn, seq++, "checkpointed", {
        checkpointMs,
        backupId: backup.id,
      });
      await first.destroy();

      const restore = this.sandbox(secondSandboxId);
      await this.ctx.storage.put("sandboxId", secondSandboxId);
      const restoreStarted = performance.now();
      await restore.restoreBackup(backup as DirectoryBackup);
      const restoreMs = Math.round(performance.now() - restoreStarted);
      const restoredSession = await restore.createSession({
        id: sessionName(`publish-${turn.turnId}`),
        cwd: "/workspace/app",
        commandTimeoutMs,
      });
      const verify = await restoredSession.exec(
        "test -f dist/index.html && test -d dist/assets",
      );
      if (!verify.success)
        throw new Error(
          "Restored workspace did not contain the production build.",
        );
      await this.event(turn, seq++, "workspace_restored", { restoreMs });

      const files = await restoredSession.listFiles("/workspace/app/dist", {
        recursive: true,
      });
      const buildId = crypto.randomUUID();
      const artifactPrefix = `builds/${buildId}`;
      await this.ctx.storage.put(
        `transientBuild:${turn.turnId}`,
        artifactPrefix,
      );
      const slug = `orbit-${turn.appId.slice(-8)}`;
      let uploadedBytes = 0;
      for (const file of files.files.filter((entry) => entry.type === "file")) {
        const relative = file.absolutePath
          .replace(/^\/workspace\/app\/dist\/?/, "")
          .replace(/^dist\/?/, "");
        const read = await restoredSession.readFile(file.absolutePath, {
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(read.content), (char) =>
          char.charCodeAt(0),
        );
        uploadedBytes += bytes.byteLength;
        await this.assertTurnWritable(turn);
        const objectKey = `${artifactPrefix}/${relative}`;
        await this.env.APP_BUILDS.put(objectKey, bytes, {
          httpMetadata: { contentType: contentType(relative) },
          customMetadata: { buildId, appId: turn.appId },
        });
        try {
          await this.assertTurnWritable(turn);
        } catch (error) {
          await this.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
          throw error;
        }
      }
      const contextSource = `window.__STELLA_APP_CONTEXT__={...${JSON.stringify(
        {
          appId: turn.appId,
          convexSiteUrl: turn.convexCallbackBase,
        },
      )},bridge:window.parent!==window};\n`;
      uploadedBytes += new TextEncoder().encode(contextSource).byteLength;
      await this.assertTurnWritable(turn);
      const contextObjectKey = `${artifactPrefix}/stella-context.js`;
      await this.env.APP_BUILDS.put(contextObjectKey, contextSource, {
        httpMetadata: { contentType: "text/javascript; charset=utf-8" },
        customMetadata: { buildId, appId: turn.appId },
      });
      try {
        await this.assertTurnWritable(turn);
      } catch (error) {
        await this.env.APP_BUILDS.delete(contextObjectKey).catch(
          () => undefined,
        );
        throw error;
      }
      const previewUrl = `${this.env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/apps/${slug}/`;
      if (turn.autoActivate !== false) {
        await this.assertTurnWritable(turn);
        await this.env.APP_ROUTES.put(
          `app:${slug}`,
          JSON.stringify({
            appId: turn.appId,
            ownerId: turn.ownerId,
            buildId,
            artifactPrefix,
            suspended: false,
            updatedAt: Date.now(),
          }),
        );
        try {
          await this.assertTurnWritable(turn);
        } catch (error) {
          await this.env.APP_ROUTES.delete(`app:${slug}`).catch(
            () => undefined,
          );
          throw error;
        }
      }
      const metrics = {
        coldContainerStartMs,
        backupRestoreMs: restoreMs,
        firstPreviewMs,
        checkpointMs,
        uploadedBytes,
        wallClockMs: Math.round(performance.now() - requestStarted),
        ...executor.metrics,
        model: modelPayload.usage,
        capacity: {
          instanceType: "standard-4",
          vCpu: 4,
          memoryBytes: 12 * 1024 ** 3,
          diskBytes: 20 * 1024 ** 3,
        },
      };
      await this.callback(turn, "/api/cloud/builds", {
        buildId,
        appId: turn.appId,
        ownerId: turn.ownerId,
        artifactPrefix,
        previewUrl,
        metrics,
        slug,
        autoActivate: turn.autoActivate !== false,
        title: appTitle,
      });
      await this.ctx.storage.delete(`transientBuild:${turn.turnId}`);
      const result = {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        previewUrl,
        metrics,
      };
      await this.event(turn, seq++, "completed", result, true);
      await this.ctx.storage.put("terminal", true);
      await restore.destroy();
      await this.ctx.storage.deleteAll();
      log("info", "turn_completed", {
        turnId: turn.turnId,
        appId: turn.appId,
        buildId,
        wallClockMs: metrics.wallClockMs,
        activeCpuSeconds: metrics.activeCpuSeconds,
        uploadedBytes,
      });
      return json({ ok: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
      if (
        !(error instanceof OwnerPurgeFenceError) &&
        !(await this.ctx.storage.get<boolean>("terminal"))
      ) {
        await this.ctx.storage.put("terminal", true);
        // Only deliberately-written messages ("Stella …") reach the chat
        // bubble; raw provider/infra errors stay in the log line below.
        const friendly = message.startsWith("Stella")
          ? message
          : "Stella hit a problem while building. Try again.";
        await this.event(
          turn,
          seq++,
          "failed",
          { message: friendly },
          true,
        ).catch(() => undefined);
      }
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      if (sandboxId)
        await this.sandbox(sandboxId)
          .destroy()
          .catch(() => undefined);
      await first.destroy().catch(() => undefined);
      await this.ctx.storage.deleteAll();
      log("error", "turn_failed", {
        turnId: turn.turnId,
        appId: turn.appId,
        message,
      });
      return json({ error: "Cloud app turn failed.", detail: message }, 502);
    } finally {
      if (transientBackupId) {
        await sweepR2Prefix(
          this.env.BACKUP_BUCKET,
          `backups/${transientBackupId}/`,
        ).catch(() => undefined);
        await this.ctx.storage.delete(`transientBackup:${turn.turnId}`);
      }
      await this.unregisterTurn(turn);
    }
  }
}

// ── Owner-scoped storage outside Convex ──────────────────────────────────────

/**
 * THE LIST. Every store outside Convex that holds data belonging to one owner,
 * how it is addressed, and what deletes it. `POST /owners/purge` walks exactly
 * this list; a store that is not here is a store account deletion does not
 * reach, so adding one to the system without adding it here is the defect.
 *
 *  id                | where                    | addressed by
 *  ------------------|--------------------------|--------------------------------
 *  agent-home        | R2 AGENT_HOME            | `agent-home/<sha256(owner)>/`
 *  conversations     | R2 CONVERSATION_ARCHIVE  | `conversations/<sha256(owner)>/`
 *  interiors         | R2 APP_BUILDS            | `interiors/<sha256(owner)>/`
 *                    |                          | (also catches orphan uploads)
 *  backups           | R2 BACKUP_BUCKET         | `backups/<backupId>/` — the id
 *                    |                          | is only in the KV descriptor
 *  builds            | R2 APP_BUILDS            | app `builds/<buildId>/` or
 *                    |                          | interior
 *                    |                          | `interiors/<ownerHash>/<buildId>/`
 *  checkpoints       | KV APP_ROUTES            | `ws:<sha256(owner:workspace)>`
 *                    |                          | and `…:size`
 *  routes            | KV APP_ROUTES            | `app:<slug>`, owner in the value
 *
 * Deliberately NOT here, with the reason:
 *  - OrchestratorSession DO SQLite and the R2 objects its manifest names are
 *    purged per conversation through `POST /conversations/:id/purge`, because
 *    only the DO can say its own storage is gone. The `conversations/` prefix
 *    sweep above is the backstop for segments whose index row was already lost.
 *  - Sandbox / SandboxSmall / BuildSession DOs hold no durable owner state:
 *    each is destroyed at the end of the turn that created it, and a workspace
 *    that must survive is a `backups/` archive, which IS here.
 *  - The per-user drive bucket is bound to Convex (the @convex-dev/r2
 *    component), not to this worker. Convex deletes it from its own file rows;
 *    see DRIVE in convex/cloud_purge.ts.
 *
 * The two hash prefixes are duplicated from their owners deliberately —
 * importing `ConversationArchive` or `AgentHome` here would pull a DO-shaped
 * module into the worker entry for two string literals. They must stay in step
 * with `archive.ts` (`conversations/<hash>/`) and `agent-home.ts:163`
 * (`agent-home/<hash>/`).
 */
type OwnerPurgeRequest = {
  ownerId?: string;
  /** Issued by `/owners/purge/begin`; proves this owner is quiesced. */
  purgeGeneration?: string;
  /** Canonical workspace strings whose checkpoint + learned size must go. */
  workspaces?: string[];
  /** App slugs whose hosted route row must go. */
  appSlugs?: string[];
  /** App/interior build artifactPrefix values in APP_BUILDS. */
  buildPrefixes?: string[];
};

const ownerFenceStub = async (env: Env, ownerId: string) =>
  env.BUILD_SESSIONS.getByName(`owner-purge-${await sha256Hex(ownerId)}`);

const callOwnerFence = async (
  env: Env,
  ownerId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  (await ownerFenceStub(env, ownerId)).fetch(
    `https://build-session/owner-fence/${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

const withOwnerActivityLease = async <T>(
  env: Env,
  ownerId: string,
  activityId: string,
  operation: (generation: string, leaseId: string) => Promise<T>,
  workspace?: string,
): Promise<T> => {
  const sessionId = `activity-${activityId}`;
  const turnId = activityId;
  const leaseId = crypto.randomUUID();
  const registered = await callOwnerFence(env, ownerId, "register", {
    leaseId,
    sessionId,
    turnId,
    namespace: "activity",
    role: workspace ? "run" : "activity",
    ...(workspace ? { workspace } : {}),
  });
  const registration = (await registered.json().catch(() => null)) as {
    generation?: string;
  } | null;
  if (!registered.ok || !registration?.generation) {
    throw new OwnerPurgeFenceError();
  }
  try {
    return await operation(registration.generation, leaseId);
  } finally {
    await callOwnerFence(env, ownerId, "unregister", {
      leaseId,
      sessionId,
      turnId,
      generation: registration.generation,
    }).catch(() => undefined);
  }
};

const beginOwnerPurge = async (
  env: Env,
  ownerId: string,
  mode: OwnerPurgeMode,
): Promise<{ generation: string }> => {
  let response = await callOwnerFence(env, ownerId, "begin", { mode });
  if (!response.ok) throw new Error("Owner purge fence could not be created.");
  let state = (await response.json()) as {
    generation?: string;
    active?: OwnerPurgeFence["active"];
  };
  if (!state.generation) throw new Error("Owner purge fence was unreadable.");
  const generation = state.generation;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const active = Object.values(state.active ?? {});
    if (active.length === 0) return { generation };
    await Promise.all(
      active.map(async ({ leaseId, sessionId, turnId, namespace }) => {
        if (namespace === "activity") return;
        try {
          const target =
            namespace === "orchestrator"
              ? env.ORCHESTRATOR_SESSIONS
              : env.BUILD_SESSIONS;
          const id = target.idFromString(sessionId);
          await target
            .get(id)
            .fetch("https://build-session/owner-purge-cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ownerId,
                turnId,
                generation,
                leaseId,
              }),
            });
        } catch (error) {
          log("error", "owner_purge_turn_cancel_failed", {
            sessionId,
            message: errorMessage(error),
          });
        }
      }),
    );
    await scheduler.wait(250);
    response = await callOwnerFence(env, ownerId, "assert-blocked", {
      generation,
    });
    if (!response.ok)
      throw new Error("Owner purge fence changed unexpectedly.");
    state = (await response.json()) as typeof state;
  }
  throw new Error("Owner cloud turns did not quiesce before purge.");
};

type OwnerPurgeReport = {
  ok: true;
  deleted: number;
  /** Stores this pass did not finish. Non-empty means "ask again". */
  pending: string[];
};

/** Pages of 1000 keys per bucket prefix. 10M objects is not a real owner. */
const R2_SWEEP_MAX_PAGES = 10_000;
/** `crypto.randomUUID()` in the sandbox SDK; anything else is not a backup. */
const BACKUP_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The slug an app route is keyed by; same shape `resolveWorkspace` accepts. */
const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * A caller-supplied R2 prefix is a bucket-wipe primitive, so it is matched
 * against the two shapes this worker writes rather than merely checked for
 * non-emptiness. The interior form embeds a one-way owner hash and a
 * content-derived build id, so another owner's prefix cannot be smuggled in
 * through a path segment.
 */
const BUILD_PREFIX_PATTERN =
  /^(?:builds\/[A-Za-z0-9_-]{1,64}|interiors\/[0-9a-f]{64}\/interior-[0-9a-f]{48})$/;

/**
 * Delete every object under `prefix`. Bounded: `list` is cursor-paged at 1000
 * and each page is deleted before the next is fetched, so neither memory nor
 * the delete batch grows with the owner's history. `done: false` means the
 * sweep ran out of pages and the caller must ask again.
 */
const sweepR2Prefix = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<{ deleted: number; done: boolean }> => {
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!listing.truncated) return { deleted, done: true };
    cursor = listing.cursor;
  }
  return { deleted, done: false };
};

/**
 * Backfill for checkpoints written before cleanup debt existed. The sandbox
 * SDK stores `{name}` in `backups/<uuid>/meta.json`; our name is derived from
 * the owner/workspace checkpoint key, so a full metadata scan can attribute
 * old random backup ids without guessing or deleting another owner's data.
 */
const sweepBackupsByName = async (
  bucket: R2Bucket,
  name: string,
): Promise<{ deleted: number; done: boolean }> => {
  const backupIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix: "backups/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listing.objects) {
      const match = object.key.match(/^backups\/([0-9a-f-]{36})\/meta\.json$/i);
      if (!match || !BACKUP_ID_PATTERN.test(match[1]!)) continue;
      const metadata = await bucket.get(object.key);
      if (!metadata) continue;
      const parsed = (await metadata.json().catch(() => null)) as {
        name?: string | null;
      } | null;
      if (parsed?.name === name) backupIds.add(match[1]!);
    }
    if (!listing.truncated) {
      let deleted = 0;
      for (const backupId of backupIds) {
        const swept = await sweepR2Prefix(bucket, `backups/${backupId}/`);
        deleted += swept.deleted;
        if (!swept.done) return { deleted, done: false };
      }
      return { deleted, done: true };
    }
    cursor = listing.cursor;
  }
  return { deleted: 0, done: false };
};

const purgeOwnerStorage = async (
  env: Env,
  ownerId: string,
  request: OwnerPurgeRequest,
): Promise<OwnerPurgeReport> => {
  const pending: string[] = [];
  let deleted = 0;
  const fail = (store: string, error: unknown): void => {
    pending.push(store);
    log("error", "owner_storage_purge_step_failed", {
      store,
      message: errorMessage(error),
    });
  };

  const ownerHash = await sha256Hex(ownerId);
  const prefixTargets: {
    store: string;
    bucket: R2Bucket | undefined;
    prefix: string;
  }[] = [
    {
      store: "agent-home",
      bucket: env.AGENT_HOME,
      prefix: `agent-home/${ownerHash}/`,
    },
    {
      store: "conversations",
      bucket: env.CONVERSATION_ARCHIVE,
      prefix: `conversations/${ownerHash}/`,
    },
    {
      // Unlike app builds, every interior prefix is owner-addressable. Sweep
      // the whole namespace so uploads stranded before an idempotent candidate
      // callback cannot survive account deletion merely because no Convex row
      // ever got to name them.
      store: "interiors",
      bucket: env.APP_BUILDS,
      prefix: `interiors/${ownerHash}/`,
    },
  ];
  for (const target of prefixTargets) {
    // An unbound bucket is a deployment that has no such store, not a store
    // that failed to empty.
    if (!target.bucket) continue;
    try {
      const swept = await sweepR2Prefix(target.bucket, target.prefix);
      deleted += swept.deleted;
      if (!swept.done) pending.push(target.store);
    } catch (error) {
      fail(target.store, error);
    }
  }

  // Workspace checkpoints. The archive is named only by the descriptor, so the
  // descriptor is deleted last: a crash between the two leaves a KV key
  // pointing at bytes that are already gone (harmless — restore fails and the
  // workspace starts cold), never bytes with nothing left that names them.
  for (const raw of request.workspaces ?? []) {
    const workspace = resolveWorkspace(raw);
    // `computer` runs on the user's own machine and has no checkpoint here.
    if (workspace?.kind === "computer") continue;
    // Anything else this worker cannot parse is reported, never skipped: a
    // silently dropped name is a checkpoint that survives deletion while the
    // purge reports success, which is the exact failure this route guards.
    if (!workspace) {
      pending.push("checkpoint:unparseable");
      continue;
    }
    const store = `checkpoint:${workspace.canonical}`;
    try {
      const key = await checkpointKey(ownerId, workspace.canonical);
      const descriptor = await env.APP_ROUTES.get<DirectoryBackup>(key, "json");
      const debtKey = backupDebtKey(key);
      const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(
        debtKey,
        "json",
      );
      const backupIds = new Set<string>();
      if (descriptor?.id) backupIds.add(descriptor.id);
      for (const backupId of debt?.backupIds ?? []) backupIds.add(backupId);
      let backupSweepFailed = false;
      for (const backupId of backupIds) {
        if (!BACKUP_ID_PATTERN.test(backupId)) {
          pending.push(`${store}:invalid-backup`);
          backupSweepFailed = true;
          continue;
        }
        const swept = await sweepR2Prefix(
          env.BACKUP_BUCKET,
          `backups/${backupId}/`,
        );
        deleted += swept.deleted;
        if (!swept.done) {
          pending.push(store);
          backupSweepFailed = true;
        }
      }
      if (backupSweepFailed) continue;
      const historical = await sweepBackupsByName(
        env.BACKUP_BUCKET,
        checkpointBackupName(key),
      );
      deleted += historical.deleted;
      if (!historical.done) {
        pending.push(`${store}:historical-backups`);
        continue;
      }
      await env.APP_ROUTES.delete(key);
      await env.APP_ROUTES.delete(debtKey);
      // The learned instance size describes the deleted workspace's work, not
      // whatever reuses the slug next.
      await env.APP_ROUTES.delete(instanceSizeKey(key));
      // Counted only when there was something to delete: `deleted` is read off
      // the log to see how much an account actually held, and a fixed number
      // of unconditional KV deletes per workspace would drown that.
      if (descriptor) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  }

  // Hosted app routes. Deleting the row is strictly stronger than suspending
  // it, and the ownership check keeps a slug that has since been reissued to
  // someone else out of this owner's deletion.
  for (const slug of request.appSlugs ?? []) {
    if (typeof slug !== "string" || !APP_SLUG_PATTERN.test(slug)) {
      pending.push("route:unparseable");
      continue;
    }
    const store = `route:${slug}`;
    try {
      const route = await env.APP_ROUTES.get<{ ownerId?: string }>(
        `app:${slug}`,
        "json",
      );
      if (route && route.ownerId !== ownerId) continue;
      await env.APP_ROUTES.delete(`app:${slug}`);
      if (route) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  }

  // Build artifacts: the owner's app code and assets, still served by the
  // apps host until they are gone.
  const interiorOwnerPrefix = `interiors/${ownerHash}/`;
  for (const prefix of request.buildPrefixes ?? []) {
    if (
      typeof prefix !== "string" ||
      !BUILD_PREFIX_PATTERN.test(prefix) ||
      (prefix.startsWith("interiors/") &&
        !prefix.startsWith(interiorOwnerPrefix))
    ) {
      pending.push("build:unparseable");
      continue;
    }
    try {
      const swept = await sweepR2Prefix(env.APP_BUILDS, `${prefix}/`);
      deleted += swept.deleted;
      if (!swept.done) pending.push(`build:${prefix}`);
    } catch (error) {
      fail(`build:${prefix}`, error);
    }
  }

  return { ok: true, deleted, pending: Array.from(new Set(pending)) };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    log("info", "request_started", {
      requestId,
      method: request.method,
      path: url.pathname,
    });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "stella-v2-cloud-builder" });
    }

    // ── User-authenticated routes ─────────────────────────────────────────
    // These MUST stay above the service-secret gate below: a signed-in user
    // presents a Convex JWT, not the shared secret, so matching them after the
    // gate would 401 every client. Both verify the JWT themselves and forward
    // the proven identity to the DO in x-stella-* headers, stripping whatever
    // the client sent under those names first.
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
      return await forwardToConversation(
        request,
        env,
        conversationName(journalAppendMatch[1]!),
        "/journal",
        auth.caller,
      );
    }

    // ── Service-secret gate ───────────────────────────────────────────────
    // Everything past this line is server-to-server. Nothing may be added
    // above it without its own authentication: falling through this check is
    // how a route silently inherits "no auth at all".
    if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
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
      return env.BUILD_SESSIONS.getByName(turnMatch[1]!).fetch(
        "https://build-session/turn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        },
      );
    }
    // The orchestrator loop: one DO per conversation, no sandbox.
    const chatTurnMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/turns$/,
    );
    if (request.method === "POST" && chatTurnMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(chatTurnMatch[1]!),
      ).fetch("https://orchestrator-session/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }
    const chatCancelMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/cancel$/,
    );
    if (request.method === "POST" && chatCancelMatch) {
      return env.ORCHESTRATOR_SESSIONS.getByName(
        conversationName(chatCancelMatch[1]!),
      ).fetch("https://orchestrator-session/cancel", { method: "POST" });
    }
    // Convex-driven writes into a conversation's journal, plus the operator
    // surfaces. Pure pass-throughs: the DO owns every decision, this worker
    // only proves the caller holds the service secret.
    const conversationAdminMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/(cards|purge|reindex)$/,
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
    // The dev probe. There are no tests in this repo by decision, so reading a
    // conversation's journal back over the service secret is the verification
    // tool — keep it working.
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
    // Deleting a workspace deletes its checkpoint. Without this a new
    // project reusing a deleted project's slug hashes to the same key and
    // restores the deleted project's files on its first turn.
    if (request.method === "POST" && url.pathname === "/workspaces/purge") {
      const body = (await request.json()) as {
        ownerId?: string;
        workspace?: string;
      };
      const workspace = resolveWorkspace(body.workspace);
      if (!body.ownerId || !workspace || workspace.kind === "computer") {
        return json({ error: "ownerId and a cloud workspace required." }, 400);
      }
      const key = await checkpointKey(body.ownerId, workspace.canonical);
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          requestId,
          async () => {
            const descriptor = await env.APP_ROUTES.get<DirectoryBackup>(
              key,
              "json",
            );
            const debtKey = backupDebtKey(key);
            const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(
              debtKey,
              "json",
            );
            const backupIds = new Set<string>();
            if (descriptor?.id) backupIds.add(descriptor.id);
            for (const backupId of debt?.backupIds ?? []) {
              backupIds.add(backupId);
            }
            for (const backupId of backupIds) {
              if (!BACKUP_ID_PATTERN.test(backupId)) {
                throw new Error("Workspace backup descriptor is invalid.");
              }
              const swept = await sweepR2Prefix(
                env.BACKUP_BUCKET,
                `backups/${backupId}/`,
              );
              if (!swept.done) {
                throw new Error("Workspace backup purge was truncated.");
              }
            }
            const historical = await sweepBackupsByName(
              env.BACKUP_BUCKET,
              checkpointBackupName(key),
            );
            if (!historical.done) {
              throw new Error(
                "Historical workspace backup scan was truncated.",
              );
            }
            // Bytes first; these keys are the only recovery names.
            await env.APP_ROUTES.delete(key);
            await env.APP_ROUTES.delete(debtKey);
            await env.APP_ROUTES.delete(instanceSizeKey(key));
          },
          workspace.canonical,
        );
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json({ error: "Owner cloud activity is being purged." }, 409);
        }
        log("error", "workspace_checkpoint_purge_failed", {
          requestId,
          workspace: workspace.canonical,
          message: errorMessage(error),
        });
        return json({ error: "Workspace checkpoint purge failed." }, 502);
      }
      log("info", "workspace_checkpoint_purged", {
        requestId,
        workspace: workspace.canonical,
      });
      return json({ ok: true });
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
    //   - The named stores (`workspaces`, `appSlugs`, `buildPrefixes`) cannot
    //     be derived from the owner id — a checkpoint key hashes
    //     `<owner>:<workspace>` and a build artifact prefix is keyed by build
    //     id — so Convex reads them off the rows and sends them here BEFORE
    //     deleting those rows. Bytes first, then the only name they had.
    if (request.method === "POST" && url.pathname === "/owners/purge/begin") {
      const body = (await request.json()) as {
        ownerId?: string;
        mode?: OwnerPurgeMode;
      };
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      if (!ownerId) return json({ error: "ownerId required." }, 400);
      try {
        return json(
          await beginOwnerPurge(
            env,
            ownerId,
            body.mode === "permanent" ? "permanent" : "temporary",
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
    if (request.method === "POST" && url.pathname === "/owners/purge") {
      const body = (await request.json()) as OwnerPurgeRequest;
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      if (!ownerId || !body.purgeGeneration) {
        return json({ error: "ownerId and purgeGeneration required." }, 400);
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
      const report = await purgeOwnerStorage(env, ownerId, body);
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
        buildId: string;
        artifactPrefix: string;
      };
      try {
        await withOwnerActivityLease(
          env,
          body.ownerId,
          requestId,
          async (generation, leaseId) => {
            await env.APP_ROUTES.put(
              `app:${body.slug}`,
              JSON.stringify({
                ...body,
                suspended: false,
                updatedAt: Date.now(),
              }),
            );
            const fenced = await callOwnerFence(env, body.ownerId, "assert", {
              generation,
              leaseId,
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
      };
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
} satisfies ExportedHandler<Env>;
