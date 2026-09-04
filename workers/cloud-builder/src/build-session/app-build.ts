/**
 * The app-build lane: the whole turn body for an app-build turn, the
 * Stella-interior candidate publication it can be asked to perform, the
 * durable publication debt that replays the Convex callback after response
 * loss, the agent-only Vite preview proxy, and the container echo probe.
 *
 * Extracted verbatim from `src/index.ts`; every cross-cluster call goes back
 * through `host` so this module imports no other build-session module.
 */
import type { BuildSessionInternals } from "./host.js";
import { emitCloudTurnTelemetry } from "../telemetry.js";
import { inSubshell } from "../shell-subshell.js";
import { sha256BytesHex, sha256Hex } from "../hash.js";
import { WORLD_STELLA_ROOT } from "../workspace.js";
import { cloudModelRequestId } from "../cloud-model-request.js";
import { classifyAgentFailureDiagnostic } from "../agent-failure-diagnostic.js";
import {
  APP_BUILD_SESSION_ENV,
  startStrictSessionProcess,
  strictSessionExec,
} from "../strict-session-process.js";
import { ownerAppBuildPrefix } from "../app-build-artifacts.js";
import {
  PREVIEW_ACCESS_MAX_TTL_MS,
  PREVIEW_ACCESS_STORAGE_KEY,
  issuePreviewAccessCapability,
  resolvePreviewTunnelRequest,
  verifyPreviewAccessCapability,
} from "../vite-preview-access.js";
import {
  exactInteriorBuildRequested,
  interiorBuildRequestKey,
  type InteriorBuildRequestRecord,
} from "../interior-build-request.js";
import type { TurnExecutionContext } from "../turn-cancellation.js";
import type {
  BuildRecordedEvent,
  InteriorBuildRecordedEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  APP_TURN_ADMISSION_CLAIM_KEY,
  HEADER_PREVIEW_CAPABILITY,
  SHA256_HEX,
  contentType,
  errorMessage,
  exactTurnIdentityMatches,
  exactTurnSandboxId,
  executionFailureFields,
  json,
  log,
  normalizeToolWorkspaceRoot,
  pendingAppBuildPublicationKey,
  sessionName,
  sweepR2Prefix,
} from "./shared/keys.js";
import {
  AppTurnAuthorityLostError,
  OwnerPurgeFenceError,
} from "./shared/errors.js";
import type {
  AppTurnAdmissionClaim,
  Execution,
  ExecutorResult,
  InteriorBuildOutput,
  PendingAppBuildPublication,
  TurnRequest,
} from "./shared/types.js";

export type AppBuildHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "assertAgentExecutionActive"
  | "assertAppExecutionActive"
  | "assertAppTurnIdentity"
  | "assertTurnWritable"
  | "cleanupTransientWrites"
  | "convexCall"
  | "deleteTurnStoragePreservingExactCancellations"
  | "destroySandboxDurably"
  | "enqueueOutboxDurable"
  | "event"
  | "mutateExactTurn"
  | "outboxBase"
  | "publishInteriorCandidate"
  | "ownsExactTurn"
  | "retireTerminalAppTurnStorage"
  | "sandbox"
  | "unregisterTurn"
>;

const INTERIOR_BRIDGE_ABI = 1;
const INTERIOR_MIN_SHELL_VERSION = "0.0.0";
const INTERIOR_MAX_FILES = 2_000;
const INTERIOR_MAX_BYTES = 100 * 1024 * 1024;
const INTERIOR_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SAFE_ARTIFACT_PATH =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/**
 * Build and publish an immutable Stella-interior candidate.
 *
 * The source tree is agent-controlled, so the immutable executor script
 * applies the first set of bounds and this Worker repeats all trust-boundary
 * checks while reading the output. The callback records a candidate only;
 * activation remains an authenticated user/control-plane operation.
 */
