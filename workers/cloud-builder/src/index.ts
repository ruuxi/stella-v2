import { DurableObject } from "cloudflare:workers";
import {
  getSandbox,
  Sandbox as SandboxBase,
  type DirectoryBackup,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { OrchestratorSession } from "./orchestrator-session.js";
import { sha256Hex } from "./hash.js";
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
  // Resolved by Convex at dispatch: run the agent's model calls on the
  // owner's connected engine subscription (flag only — never a credential).
  engine?: { provider: string; model: string };
};

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
  payload: Record<string, unknown>;
  /** Message for the thread's final state; a completed turn sends its report. */
  threadError?: string;
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
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

export class BuildSession extends DurableObject<Env> {
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

  private async callback(
    turn: TurnRequest,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
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
      // `terminal` first and alone: it is what fences every other path in this
      // DO, and it has to be set even when the payload is too large to store.
      await this.ctx.storage.put("terminal", true);
      await this.ctx.storage
        .put({ pendingTerminal: pending, alarmAttempts: 0 })
        .catch((error: unknown) =>
          log("error", "terminal_persist_failed", {
            turnId: turn.turnId,
            message: errorMessage(error),
          }),
        );
    }
    try {
      // Turn-scoped and unconditional: this is what gives the turn — orphaned
      // or not — its one terminal state, and Convex rejects a second one.
      await this.event(turn, "auto", pending.kind, pending.payload, true);
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
      if (attempts > 5) {
        await this.ctx.storage.put("terminalDelivered", true);
        log("error", "terminal_delivery_abandoned", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
        return false;
      }
      await this.ctx.storage.put("alarmAttempts", attempts);
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return false;
    }
  }

  async alarm(): Promise<void> {
    const turn = await this.ctx.storage.get<TurnRequest>("turn");
    if (!turn || (await this.ctx.storage.get<boolean>("terminalDelivered")))
      return;
    // A terminal state already decided is not a timeout: the run finished, its
    // workspace is checkpointed, and the only thing left is getting the result
    // to Convex. Redelivering that is the whole point of the alarm here.
    const pending =
      await this.ctx.storage.get<PendingTerminal>("pendingTerminal");
    if (pending) {
      if (pending.turnId !== turn.turnId) {
        await this.ctx.storage.delete("pendingTerminal");
      } else {
        if (
          (await this.deliverTerminal(turn, pending)) &&
          (await this.ownsTurn(turn.turnId))
        ) {
          await this.ctx.storage.deleteAll();
        }
        return;
      }
    }
    await this.ctx.storage.put("terminal", true);
    const sandboxId = await this.ctx.storage.get<string>("sandboxId");
    await (await this.currentSandbox())?.destroy().catch(() => undefined);
    log("error", "turn_timed_out", {
      turnId: turn.turnId,
      appId: turn.appId,
      sandboxId,
    });
    // Auto-seq: agent turns stream unbounded auto-seq events, so any fixed
    // sentinel eventually collides and Convex drops the terminal patch,
    // leaving the turn "running" forever. Idempotency comes from Convex
    // rejecting events after the first terminal one, not from the seq —
    // and delivery is retried via re-armed alarms, single-shot fire-and-
    // forget would strand the turn (and its thread) "running" on one
    // transient Convex failure.
    try {
      const result = await this.event(
        turn,
        "auto",
        "timeout",
        {
          message:
            "This took longer than expected, so Stella stopped. Try again.",
        },
        true,
      );
      if (
        result.terminalAccepted === false &&
        !(await this.ctx.storage.get<boolean>("alarmReconcile"))
      ) {
        // The turn reached terminal on its own in the same instant; give its
        // thread completion a beat to land before the failed backstop below —
        // racing it would mark a genuinely completed thread failed.
        await this.ctx.storage.put("alarmReconcile", true);
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
        return;
      }
      if (turn.kind === "agent" && turn.threadId) {
        await this.callback(turn, "/api/cloud/threads/complete", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          status: "failed",
          errorMessage: "The agent ran out of time and was stopped.",
        });
      }
      await this.ctx.storage.put("terminalDelivered", true);
    } catch (error) {
      const attempts =
        ((await this.ctx.storage.get<number>("alarmAttempts")) ?? 0) + 1;
      if (attempts <= 5) {
        await this.ctx.storage.put("alarmAttempts", attempts);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      } else {
        await this.ctx.storage.put("terminalDelivered", true);
        log("error", "terminal_delivery_abandoned", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/cancel") {
      const sandboxId = await this.ctx.storage.get<string>("sandboxId");
      await (await this.currentSandbox())?.destroy().catch(() => undefined);
      const turn = await this.ctx.storage.get<TurnRequest>("turn");
      if (turn && !(await this.ctx.storage.get<boolean>("terminal"))) {
        log("info", "turn_canceled", {
          turnId: turn.turnId,
          appId: turn.appId,
          sandboxId,
        });
        // Delivery failure here re-arms the alarm rather than stranding the
        // turn and its thread "running" forever.
        await this.deliverTerminal(turn, {
          turnId: turn.turnId,
          kind: "canceled",
          payload: { message: "Stopped. Nothing was changed." },
          threadError: "The agent was stopped.",
        });
      }
      return json({ canceled: true });
    }
    if (url.pathname === "/echo") return this.runEcho();
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const turn = (await request.json()) as TurnRequest;
    if (turn.kind === "agent") return this.acceptAgentTurn(turn);
    return this.runTurn(turn);
  }

  // Accept the dispatch immediately and run the turn in the background: a
  // sandbox turn takes minutes, and holding the POST open that long means a
  // mid-turn transport failure makes Convex mark a still-running turn (and
  // its thread) failed while the agent goes on to finish. Outcomes reach
  // Convex only through events/threads-complete callbacks.
  private async acceptAgentTurn(turn: TurnRequest): Promise<Response> {
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
      void this.deliverTerminal(orphanTurn, orphan).catch(() => undefined);
    }
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
    );
    void this.runAgentTurn(turn, sandboxId).catch(() => undefined);
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
        await this.env.APP_ROUTES.put(instanceSizeKey(workspaceKey), size, {
          expirationTtl: 30 * 86_400,
        }).catch(() => undefined);
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

