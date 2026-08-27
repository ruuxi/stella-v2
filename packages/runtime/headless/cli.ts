import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type CliMode = "chat" | "completion" | "list-models";

type CliOptions = {
  mode: CliMode;
  prompt: string;
  model: string | null;
  agentType: string | null;
  conversationId: string | null;
  stellaAppDir: string | null;
  stellaDataDirPath: string | null;
  workerEntryPath: string | null;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  timeoutMs: number;
  help: boolean;
};

const USAGE = `Usage: bun packages/runtime/headless/cli.ts [options]

Runs the Stella runtime kernel headlessly (no Electron, no desktop shell).

Options:
  -p, --prompt <text>       User prompt for the turn.
  --mode <mode>             chat (default) | completion | list-models
  --model <id>              Explicit model id, e.g. stella/light or
                            anthropic/claude-haiku-4-5. In completion mode
                            it pins the one-shot; in chat mode the turn runs
                            through the automation path with this model
                            override. Without it, chat routes via the user's
                            preferences exactly like a composer send.
  --agent <agentType>       Agent type (chat: orchestrator by default;
                            completion default: general).
  --conversation <id>       Conversation id (default: fresh headless-<ts>).
  --app-dir <path>          Stella app root (default: this repo checkout).
  --data-dir <path>         Stella data dir (default: ~/.stella).
  --worker-entry <path>     Worker entry (default: the source tree's
                            packages/runtime/worker/entry.ts).
  --auth-token <token>      Stella auth token (or env STELLA_AUTH_TOKEN).
  --convex-url <url>        Convex deployment URL (default: desktop-ui .env).
  --convex-site-url <url>   Convex site URL (default: desktop-ui .env).
  --timeout <seconds>       Max wall time for the turn (default: 600).
  -h, --help                Show this help.

Output: JSONL on stdout — { kind: "cli.start" | "run.event" |
"completion.result" | "models" | "cli.result", ... }.`;

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    mode: "chat",
    prompt: "",
    model: null,
    agentType: null,
    conversationId: null,
    stellaAppDir: null,
    stellaDataDirPath: null,
    workerEntryPath: null,
    authToken: null,
    convexUrl: null,
    convexSiteUrl: null,
    timeoutMs: 600_000,
    help: false,
  };
  const next = (i: number): string => {
    const value = argv[i];
    if (value == null) throw new Error(`Missing value for ${argv[i - 1]}.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-p":
      case "--prompt":
        options.prompt = next(++i);
        break;
      case "--mode": {
        const mode = next(++i);
        if (mode !== "chat" && mode !== "completion" && mode !== "list-models") {
          throw new Error(`Unknown --mode: ${mode}`);
        }
        options.mode = mode;
        break;
      }
      case "--list-models":
        options.mode = "list-models";
        break;
      case "--model":
        options.model = next(++i);
        break;
      case "--agent":
        options.agentType = next(++i);
        break;
      case "--conversation":
        options.conversationId = next(++i);
        break;
      case "--app-dir":
        options.stellaAppDir = path.resolve(next(++i));
        break;
      case "--data-dir":
        options.stellaDataDirPath = path.resolve(next(++i));
        break;
      case "--worker-entry":
        options.workerEntryPath = path.resolve(next(++i));
        break;
      case "--auth-token":
        options.authToken = next(++i);
        break;
      case "--convex-url":
        options.convexUrl = next(++i);
        break;
      case "--convex-site-url":
        options.convexSiteUrl = next(++i);
        break;
      case "--timeout": {
        const seconds = Number.parseFloat(next(++i));
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(`Invalid --timeout: ${argv[i]}`);
        }
        options.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:

        if (arg && !arg.startsWith("-") && !options.prompt) {
          options.prompt = arg;
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const emit = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const log = (message: string): void => {
  process.stderr.write(`[headless] ${message}\n`);
};

const readDesktopUiEnvDefaults = (
  stellaAppDir: string,
): { convexUrl: string | null; convexSiteUrl: string | null } => {
  const envPath = path.join(stellaAppDir, "packages", "desktop-ui", ".env");
  const result: { convexUrl: string | null; convexSiteUrl: string | null } = {
    convexUrl: null,
    convexSiteUrl: null,
  };
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^\s*(VITE_CONVEX_URL|VITE_CONVEX_SITE_URL)\s*=\s*(\S+)\s*$/);
      if (!match) continue;
      if (match[1] === "VITE_CONVEX_URL") result.convexUrl = match[2] ?? null;
      else result.convexSiteUrl = match[2] ?? null;
    }
  } catch {

  }
  return result;
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }

  const moduleDir = import.meta.dirname;
  const defaultAppDir = path.resolve(moduleDir, "..", "..", "..");
  const stellaAppDir = options.stellaAppDir ?? defaultAppDir;
  process.env.STELLA_APP_DIR = stellaAppDir;
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  if (resourcesPath && !resourcesPath.startsWith(stellaAppDir)) {

    delete process.env.STELLA_APP_RESOURCES_PATH;
  }

  const { resolveHeadlessHostPaths, createHeadlessHostHandlers } = await import(
    "./host.js"
  );
  const { StellaRuntimeHost } = await import("../host/index.js");
  const { AGENT_STREAM_EVENT_TYPES, AGENT_RUN_FINISH_OUTCOMES } = await import(
    "@stella/contracts/agent-runtime"
  );

  const paths = resolveHeadlessHostPaths({
    stellaAppDir,
    ...(options.stellaDataDirPath
      ? { stellaDataDirPath: options.stellaDataDirPath }
      : {}),
  });
  process.env.STELLA_DATA_DIR = paths.stellaDataDirPath;

  const sourceWorkerEntry = path.join(
    paths.stellaAppDir,
    "packages",
    "runtime",
    "worker",
    "entry.ts",
  );
  const workerEntryPath =
    options.workerEntryPath ??
    (existsSync(sourceWorkerEntry) ? sourceWorkerEntry : null);

  const authToken =
    options.authToken?.trim() || process.env.STELLA_AUTH_TOKEN?.trim() || null;
  const envDefaults = readDesktopUiEnvDefaults(paths.stellaAppDir);
  const convexUrl = options.convexUrl ?? envDefaults.convexUrl;
  const convexSiteUrl = options.convexSiteUrl ?? envDefaults.convexSiteUrl;

  if (options.mode !== "list-models" && !options.prompt.trim()) {
    throw new Error("A prompt is required (use --prompt or --help).");
  }

  const host = new StellaRuntimeHost({
    initializeParams: {
      clientName: "stella-headless-cli",
      clientVersion: "dev",
      isDev: false,
      platform: process.platform,
      stellaAppDir: paths.stellaAppDir,
      stellaDataDirPath: paths.stellaDataDirPath,
      stellaWorkspacePath: paths.stellaWorkspacePath,
    },
    hostHandlers: createHeadlessHostHandlers(paths, { authToken }),
    workerMode: "child",
    disableLocalScheduler: true,
    ...(workerEntryPath ? { workerEntryPath } : {}),
  });

  let exitCode = 0;
  let stopping = false;
  const shutdown = async (code: number): Promise<never> => {
    stopping = true;
    exitCode = code;
    try {
      await host.stop();
    } catch {

    }
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));

  log(`app dir:    ${paths.stellaAppDir}`);
  log(`data dir:   ${paths.stellaDataDirPath}`);
  log(`worker:     ${workerEntryPath ?? "(bundled default)"}`);
  log(`auth token: ${authToken ? "provided" : "none"}`);

  emit({
    kind: "cli.start",
    mode: options.mode,
    stellaAppDir: paths.stellaAppDir,
    stellaDataDirPath: paths.stellaDataDirPath,
    workerEntryPath,
    hasAuthToken: Boolean(authToken),
  });

  const timeout = setTimeout(() => {
    emit({ kind: "cli.result", ok: false, error: "timeout" });
    void shutdown(2);
  }, options.timeoutMs);
  timeout.unref?.();

  await host.configure({
    convexUrl,
    convexSiteUrl,
    authToken,
    hasConnectedAccount: false,
    cloudSyncEnabled: false,
  });
  await host.start();
  await host.ensureWorkerStarted();
  const health = await host.health();
  log(`worker ready (pid=${health.workerPid})`);

  if (options.mode === "list-models") {
    const snapshot = await host.listModels({});
    emit({ kind: "models", snapshot });
    emit({ kind: "cli.result", ok: true });
    clearTimeout(timeout);
    await shutdown(0);
  }

  if (options.mode === "completion") {
    const result = await host.runOneShotCompletion({
      agentType: options.agentType ?? "general",
      userText: options.prompt,
      ...(options.model ? { model: options.model } : {}),
    });
    emit({ kind: "completion.result", text: result.text });
    emit({ kind: "cli.result", ok: true });
    clearTimeout(timeout);
    await shutdown(0);
  }

  const conversationId =
    options.conversationId ?? `headless-${Date.now().toString(36)}`;
  let rootRunId: string | null = null;
  let finished = false;
  let finishOutcome: string | null = null;
  let finishError: string | null = null;
  const finishWaiter = new Promise<void>((resolve) => {
    host.on("run-event", (event: Record<string, unknown> & { type?: string }) => {
      if (stopping) return;
      emit({ kind: "run.event", event });
      if (
        event.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED &&
        (rootRunId == null || event.runId === rootRunId)
      ) {
        finished = true;
        finishOutcome = typeof event.outcome === "string" ? event.outcome : null;
        finishError = typeof event.error === "string" ? event.error : null;
        resolve();
      }
    });
  });

  if (options.model) {
    const resultPromise = host.runAutomationTurn({
      conversationId,
      userPrompt: options.prompt,
      modelOverride: options.model,
      ...(options.agentType ? { agentType: options.agentType } : {}),
    }) as Promise<{ status: string; finalText: string; error?: string }>;
    log(`automation turn started (conversation=${conversationId} model=${options.model})`);
    const result = await resultPromise;
    clearTimeout(timeout);
    const ok = result.status === "ok";
    emit({
      kind: "cli.result",
      ok,
      conversationId,
      status: result.status,
      finalText: result.finalText,
      ...(result.error ? { error: result.error } : {}),
    });
    await shutdown(ok ? 0 : 1);
  }

  const startResult = (await host.startChat({
    conversationId,
    userPrompt: options.prompt,
    requestId: `headless-${Date.now().toString(36)}`,
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    storageMode: "local",
    ...(options.agentType ? { agentType: options.agentType } : {}),
  })) as { runId?: string };
  rootRunId = startResult.runId ?? null;
  log(`turn started (conversation=${conversationId} run=${rootRunId})`);

  await finishWaiter;
  clearTimeout(timeout);
  const ok = finished && finishOutcome === AGENT_RUN_FINISH_OUTCOMES.COMPLETED;
  emit({
    kind: "cli.result",
    ok,
    conversationId,
    runId: rootRunId,
    outcome: finishOutcome,
    ...(finishError ? { error: finishError } : {}),
  });
  await shutdown(ok ? 0 : 1);
};

void main().catch((error) => {
  emit({
    kind: "cli.result",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  console.error("[headless] fatal:", error);
  process.exit(1);
});
