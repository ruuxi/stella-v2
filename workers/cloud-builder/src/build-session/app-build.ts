/**
 * The app-build lane: the whole turn body for an app-build turn, the
 * durable publication debt that replays the Convex callback after response
 * loss, the agent-only Vite preview proxy, and the container echo probe.
 *
 * Extracted verbatim from `src/index.ts`; every cross-cluster call goes back
 * through `host` so this module imports no other build-session module.
 */
import type { BuildSessionInternals } from "./host.js";
import { emitCloudTurnTelemetry } from "../telemetry.js";
import { sha256Hex } from "../hash.js";
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
import type { TurnExecutionContext } from "../turn-cancellation.js";
import type { BuildRecordedEvent } from "@stella/contracts/turn-plane/outbox";
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
  PendingAppBuildPublication,
  TurnRequest,
} from "./shared/types.js";

export type AppBuildHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
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
  | "retireTerminalAppTurnStorage"
  | "sandbox"
  | "unregisterTurn"
>;

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