export const publishInteriorCandidate = async (
  host: AppBuildHost,
  turn: TurnRequest,
  sandbox: ReturnType<BuildSessionInternals["sandbox"]>,
  commandTimeoutMs: number,
  turnExecution: TurnExecutionContext,
): Promise<{
  buildId: string;
  artifactPrefix: string;
  previewUrl: string;
  digest: string;
  size: number;
  sourceRevision: string;
  baseRevision?: string;
}> => {
  await host.assertAgentExecutionActive(turn, turnExecution);
  if (!turn.threadId) {
    throw new Error("Invalid Stella interior build context.");
  }
  let unrecordedArtifactPrefix: string | undefined;
  let callbackAttempted = false;
  const buildRoot = `/workspace/.stella-interior-build/${sessionName(turn.turnId)}`;
  const outputRoot = `${buildRoot}/dist`;
  turnExecution.assertActive();
  const session = await sandbox.createSession({
    id: sessionName(`interior-build-${turn.turnId}`),
    cwd: "/opt/stella",
    commandTimeoutMs,
    env: {
      STELLA_INTERIOR_SOURCE_ROOT: WORLD_STELLA_ROOT,
      STELLA_INTERIOR_OUTPUT_ROOT: outputRoot,
      VITE_CONVEX_URL: requirePublicOrigin(
        host.env.STELLA_CONVEX_CLOUD_URL,
        "STELLA_CONVEX_CLOUD_URL",
      ),
      VITE_CONVEX_SITE_URL: requirePublicOrigin(
        host.env.STELLA_CONVEX_SITE_URL,
        "STELLA_CONVEX_SITE_URL",
      ),
      VITE_STELLA_APPS_HOST: requirePublicOrigin(
        host.env.APPS_HOST_BASE_URL,
        "APPS_HOST_BASE_URL",
      ),
      VITE_STELLA_APPS_AUTH_HOST: requirePublicOrigin(
        host.env.TRUSTED_APPS_HOST_BASE_URL,
        "TRUSTED_APPS_HOST_BASE_URL",
      ),
      VITE_STELLA_PROTOCOL: "stella",
      USER: "stella-tools",
      LOGNAME: "stella-tools",
      HOME: "/workspace/.stella-tool-home",
      XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
      XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
      XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
    },
  });
  turnExecution.assertActive();
  try {
    turnExecution.assertActive();
    const preparedBuildRoot = await session.exec(
      inSubshell(
        [
          "set -eu",
          "test ! -L /workspace/.stella-interior-build 2>/dev/null || exit 1",
          "if [ -e /workspace/.stella-interior-build ]; then test -d /workspace/.stella-interior-build && test \"$(stat -c '%u:%g:%a' /workspace/.stella-interior-build)\" = 0:0:700; else mkdir /workspace/.stella-interior-build && chmod 0700 /workspace/.stella-interior-build; fi",
          `rm -rf '${buildRoot}'`,
          `mkdir '${buildRoot}'`,
          `chown 42424:42424 '${buildRoot}'`,
          `chmod 0700 '${buildRoot}'`,
        ].join("; "),
      ),
    );
    if (!preparedBuildRoot.success) {
      throw new Error(
        "The Stella interior build boundary could not be prepared.",
      );
    }
    const execution = (await strictSessionExec(
      session,
      ["bun", "packages/executor-cloud/src/interior-build.ts"],
      { timeout: commandTimeoutMs },
    )) as Execution;
    turnExecution.assertActive();
    if (!execution.success) {
      log("error", "interior_build_command_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        ...executionFailureFields(execution.stderr),
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
      throw new Error("The Stella interior builder returned invalid metadata.");
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
    turnExecution.assertActive();
    await host.ctx.storage.put(`transientBuild:${turn.turnId}`, artifactPrefix);
    turnExecution.assertActive();
    let appsHost: URL;
    try {
      appsHost = new URL(host.env.APPS_HOST_BASE_URL);
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
      turnExecution.assertActive();
      const read = await session.readFile(`${outputRoot}/${file.path}`, {
        encoding: "base64",
      });
      turnExecution.assertActive();
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
      await host.assertAgentExecutionActive(turn, turnExecution);
      const objectKey = `${artifactPrefix}/${file.path}`;
      await host.env.APP_BUILDS.put(objectKey, bytes, {
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
        await host.assertAgentExecutionActive(turn, turnExecution);
      } catch (error) {
        await host.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
        throw error;
      }
    }

    // Re-check the DO fence after the expensive build/upload and before the
    // only durable control-plane effect. Uploaded bytes are immutable and
    // harmless if a successor won; no candidate row points to them.
    await host.assertAgentExecutionActive(turn, turnExecution);
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
    turnExecution.assertActive();
    await host.assertTurnWritable(turn);
    turnExecution.assertActive();
    // The projection is the outbox's problem now: the bytes are already in
    // R2 under `artifactPrefix`, and the event that names them is durable
    // the moment it is queued (or recorded as debt and retried by the
    // alarm). There is nothing left here for a bespoke retry ladder to do.
    await host.enqueueOutboxDurable([
      {
        ...host.outboxBase(turn, buildId),
        kind: "interior-build.recorded",
        buildId,
        payload: callbackBody,
      } satisfies InteriorBuildRecordedEvent,
    ]);
    turnExecution.assertActive();
    turnExecution.assertActive();
    await host.ctx.storage.delete(`transientBuild:${turn.turnId}`);
    turnExecution.assertActive();

    // This builder-owned state is checkpointed with the source but excluded
    // from the next source digest. It supplies the next candidate's explicit
    // baseRevision, including across sandbox destruction/restoration.
    await session.writeFile(
      `${WORLD_STELLA_ROOT}/.stella/interior-source.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRevision: output.sourceRevision,
        upstreamSeedRevision: output.upstreamSeedRevision,
        buildId,
      })}\n`,
    );
    turnExecution.assertActive();
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
        host.env.APP_BUILDS,
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
        await host.ctx.storage.delete(`transientBuild:${turn.turnId}`);
      }
    }
    throw error;
  } finally {
    await session
      .exec("rm -rf /workspace/.stella-interior-build")
      .catch(() => undefined);
    await sandbox.deleteSession(session.id).catch(() => undefined);
  }
};

/**
 * Interior builds are opt-in: the agent asks for one through the turn broker
 * during the turn, and this runs after the executor is gone because
 * `publishInteriorCandidate` quiesces the session it would still be using.
 */
export const publishRequestedInteriorCandidate = async (
  host: AppBuildHost,
  args: {
    turn: TurnRequest;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
    commandTimeoutMs: number;
    turnExecution: TurnExecutionContext;
  },
): Promise<
  | { outcome: "not_requested" }
  | { outcome: "abandoned" }
  | { outcome: "failed"; error: string }
  | {
      outcome: "published";
      candidate: Awaited<
        ReturnType<BuildSessionInternals["publishInteriorCandidate"]>
      >;
    }
> => {
  const { turn, turnExecution } = args;
  const requested = await host.ctx.storage.get<InteriorBuildRequestRecord>(
    interiorBuildRequestKey(turn.turnId, turn.attemptGeneration!),
  );
  if (
    !exactInteriorBuildRequested(
      requested,
      turn.turnId,
      turn.attemptGeneration!,
    )
  ) {
    return { outcome: "not_requested" };
  }
  await host
    .event(
      turn,
      "auto",
      "interior_build_started",
      {},
      false,
      turnExecution.signal,
    )
    .catch(() => undefined);
  try {
    const candidate = await host.publishInteriorCandidate(
      turn,
      args.sandbox,
      args.commandTimeoutMs,
      turnExecution,
    );
    await host
      .event(
        turn,
        "auto",
        "interior_candidate_created",
        {
          buildId: candidate.buildId,
          previewUrl: candidate.previewUrl,
          digest: candidate.digest,
          size: candidate.size,
          sourceRevision: candidate.sourceRevision,
          baseRevision: candidate.baseRevision,
          activated: false,
        },
        false,
        turnExecution.signal,
      )
      .catch(() => undefined);
    return { outcome: "published", candidate };
  } catch (error) {
    if (
      !(await host.ownsExactTurn(turn)) ||
      (await host.ctx.storage.get<boolean>("terminal"))
    ) {
      return { outcome: "abandoned" };
    }
    log("error", "interior_candidate_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message: errorMessage(error),
    });
    await host
      .event(
        turn,
        "auto",
        "interior_build_failed",
        {
          message:
            "The updated Stella interior did not pass its production build.",
        },
        false,
        turnExecution.signal,
      )
      .catch(() => undefined);
    return {
      outcome: "failed",
      error:
        "The agent's source changes were kept, but the updated Stella interior did not pass its production build, so no candidate was created.",
    };
  }
};