      // Checkpoint even after a failed loop — partial work in the workspace
      // is still the user's work.
      let checkpointMs = 0;
      let checkpointError: string | undefined;
      for (let retry = 0; retry < 2; retry += 1) {
        try {
          const checkpointStarted = performance.now();
          const backup = await sandbox.createBackup({
            dir: workspaceRoot,
            name: checkpointBackupName(workspaceKey),
            ttl: 30 * 86_400,
            localBucket: true,
            compression: { format: "zstd", threads: 2 },
          });
          checkpointMs = Math.round(performance.now() - checkpointStarted);
          await this.env.APP_ROUTES.put(workspaceKey, JSON.stringify(backup));
          checkpointError = undefined;
          break;
        } catch (error) {
          checkpointError = errorMessage(error);
        }
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
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        await this.ctx.storage.deleteAll();
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
        await this.ctx.storage.deleteAlarm().catch(() => undefined);
        await this.ctx.storage.deleteAll();
      }
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
          workspace: turn.workspace ?? "drive",
          convexCallbackBase: turn.convexCallbackBase,
          history: args.history,
          ...(projectInput ? { project: projectInput } : {}),
          ...(turn.engine ? { engine: turn.engine } : {}),
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
    const requestStarted = performance.now();
    log("info", "turn_started", {
      turnId: turn.turnId,
      appId: turn.appId,
      sessionId: this.ctx.id.toString(),
      autoActivate: turn.autoActivate !== false,
    });
    try {
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
      const backup = await first.createBackup({
        dir: "/workspace/app",
        name: `stella-${turn.appId}`,
        ttl: 86_400,
        localBucket: true,
        compression: { format: "zstd", threads: 2 },
      });
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
        await this.env.APP_BUILDS.put(`${artifactPrefix}/${relative}`, bytes, {
          httpMetadata: { contentType: contentType(relative) },
          customMetadata: { buildId, appId: turn.appId },
        });
      }
      const contextSource = `window.__STELLA_APP_CONTEXT__={...${JSON.stringify(
        {
          appId: turn.appId,
          convexSiteUrl: turn.convexCallbackBase,
        },
      )},bridge:window.parent!==window};\n`;
      uploadedBytes += new TextEncoder().encode(contextSource).byteLength;
      await this.env.APP_BUILDS.put(
        `${artifactPrefix}/stella-context.js`,
        contextSource,
        {
          httpMetadata: { contentType: "text/javascript; charset=utf-8" },
          customMetadata: { buildId, appId: turn.appId },
        },
      );
      const previewUrl = `${this.env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/apps/${slug}/`;
      if (turn.autoActivate !== false) {
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
      if (!(await this.ctx.storage.get<boolean>("terminal"))) {
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
 *  backups           | R2 BACKUP_BUCKET         | `backups/<backupId>/` — the id
 *                    |                          | is only in the KV descriptor
 *  builds            | R2 APP_BUILDS            | `<artifactPrefix>/`, keyed by
 *                    |                          | build id, not by owner
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
  /** Canonical workspace strings whose checkpoint + learned size must go. */
  workspaces?: string[];
  /** App slugs whose hosted route row must go. */
  appSlugs?: string[];
  /** `cloud_app_builds.artifactPrefix` values in APP_BUILDS. */
  buildPrefixes?: string[];
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
 * against the one shape this worker ever writes (`artifactPrefix` at the app
 * build step, `builds/<crypto.randomUUID()>`) rather than merely checked for
 * non-emptiness.
 */
const BUILD_PREFIX_PATTERN = /^builds\/[A-Za-z0-9_-]{1,64}$/;

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
      if (descriptor?.id && BACKUP_ID_PATTERN.test(descriptor.id)) {
        const swept = await sweepR2Prefix(
          env.BACKUP_BUCKET,
          `backups/${descriptor.id}/`,
        );
        deleted += swept.deleted;
        if (!swept.done) {
          pending.push(store);
          continue;
        }
      }
      await env.APP_ROUTES.delete(key);
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
  for (const prefix of request.buildPrefixes ?? []) {
    if (typeof prefix !== "string" || !BUILD_PREFIX_PATTERN.test(prefix)) {
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
      await env.APP_ROUTES.delete(key);
      // The learned instance size describes the deleted workspace's work, not
      // whatever reuses the slug next.
      await env.APP_ROUTES.delete(instanceSizeKey(key));
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
    if (request.method === "POST" && url.pathname === "/owners/purge") {
      const body = (await request.json()) as OwnerPurgeRequest;
      const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
      if (!ownerId) return json({ error: "ownerId required." }, 400);
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
      await env.APP_ROUTES.put(
        `app:${body.slug}`,
        JSON.stringify({
          ...body,
          suspended: false,
          updatedAt: Date.now(),
        }),
      );
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
      await env.APP_ROUTES.put(
        `app:${body.slug}`,
        JSON.stringify({
          ...route,
          suspended: true,
          updatedAt: Date.now(),
        }),
      );
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