const scheduleAppBuildPublicationRetry = async (
  host: AppBuildHost,
  turn: TurnRequest,
  error: unknown,
): Promise<boolean> => {
  let attempts = 0;
  let retryDelayMs = 0;
  const retained = await host.mutateExactTurn(turn, async (txn) => {
    attempts =
      ((await txn.get<number>("appBuildPublicationAttempts")) ?? 0) + 1;
    retryDelayMs = Math.min(
      15 * 60_000,
      5_000 * 2 ** Math.min(attempts - 1, 7),
    );
    await txn.put("appBuildPublicationAttempts", attempts);
    await txn.setAlarm(Date.now() + retryDelayMs);
  });
  if (!retained) return false;
  log("error", "app_build_publication_retrying", {
    turnId: turn.turnId,
    attempts,
    retryDelayMs,
    message: errorMessage(error),
  });
  return true;
};

/**
 * Replays the idempotent build callback after response loss. Permanent 4xx
 * rejection transitions to cleanup, where the public route and every R2
 * object are removed before the recovery marker can disappear.
 */
export const advanceAppBuildPublication = async (
  host: AppBuildHost,
  turn: TurnRequest,
  pending: PendingAppBuildPublication,
): Promise<"completed" | "failed" | "retrying" | "superseded"> => {
  const state = pending;
  if (state.phase === "callback" && state.buildId) {
    try {
      await host.enqueueOutboxDurable([
        {
          ...host.outboxBase(turn, state.buildId),
          kind: "build.recorded",
          buildId: state.buildId,
          payload: state.callbackBody,
        } satisfies BuildRecordedEvent,
      ]);
    } catch (error) {
      return (await scheduleAppBuildPublicationRetry(host, turn, error))
        ? "retrying"
        : "superseded";
    }
  }

  if (state.phase === "cleanup") {
    try {
      await host.cleanupTransientWrites(turn);
    } catch (error) {
      return (await scheduleAppBuildPublicationRetry(host, turn, error))
        ? "retrying"
        : "superseded";
    }
    try {
      await host.event(
        turn,
        state.completionSeq,
        "failed",
        {
          message:
            state.failureMessage ??
            "Stella hit a problem while publishing. Try again.",
        },
        true,
      );
    } catch (error) {
      return (await scheduleAppBuildPublicationRetry(host, turn, error))
        ? "retrying"
        : "superseded";
    }
    if (
      !(await host.mutateExactTurn(turn, async (txn) => {
        await txn.delete(pendingAppBuildPublicationKey(turn.turnId));
        await txn.put({ terminal: true, terminalDelivered: true });
      }))
    ) {
      return "superseded";
    }
    return "failed";
  }

  try {
    await host.event(
      turn,
      state.completionSeq,
      "completed",
      state.completionResult,
      true,
    );
  } catch (error) {
    return (await scheduleAppBuildPublicationRetry(host, turn, error))
      ? "retrying"
      : "superseded";
  }
  if (
    !(await host.mutateExactTurn(turn, async (txn) => {
      await txn.delete([
        pendingAppBuildPublicationKey(turn.turnId),
        `transientBuild:${turn.turnId}`,
        "appBuildPublicationAttempts",
      ]);
      await txn.put({ terminal: true, terminalDelivered: true });
    }))
  ) {
    return "superseded";
  }
  return "completed";
};

export const runEcho = async (host: AppBuildHost): Promise<Response> => {
  // Every diagnostic run gets its own lifecycle identity as well; a delayed
  // destroy alarm from one echo can never target the next echo's container.
  const sandboxId = `echo-${crypto.randomUUID()}`;
  const sandbox = host.sandbox(sandboxId);
  await host.ctx.storage.put("sandboxId", sandboxId);
  try {
    const session = await sandbox.createSession({
      id: sessionName(`echo-${crypto.randomUUID()}`),
      cwd: "/opt/stella",
      commandTimeoutMs: Number(host.env.TURN_TIMEOUT_MS),
    });
    const execution = await session.exec(
      "bun packages/executor-cloud/src/cli.ts --stub",
      { timeout: Number(host.env.TURN_TIMEOUT_MS) },
    );
    await sandbox.deleteSession(session.id).catch(() => undefined);
    if (!execution.success) {
      return json(
        {
          error: "Executor echo failed.",
          code: `executor.${classifyAgentFailureDiagnostic(execution.stderr)}`,
        },
        502,
      );
    }
    return json({
      ok: true,
      executor: JSON.parse(execution.stdout.trim().split("\n").at(-1) ?? "{}"),
    });
  } catch {
    return json(
      { error: "Sandbox echo failed.", code: "sandbox.echo_failed" },
      502,
    );
  } finally {
    await host
      .destroySandboxDurably(
        { sandboxId, size: "large", workload: "app-build" },
        "echo_terminal",
      )
      .catch(() => undefined);
    await host.deleteTurnStoragePreservingExactCancellations(undefined, true);
  }
};

/**
 * Agent-only Vite access. The outer Worker routes by BuildSession name; this
 * object re-verifies the signed exact turn/sandbox scope and the durable
 * active nonce before a single byte reaches the raw tunnel.
 */
export const proxyVitePreview = async (
  host: AppBuildHost,
  request: Request,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed." }, 405);
  }
  const capability = request.headers.get(HEADER_PREVIEW_CAPABILITY) ?? "";
  const [turn, sandboxId, terminal, activeRecord] = await Promise.all([
    host.ctx.storage.get<TurnRequest>("turn"),
    host.ctx.storage.get<string>("sandboxId"),
    host.ctx.storage.get<boolean>("terminal"),
    host.ctx.storage.get(PREVIEW_ACCESS_STORAGE_KEY),
  ]);
  if (
    !turn ||
    turn.kind === "agent" ||
    terminal === true ||
    !sandboxId ||
    !turn.previewRoute
  ) {
    return json({ error: "Preview is no longer active." }, 410);
  }
  const verified = await verifyPreviewAccessCapability({
    capability,
    secret: host.env.BUILDER_SERVICE_SECRET,
    expected: {
      buildSessionName: turn.previewRoute.buildSessionName,
      turnId: turn.turnId,
      sandboxId,
    },
    activeRecord,
    now: Date.now(),
  });
  if (!verified.ok) {
    return json(
      { error: "Preview access was rejected.", code: verified.code },
      verified.code === "expired" || verified.code === "inactive" ? 410 : 403,
    );
  }
  const incoming = new URL(request.url);
  const target = resolvePreviewTunnelRequest({
    tunnelUrl: verified.tunnelUrl,
    proxyPathname: incoming.pathname,
    search: incoming.search,
  });
  if (!target) {
    return json({ error: "Preview path was rejected." }, 400);
  }
  const headers = new Headers();
  for (const name of ["accept", "accept-language", "range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    return json({ error: "Preview redirect was rejected." }, 502);
  }
  const responseHeaders = new Headers({
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["content-type", "content-length", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};

export const runTurn = async (
  host: AppBuildHost,
  turn: TurnRequest,
  turnExecution: TurnExecutionContext,
): Promise<Response> => {
  const commandTimeoutMs = Number(host.env.TURN_TIMEOUT_MS);
  const firstSandboxId = await exactTurnSandboxId("app", turn);
  const first = host.sandbox(firstSandboxId);
  turnExecution.assertActive();
  const claim: AppTurnAdmissionClaim = {
    schemaVersion: 1,
    claimId: crypto.randomUUID(),
    turnId: turn.turnId,
    ownerGeneration: turn.ownerGeneration,
    createdAt: Date.now(),
  };
  const staged = await host.ctx.storage.transaction(async (txn) => {
    const [currentTurn, terminal] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get<boolean>("terminal"),
    ]);
    if (
      (currentTurn && !exactTurnIdentityMatches(currentTurn, turn)) ||
      (currentTurn && terminal)
    ) {
      return false;
    }
    await txn.put({
      [APP_TURN_ADMISSION_CLAIM_KEY]: claim,
      turn,
      turnId: turn.turnId,
      terminal: false,
    });
    return true;
  });
  if (!staged) {
    throw new AppTurnAuthorityLostError();
  }

  // Cross-DO and Convex I/O deliberately run outside any concurrency gate.
  // Stop or a successor may land while either is in flight; the exact claim
  // below is the only thing that can authorize the container side effect.
  let committed = false;
  try {
    await host.assertTurnWritable(turn);
    host.assertAppTurnIdentity(turn);
    turnExecution.assertActive();
    committed = await host.ctx.storage.transaction(async (txn) => {
      const [currentTurn, currentClaim, terminal] = await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<AppTurnAdmissionClaim>(APP_TURN_ADMISSION_CLAIM_KEY),
        txn.get<boolean>("terminal"),
      ]);
      if (
        terminal ||
        !exactTurnIdentityMatches(currentTurn, turn) ||
        currentClaim?.schemaVersion !== 1 ||
        currentClaim.claimId !== claim.claimId ||
        currentClaim.turnId !== turn.turnId ||
        currentClaim.ownerGeneration !== turn.ownerGeneration
      ) {
        return false;
      }
      await txn.put("sandboxId", firstSandboxId);
      await txn.delete(APP_TURN_ADMISSION_CLAIM_KEY);
      await txn.setAlarm(
        Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
      );
      return true;
    });
  } finally {
    if (!committed) {
      await host.ctx.storage.transaction(async (txn) => {
        const [currentTurn, currentClaim, terminal] = await Promise.all([
          txn.get<TurnRequest>("turn"),
          txn.get<AppTurnAdmissionClaim>(APP_TURN_ADMISSION_CLAIM_KEY),
          txn.get<boolean>("terminal"),
        ]);
        if (currentClaim?.claimId !== claim.claimId) return;
        await txn.delete(APP_TURN_ADMISSION_CLAIM_KEY);
        // A failed remote validation should restore pre-admission emptiness.
        // A Stop has already made the staged turn durable and keeps it so
        // cancellation acknowledgement/recovery can finish exactly once.
        if (exactTurnIdentityMatches(currentTurn, turn) && !terminal) {
          await txn.delete(["turn", "turnId", "terminal"]);
        }
      });
    }
  }
  if (!committed) throw new AppTurnAuthorityLostError();
  turnExecution.assertActive();
  let seq = 0;
  const requestStarted = performance.now();
  log("info", "turn_started", {
    turnId: turn.turnId,
    appId: turn.appId,
    sessionId: host.ctx.id.toString(),
  });
  try {
    await host.assertAppExecutionActive(turn, turnExecution);
    await host.event(
      turn,
      seq++,
      "started",
      { appId: turn.appId },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();
    if (turn.preflightDelayMs) {
      await scheduler.wait(turn.preflightDelayMs);
      turnExecution.assertActive();
    }
    if (await host.ctx.storage.get<boolean>("terminal")) {
      throw new Error("Turn was canceled or timed out before execution.");
    }
    const coldStarted = performance.now();
    turnExecution.assertActive();
    const session = await first.createSession({
      id: sessionName(`build-${turn.turnId}`),
      cwd: "/opt/stella",
      commandTimeoutMs,
      env: { ...APP_BUILD_SESSION_ENV },
    });
    turnExecution.assertActive();
    await normalizeToolWorkspaceRoot(session, "/workspace/app");
    turnExecution.assertActive();
    const coldContainerStartMs = Math.round(performance.now() - coldStarted);
    await host.event(
      turn,
      seq++,
      "sandbox_ready",
      { coldContainerStartMs },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();

    const modelStarted = performance.now();
    const modelResponse = await host.convexCall(
      turn,
      "/api/cloud/model",
      {
        prompt: turn.prompt,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        requestId: await cloudModelRequestId(turn.turnId),
      },
      { signal: turnExecution.signal },
    );
    turnExecution.assertActive();
    const modelPayload = (await modelResponse.json()) as {
      spec?: unknown;
      usage?: Record<string, unknown>;
      error?: string;
    };
    turnExecution.assertActive();
    if (!modelResponse.ok || !modelPayload.spec) {
      throw new Error(
        modelPayload.error ?? `Model relay failed (${modelResponse.status}).`,
      );
    }
    const appTitle =
      typeof (modelPayload.spec as { title?: unknown })?.title === "string"
        ? (modelPayload.spec as { title: string }).title.trim().slice(0, 32) ||
          undefined
        : undefined;
    await host.event(
      turn,
      seq++,
      "model_completed",
      {
        ...modelPayload.usage,
        roundTripMs: Math.round(performance.now() - modelStarted),
      },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();
    await session.writeFile(
      "/workspace/turn-input.json",
      JSON.stringify({ prompt: turn.prompt, spec: modelPayload.spec }),
    );
    turnExecution.assertActive();
    const execution = (await strictSessionExec(
      session,
      ["bun", "packages/executor-cloud/src/cli.ts", "--app-turn"],
      { timeout: commandTimeoutMs },
    )) as Execution;
    turnExecution.assertActive();
    if (!execution.success) {
      log("error", "executor_failed", {
        turnId: turn.turnId,
        appId: turn.appId,
        ...executionFailureFields(execution.stderr),
      });
      throw new Error("Stella hit a problem while building. Try again.");
    }
    const executor = JSON.parse(
      execution.stdout.trim().split("\n").at(-1) ?? "{}",
    ) as ExecutorResult;
    await host.event(
      turn,
      seq++,
      "app_built",
      {
        runtimeTools: executor.runtimeTools,
        ...executor.metrics,
      },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();

    const viteStarted = performance.now();
    const vite = await startStrictSessionProcess(
      session,
      ["/usr/local/bin/vite", "--host", "0.0.0.0", "--port", "5173"],
      { cwd: "/workspace/app" },
    );
    turnExecution.assertActive();
    await vite.waitForPort(5173, {
      path: "/",
      status: 200,
      timeout: 120_000,
    });
    turnExecution.assertActive();
    const tunnel = await first.tunnels.get(5173);
    turnExecution.assertActive();
    const firstPreviewMs = Math.round(performance.now() - viteStarted);
    if (!turn.previewRoute) {
      throw new Error("Trusted preview route is unavailable.");
    }
    const previewAccess = await issuePreviewAccessCapability({
      identity: {
        buildSessionName: turn.previewRoute.buildSessionName,
        turnId: turn.turnId,
        sandboxId: firstSandboxId,
      },
      tunnelUrl: tunnel.url,
      secret: host.env.BUILDER_SERVICE_SECRET,
      now: Date.now(),
      ttlMs: Math.min(
        PREVIEW_ACCESS_MAX_TTL_MS,
        Math.max(1_000, turn.watchdogMs ?? 15 * 60_000),
      ),
    });
    await host.ctx.storage.put(
      PREVIEW_ACCESS_STORAGE_KEY,
      previewAccess.activeRecord,
    );
    turnExecution.assertActive();
    // Exercise the exact signed route the agent would use. The tunnel URL
    // remains only in the active DO record and is never emitted to the UI.
    const signedPreviewUrl = `${turn.previewRoute.baseUrl}${previewAccess.capability}/`;
    const previewVerification = await proxyVitePreview(
      host,
      new Request(signedPreviewUrl, {
        headers: {
          [HEADER_PREVIEW_CAPABILITY]: previewAccess.capability,
        },
      }),
    );
    await previewVerification.body?.cancel().catch(() => undefined);
    if (!previewVerification.ok) {
      await host.ctx.storage.delete(PREVIEW_ACCESS_STORAGE_KEY);
      throw new Error("The signed agent preview did not become ready.");
    }
    await host.event(
      turn,
      seq++,
      "live_preview",
      {
        access: "agent_only",
        firstPreviewMs,
      },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();

    await host.assertAppExecutionActive(turn, turnExecution);
    // The build is already in the publishing sandbox. Stop and join the
    // entire model-controlled session before a fresh trusted session reads
    // dist; the old cross-sandbox SDK backup added no durability, but could
    // orphan opaque random-address R2 bytes before returning its UUID.
    await first.killAllProcesses(session.id);
    await first.deleteSession(session.id).catch(() => undefined);
    turnExecution.assertActive();
    const publishSession = await first.createSession({
      id: sessionName(`publish-${turn.turnId}`),
      cwd: "/workspace/app",
      commandTimeoutMs,
    });
    turnExecution.assertActive();
    await normalizeToolWorkspaceRoot(publishSession, "/workspace/app");
    turnExecution.assertActive();
    const verify = await strictSessionExec(publishSession, [
      "/bin/sh",
      "-lc",
      "test -f dist/index.html && test -d dist/assets",
    ]);
    turnExecution.assertActive();
    if (!verify.success)
      throw new Error("Built workspace did not contain the production build.");
    await host.event(
      turn,
      seq++,
      "workspace_verified",
      { writersQuiesced: true },
      false,
      turnExecution.signal,
    );
    turnExecution.assertActive();

    const files = await publishSession.listFiles("/workspace/app/dist", {
      recursive: true,
    });
    turnExecution.assertActive();
    const buildId = crypto.randomUUID();
    const ownerHash = await sha256Hex(turn.ownerId);
    turnExecution.assertActive();
    const artifactPrefix = ownerAppBuildPrefix(ownerHash, buildId);
    await host.ctx.storage.put(`transientBuild:${turn.turnId}`, artifactPrefix);
    turnExecution.assertActive();
    const slug = `orbit-${turn.appId.slice(-8)}`;
    let uploadedBytes = 0;
    for (const file of files.files.filter((entry) => entry.type === "file")) {
      const relative = file.absolutePath
        .replace(/^\/workspace\/app\/dist\/?/, "")
        .replace(/^dist\/?/, "");
      const read = await publishSession.readFile(file.absolutePath, {
        encoding: "base64",
      });
      const bytes = Uint8Array.from(atob(read.content), (char) =>
        char.charCodeAt(0),
      );
      uploadedBytes += bytes.byteLength;
      await host.assertAppExecutionActive(turn, turnExecution);
      const objectKey = `${artifactPrefix}/${relative}`;
      await host.env.APP_BUILDS.put(objectKey, bytes, {
        httpMetadata: { contentType: contentType(relative) },
        customMetadata: { buildId, appId: turn.appId, ownerHash },
      });
      try {
        await host.assertAppExecutionActive(turn, turnExecution);
      } catch (error) {
        await host.env.APP_BUILDS.delete(objectKey).catch(() => undefined);
        throw error;
      }
    }
    const contextSource = `window.__STELLA_APP_CONTEXT__={...${JSON.stringify({
      appId: turn.appId,
      convexSiteUrl: host.env.STELLA_CONVEX_SITE_URL,
    })},bridge:window.parent!==window};\n`;
    uploadedBytes += new TextEncoder().encode(contextSource).byteLength;
    await host.assertAppExecutionActive(turn, turnExecution);
    const contextObjectKey = `${artifactPrefix}/stella-context.js`;
    await host.env.APP_BUILDS.put(contextObjectKey, contextSource, {
      httpMetadata: { contentType: "text/javascript; charset=utf-8" },
      customMetadata: { buildId, appId: turn.appId, ownerHash },
    });
    try {
      await host.assertAppExecutionActive(turn, turnExecution);
    } catch (error) {
      await host.env.APP_BUILDS.delete(contextObjectKey).catch(() => undefined);
      throw error;
    }
    const previewUrl = `${host.env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/apps/${slug}/`;
    const metrics = {
      coldContainerStartMs,
      backupRestoreMs: 0,
      firstPreviewMs,
      checkpointMs: 0,
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
    const callbackBody = {
      buildId,
      appId: turn.appId,
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      artifactPrefix,
      previewUrl,
      metrics,
      slug,
      title: appTitle,
    };
    const result = {
      turnId: turn.turnId,
      appId: turn.appId,
      buildId,
      previewUrl,
      metrics,
    };
    const pendingPublication: PendingAppBuildPublication = {
      turnId: turn.turnId,
      phase: "callback",
      artifactPrefix,
      buildId,
      callbackBody,
      completionSeq: seq++,
      completionResult: result,
    };
    // Persist before the first callback byte leaves this isolate. A lost
    // response replays the same buildId/body instead of leaking or deleting
    // a build Convex may already reference.
    await host.assertAppExecutionActive(turn, turnExecution);
    await host.ctx.storage.put(
      pendingAppBuildPublicationKey(turn.turnId),
      pendingPublication,
    );
    turnExecution.assertActive();
    const publication = await advanceAppBuildPublication(
      host,
      turn,
      pendingPublication,
    );
    await host.destroySandboxDurably(
      {
        sandboxId: firstSandboxId,
        size: "large",
        workload: "app-build",
      },
      "app_build_terminal",
    );
    if (publication === "retrying") {
      return json(
        { ok: true, accepted: true, publicationPending: true, ...result },
        202,
      );
    }
    await host.retireTerminalAppTurnStorage(turn);
    if (publication === "failed") {
      return json({ error: "Cloud app publication failed.", buildId }, 502);
    }
    log("info", "turn_completed", {
      turnId: turn.turnId,
      appId: turn.appId,
      buildId,
      wallClockMs: metrics.wallClockMs,
      activeCpuSeconds: metrics.activeCpuSeconds,
      uploadedBytes,
    });
    emitCloudTurnTelemetry(host.ctx, host.env, {
      type: "cloud.turn",
      workload: "app-build",
      phase: "completed",
      wallClockMs: metrics.wallClockMs,
      coldContainerStartMs: metrics.coldContainerStartMs,
      uploadedBytes,
      activeCpuMs: Math.max(
        0,
        Math.round((metrics.activeCpuSeconds ?? 0) * 1_000),
      ),
      ...(typeof modelPayload.usage?.inputTokens === "number"
        ? { inputTokens: modelPayload.usage.inputTokens }
        : {}),
      ...(typeof modelPayload.usage?.outputTokens === "number"
        ? { outputTokens: modelPayload.usage.outputTokens }
        : {}),
      ...(typeof modelPayload.usage?.llmCalls === "number"
        ? { llmCalls: modelPayload.usage.llmCalls }
        : {}),
      instanceType: metrics.capacity.instanceType,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const failureCode =
      error instanceof OwnerPurgeFenceError
        ? "OWNER_PURGE_FENCE"
        : error instanceof AppTurnAuthorityLostError
          ? "APP_TURN_AUTHORITY_LOST"
          : "APP_BUILD_FAILED";
    const failureMessage = "Stella hit a problem while building. Try again.";
    const transientBuild = await host.ctx.storage.get<string>(
      `transientBuild:${turn.turnId}`,
    );
    if (transientBuild) {
      const existing = await host.ctx.storage.get<PendingAppBuildPublication>(
        pendingAppBuildPublicationKey(turn.turnId),
      );
      const cleanupPending: PendingAppBuildPublication = existing ?? {
        turnId: turn.turnId,
        phase: "cleanup",
        artifactPrefix: transientBuild,
        callbackBody: {},
        completionSeq: seq++,
        completionResult: {},
        failureMessage,
      };
      await host.ctx.storage.put(
        pendingAppBuildPublicationKey(turn.turnId),
        cleanupPending,
      );
      const cleanup = await advanceAppBuildPublication(
        host,
        turn,
        cleanupPending,
      );
      await host
        .destroySandboxDurably(
          {
            sandboxId: firstSandboxId,
            size: "large",
            workload: "app-build",
          },
          "app_build_cleanup",
        )
        .catch(() => undefined);
      if (cleanup === "retrying") {
        return json(
          {
            ok: true,
            accepted: true,
            cleanupPending: true,
          },
          202,
        );
      }
      await host.retireTerminalAppTurnStorage(turn);
      return json({ error: "Cloud app turn failed.", code: failureCode }, 502);
    }
    if (
      !(error instanceof OwnerPurgeFenceError) &&
      !(await host.ctx.storage.get<boolean>("terminal"))
    ) {
      await host.ctx.storage.put("terminal", true);
      await host
        .event(turn, seq++, "failed", { message: failureMessage }, true)
        .catch(() => undefined);
    }
    await host
      .destroySandboxDurably(
        {
          sandboxId: firstSandboxId,
          size: "large",
          workload: "app-build",
        },
        "app_build_failed",
      )
      .catch(() => undefined);
    await host.retireTerminalAppTurnStorage(turn);
    log("error", "turn_failed", {
      turnId: turn.turnId,
      appId: turn.appId,
      errorCode: failureCode,
    });
    return json({ error: "Cloud app turn failed.", code: failureCode }, 502);
  } finally {
    await host.unregisterTurn(turn);
  }
};
