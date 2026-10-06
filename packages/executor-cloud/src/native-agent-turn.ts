import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  CLOUD_CLAUDE_ACCOUNTS_ROOT,
  cloudNativeStateRoot,
  isCloudClaudeAccountKey,
} from "@stella/contracts/cloud-native-state";
import type { CloudCliTurnRole } from "@stella/contracts/cloud-orchestrator-cli";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import {
  ClaudeCodeCompactionLoopError,
  claudeCodeSubscriptionLimitOf,
  getClaudeCodeStatusChangeFromStreamEvent,
  MAX_COMPACTIONS_PER_TURN,
} from "@stella/runtime/kernel/integrations/claude-code-session-runtime.js";
import { CLOUD_HOST_STATE } from "./cloud-process-isolation.js";
import { WORLD_ROOT } from "./workspace-paths.js";
import {
  parseAuthoritativeAgentHistory,
  type AgentHistoryRow,
} from "./agent-history.js";
import { pruneAgentHistory } from "./prune-history.js";
import {
  assertFreshNativeState,
  assertNativeState,
  sealNativeState,
  type NativeStateAttestation,
} from "./native-state-integrity.js";
import {
  createNativeTurnCancellation,
  type NativeTurnCancellation,
} from "./turn-cancellation.js";

export type NativeAgentTurnResult = {
  finalText: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  messages: AgentMessage[];
  /** Builder checkpoint input for Claude's durable native state. */
  nativeStateCheckpoint?: Pick<
    NativeStateAttestation,
    "engine" | "sessionId" | "cursor" | "tree" | "mac"
  >;
};

type NativeCliTurnResult = Omit<
  NativeAgentTurnResult,
  "messages" | "nativeStateCheckpoint"
> & { sessionId: string };

type NativeEvent = (kind: string, payload: unknown) => void;

/** The MCP server name; Claude exposes its tools as `mcp__stella__<name>`. */
export const CLOUD_CLAUDE_MCP_SERVER_NAME = "stella";

export type CloudClaudeMcpServerConfig = {
  type: "http";
  url: string;
  headers: { Authorization: string };
};

export const createCloudClaudeMcpConfig = async (
  serverConfig: CloudClaudeMcpServerConfig,
): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-cloud-claude-mcp-"),
  );
  try {
    await chmod(directory, 0o700);
    const configPath = path.join(directory, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { [CLOUD_CLAUDE_MCP_SERVER_NAME]: serverConfig },
      }),
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    return {
      path: configPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

/** This thread's own native state root; threads share the container, not state. */
export const cloudNativeStateRootForThread = (threadId: string): string =>
  cloudNativeStateRoot(createHash("sha256").update(threadId).digest("hex"));
const EMPTY_NATIVE_HISTORY_CURSOR = "v1:empty";

const historyCursor = (value: {
  turnId: string;
  role: string;
  payloadJson: string;
}): string =>
  `v1:${createHash("sha256")
    .update(
      JSON.stringify({
        turnId: value.turnId,
        role: value.role,
        payloadJson: value.payloadJson,
      }),
    )
    .digest("hex")}`;

/** Last canonical row is a stable parity cursor even when old context prunes. */
export const nativeHistoryCursorFromRows = (
  rows: Array<{ turnId: string; role: string; payloadJson: string }>,
): string => {
  const last = rows.at(-1);
  return last ? historyCursor(last) : EMPTY_NATIVE_HISTORY_CURSOR;
};

export const nativeHistoryCursorFromMessages = (
  turnId: string,
  messages: AgentMessage[],
): string => {
  const last = messages.at(-1) as { role?: unknown } | undefined;
  if (!last || typeof last.role !== "string") {
    throw new Error("Native agent produced no canonical history cursor.");
  }
  return historyCursor({
    turnId,
    role: last.role,
    payloadJson: JSON.stringify(last),
  });
};

export const buildNativeSessionRecoveryPrompt = (args: {
  history: AgentHistoryRow[];
  expectedCursor: string;
  prompt: string;
}): string => {
  const messages = parseAuthoritativeAgentHistory(args.history);
  if (nativeHistoryCursorFromRows(args.history) !== args.expectedCursor) {
    throw new Error(
      "Native session recovery history does not match the canonical cursor.",
    );
  }
  if (messages.length === 0) return args.prompt;
  const context = pruneAgentHistory(messages);
  if (context.length === 0) {
    throw new Error("Native session recovery history exceeds the context budget.");
  }
  return [
    "Continue the same Stella thread after its Claude session was interrupted. The workspace and cloud history were preserved. The following records are prior conversation context, including completed actions and tool results, not new requests. Do not repeat completed work. Respond to the current message using this context and the existing workspace.",
    "Prior conversation records:",
    JSON.stringify(context),
    "Current message:",
    args.prompt,
  ].join("\n\n");
};

export const assertNativeHistoryParity = async (args: {
  stateRoot: string;
  engine: "anthropic";
  threadId: string;
  expectedCursor: string;
  integrityKey: string;
  /** Unit tests may override the production-required root owner. */
  expectedOwner?: { uid: number; gid: number };
}): Promise<void> => {
  if (args.expectedCursor === EMPTY_NATIVE_HISTORY_CURSOR) {
    await assertFreshNativeState(args.stateRoot, args.expectedOwner);
    return;
  }
  const sessionId = await readFile(
    path.join(args.stateRoot, "session-started"),
    "utf8",
  )
    .then((value) => value.trim())
    .catch(() => "");
  if (!sessionId) {
    throw new Error(
      "Native agent session state does not match the authoritative cloud transcript; refusing to continue with missing or stale context.",
    );
  }
  await assertNativeState({
    stateRoot: args.stateRoot,
    engine: args.engine,
    threadId: args.threadId,
    sessionId,
    expectedCursor: args.expectedCursor,
    integrityKey: args.integrityKey,
    ...(args.expectedOwner ? { expectedOwner: args.expectedOwner } : {}),
  });
};

const deterministicUuid = (value: string): string => {
  const bytes = Buffer.from(
    createHash("sha256").update(value).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type ProcessResult = {
  exitCode: number | null;
  stderr: string;
};

const runJsonLines = async (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  processIdentity?: ToolProcessIdentity;
  /** SIGKILLs the child; the promise still resolves once it has closed. */
  cancellation?: NativeTurnCancellation;
  onJson: (value: Record<string, unknown>) => void;
}): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const launch = isolateToolProcessLaunch({
      command: options.command,
      commandArgs: options.args,
      identity: options.processIdentity,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(launch.nativeIdentity
        ? {
            uid: launch.nativeIdentity.uid,
            gid: launch.nativeIdentity.gid,
          }
        : {}),
    });
    let pending = "";
    let stderr = "";
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const value = JSON.parse(trimmed) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          options.onJson(value as Record<string, unknown>);
        }
      } catch {
        // Native CLIs occasionally write a startup notice to stdout. It is not
        // part of their JSON event protocol and must not poison the turn.
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_000);
    });
    const sigkill = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    // The latch is awaited on its own fiber rather than polled; an already
    // settled latch kills the child on the next tick.
    const killOnCancel = options.cancellation
      ? Effect.runFork(
          options.cancellation.awaitAborted.pipe(
            Effect.catch(() => Effect.sync(sigkill)),
          ),
        )
      : undefined;
    child.on("error", (error) => {
      killOnCancel?.interruptUnsafe();
      reject(error);
    });
    child.on("close", (exitCode) => {
      killOnCancel?.interruptUnsafe();
      consume(pending);
      resolve({ exitCode, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });

const textBlocks = (content: unknown): string[] =>
  Array.isArray(content)
    ? content
        .filter((block): block is { type: "text"; text: string } =>
          Boolean(
            block &&
              typeof block === "object" &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          ),
        )
        .map((block) => block.text.trim())
        .filter(Boolean)
    : [];

const numberAt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const resolveClaudeReasoningArgs = (
  effort: AgentModelReasoningEffort,
): string[] => {
  switch (effort) {
    case "none":
      return ["--thinking", "disabled"];
    case "default":
      return [];
    case "minimal":
    case "low":
      return ["--effort", "low", "--thinking", "enabled"];
    case "xhigh":
      return ["--effort", "max", "--thinking", "enabled"];
    case "high":
      return ["--effort", "high", "--thinking", "enabled"];
    case "medium":
      return ["--effort", "medium", "--thinking", "enabled"];
  }
};

export const resolveClaudeModelArgs = (model: string): string[] =>
  model === "default" ? [] : ["--model", model];

/**
 * What differs between the two cloud CLI roles. Everything else (flags,
 * gateway wiring, native state, compaction guard) is one shared runner.
 */
export type CloudClaudeRoleProfile = {
  role: CloudCliTurnRole;
  /** Seed of the deterministic Claude session id (`--session-id`/`--resume`). */
  sessionKey: string;
  /** Gateway agent type; the turn capability's `agentTypes` must allow it. */
  agentType: "general" | "orchestrator";
  /**
   * Claude keys its on-disk sessions by cwd under CLAUDE_CONFIG_DIR, so the
   * path must be the same in every container for `--resume` to find them.
   */
  cwd: string;
  /** Stream `stream_event` deltas (live text, tool-use correlation). */
  includePartialMessages: boolean;
  /** Hard and idle MCP tool-call bound; unset keeps the CLI defaults. */
  mcpToolTimeoutMs?: number;
};

/**
 * Root-only (inside the 0700 host-state directory) and always empty: an
 * orchestrator turn has no workspace, and no model-authored process can plant
 * a CLAUDE.md or `.claude` directory anywhere on its lookup path.
 */
export const CLOUD_ORCHESTRATOR_CLI_CWD = path.join(
  CLOUD_HOST_STATE,
  "orchestrator-cwd",
);

/**
 * An orchestrator tool call is one held broker request (BuildSession -> DO)
 * that sends no MCP progress while the DO runs the tool, which may wait on a
 * user approval. Claude Code 2.1.220 aborts a silent HTTP MCP call after 5
 * minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` default 300000) and has a
 * ~28 h hard cap (`MCP_TOOL_TIMEOUT` default 1e8). Both are set to 30
 * minutes: the turn's broker capability (TURN_BROKER_MAX_TTL_MS) and gateway
 * capability expire by then anyway, so the CLI never gives up on a tool the
 * DO is still running and journaling, and the turn's own bounds (DO watchdog,
 * BuildSession cancel ladder) stay the ones that end a wedged call.
 */
export const CLOUD_ORCHESTRATOR_MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

export const cloudClaudeRoleProfile = (args: {
  role: CloudCliTurnRole;
  threadId: string;
  conversationId: string;
}): CloudClaudeRoleProfile =>
  args.role === "orchestrator"
    ? {
        role: "orchestrator",
        sessionKey: `stella-cloud:claude:orch:${args.conversationId}`,
        agentType: "orchestrator",
        cwd: CLOUD_ORCHESTRATOR_CLI_CWD,
        includePartialMessages: true,
        mcpToolTimeoutMs: CLOUD_ORCHESTRATOR_MCP_TOOL_TIMEOUT_MS,
      }
    : {
        role: "agent",
        sessionKey: `stella-cloud:claude:${args.threadId}`,
        agentType: "general",
        cwd: WORLD_ROOT,
        includePartialMessages: false,
      };

/**
 * The owner's cloud Claude Code login a turn runs on: which account directory
 * under the root-only accounts root (a key, never a credential).
 */
export type CloudClaudeAccountInput = { key: string; email: string };

export const parseCloudClaudeAccountInput = (
  value: unknown,
): CloudClaudeAccountInput | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return isCloudClaudeAccountKey(row.key) &&
    typeof row.email === "string" &&
    row.email.length > 0 &&
    row.email.length <= 320
    ? { key: row.key, email: row.email }
    : null;
};

export const cloudClaudeAccountDirectory = (account: CloudClaudeAccountInput): string =>
  path.join(CLOUD_CLAUDE_ACCOUNTS_ROOT, account.key);

/**
 * Claude Code talks to Anthropic directly on the login `claude auth login`
 * left in the account's directory: `CLAUDE_SECURESTORAGE_CONFIG_DIR` is where
 * the CLI keeps (and refreshes) that credential, while `CLAUDE_CONFIG_DIR`
 * stays the thread's own native state root for its sessions. No base URL
 * override, no token in the environment: nothing here ever reads, copies or
 * relays the credential.
 */
export const buildClaudeChildEnv = (options: {
  initialEnv: NodeJS.ProcessEnv;
  stateRoot: string;
  accountDirectory: string;
  reasoningEffort: AgentModelReasoningEffort;
  mcpToolTimeoutMs?: number;
}): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    ...options.initialEnv,
    CLAUDE_CONFIG_DIR: options.stateRoot,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: options.accountDirectory,
    // Claude spawns no subprocess here: built-in tools are off (`--tools ""`),
    // Stella's tools arrive over loopback HTTP MCP and run in the ToolHost's
    // own isolation, and settings sources (hooks) are empty. Scrubbing would
    // only demand bubblewrap, which the image cannot run (no user
    // namespaces), and the CLI then exits before it starts.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    // The executor (and so the CLI) runs as root inside the per-owner
    // sandbox container. Claude Code refuses --dangerously-skip-permissions
    // as root unless told it is in a sandbox.
    IS_SANDBOX: "1",
  };
  // Nothing may point the CLI at another endpoint or another credential.
  delete childEnv.ANTHROPIC_BASE_URL;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.ANTHROPIC_CUSTOM_HEADERS;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  // These are forbidden legacy executor credentials, not Claude credentials.
  // Neither name may enter Claude's environment and reach a tool subprocess.
  delete childEnv.STELLA_TURN_TOKEN;
  delete childEnv.STELLA_CODEX_TURN_TOKEN;
  // Never let a host/image override defeat the turn's explicit selection.
  // `unset` is Claude Code's supported "send no output_config.effort" value.
  delete childEnv.CLAUDE_CODE_EFFORT_LEVEL;
  if (options.reasoningEffort === "none") {
    childEnv.CLAUDE_CODE_EFFORT_LEVEL = "unset";
  }
  delete childEnv.MCP_TOOL_TIMEOUT;
  delete childEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
  if (options.mcpToolTimeoutMs !== undefined) {
    childEnv.MCP_TOOL_TIMEOUT = String(options.mcpToolTimeoutMs);
    childEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(
      options.mcpToolTimeoutMs,
    );
  }
  return childEnv;
};

export const buildCloudClaudeTakeoverArgs = (options: {
  model: string;
  reasoningEffort: AgentModelReasoningEffort;
  systemPrompt: string;
  mcpConfigPath: string;
  resume: boolean;
  sessionId: string;
  inputPrompt?: string;
  includePartialMessages?: boolean;
}): string[] => [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  ...(options.includePartialMessages ? ["--include-partial-messages"] : []),
  ...resolveClaudeModelArgs(options.model),
  ...resolveClaudeReasoningArgs(options.reasoningEffort),
  "--dangerously-skip-permissions",
  // Match the desktop's configured Claude engine takeover: Claude owns the
  // native loop, but Stella owns its entire capability and instruction
  // surface. Ambient MCP servers, built-ins, and slash commands stay out.
  "--strict-mcp-config",
  "--mcp-config",
  options.mcpConfigPath,
  "--disable-slash-commands",
  "--tools",
  "",
  // Stella's server is the only tool surface; allow it explicitly too, so a
  // permission mode that overrides the bypass can't deny it.
  "--allowedTools",
  `mcp__${CLOUD_CLAUDE_MCP_SERVER_NAME}`,
  // CLAUDE_CONFIG_DIR persists only conversation state. Never let a prior
  // turn or project file turn that persistence into executable hooks,
  // plugins, permissions, or other settings outside Stella's ToolHost.
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({
    // Match the configured desktop engine: keyword-triggered workflows must
    // not hijack an ordinary Stella task after slash commands are removed.
    workflowKeywordTriggerEnabled: false,
    disableWorkflows: true,
  }),
  "--system-prompt",
  options.systemPrompt,
  ...(options.resume
    ? ["--resume", options.sessionId]
    : ["--session-id", options.sessionId]),
  ...(options.inputPrompt !== undefined ? [options.inputPrompt] : []),
];

const transcript = (args: {
  prompt: string;
  finalText: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  usage: NativeAgentTurnResult["usage"];
  error?: string;
}): AgentMessage[] => {
  const timestamp = Date.now();
  const usage = {
    input: args.usage.inputTokens,
    output: args.usage.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: args.usage.inputTokens + args.usage.outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return [
    {
      role: "user",
      content: [{ type: "text", text: args.prompt }],
      timestamp,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: args.finalText }],
      api: "claude-code",
      provider: args.execution.provider,
      model: args.execution.model,
      usage,
      stopReason: args.error ? "error" : "stop",
      ...(args.error ? { errorMessage: args.error } : {}),
      timestamp,
    },
  ];
};

/** One stream-json event from the CLI, as parsed from its stdout. */
export type ClaudeStreamJsonEvent = Record<string, unknown>;

/**
 * Runs one `claude -p` turn for either role and returns its outcome. Callers
 * observe the raw stream through `onStreamEvent`; this owns the session
 * marker, final text, usage, the compaction-loop breaker, and cancellation.
 */
export const runCloudClaude = async (options: {
  profile: CloudClaudeRoleProfile;
  inputPrompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  claudeAccount: CloudClaudeAccountInput;
  stateRoot: string;
  mcpServerConfig: CloudClaudeMcpServerConfig;
  onStreamEvent?: (event: ClaudeStreamJsonEvent) => void;
  /** Kills the CLI; the turn then fails with the abort reason. */
  cancellation?: NativeTurnCancellation;
}): Promise<NativeCliTurnResult> => {
  const { profile } = options;
  const stateRoot = options.stateRoot;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  if (profile.role === "orchestrator") {
    await mkdir(profile.cwd, { recursive: true, mode: 0o700 });
  }
  const accountDirectory = cloudClaudeAccountDirectory(options.claudeAccount);
  const signedIn = await stat(path.join(accountDirectory, ".credentials.json")).then(
    (details) => details.isFile(),
    () => false,
  );
  if (!signedIn) {
    // Only whether the CLI's credential file exists; its contents are the
    // CLI's alone. A new container image starts without the old login.
    return {
      finalText: "",
      error: `Claude isn't signed in to ${options.claudeAccount.email} in your cloud anymore. Sign in again under Settings > Account > Claude.`,
      usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
      sessionId: "",
    };
  }
  const sessionId = deterministicUuid(profile.sessionKey);
  const markerPath = path.join(stateRoot, "session-started");
  const resume = await stat(markerPath).then(
    () => true,
    () => false,
  );
  const mcpConfig = await createCloudClaudeMcpConfig(options.mcpServerConfig);
  // One latch, two sources: the caller's cancellation and our own
  // compaction-loop verdict both have to reach one child process. A turn
  // without a caller latch still owns one for the verdict.
  const cancellation = options.cancellation ?? createNativeTurnCancellation();
  try {
    const args = buildCloudClaudeTakeoverArgs({
      model: options.execution.model,
      reasoningEffort: options.execution.reasoningEffort,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: mcpConfig.path,
      resume,
      sessionId,
      includePartialMessages: profile.includePartialMessages,
    });
    let finalText = "";
    let error: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let llmCalls = 0;
    let initialized = resume;
    let compacting = false;
    let compactions = 0;
    const childEnv = buildClaudeChildEnv({
      initialEnv: process.env,
      stateRoot,
      accountDirectory,
      reasoningEffort: options.execution.reasoningEffort,
      ...(profile.mcpToolTimeoutMs !== undefined
        ? { mcpToolTimeoutMs: profile.mcpToolTimeoutMs }
        : {}),
    });
    const result = await runJsonLines({
      input: options.inputPrompt,
      command: "claude",
      args,
      cwd: profile.cwd,
      env: childEnv,
      cancellation,
      onJson: (event) => {
        options.onStreamEvent?.(event);
        const type = event.type;
        if (type === "system" && event.subtype === "init") {
          initialized = true;
          void writeFile(markerPath, `${sessionId}\n`, { mode: 0o600 });
          return;
        }
        const status = getClaudeCodeStatusChangeFromStreamEvent(event);
        if (status) {
          // Count discrete compactions, as the desktop runtime does. A turn
          // that keeps re-compacting can no longer fit its context.
          if (status.state === "compacting" && !compacting) {
            compacting = true;
            compactions += 1;
            if (
              compactions > MAX_COMPACTIONS_PER_TURN &&
              !cancellation.aborted
            ) {
              const loop = new ClaudeCodeCompactionLoopError();
              error = loop.message;
              cancellation.abort(loop);
            }
          } else if (status.state === "running") {
            compacting = false;
          }
          return;
        }
        if (type === "assistant") {
          llmCalls += 1;
          const texts = textBlocks(
            (event.message as { content?: unknown } | undefined)?.content,
          );
          for (const text of texts) finalText = text;
          return;
        }
        if (type === "result") {
          const resultText =
            typeof event.result === "string" ? event.result.trim() : "";
          if (resultText) finalText = resultText;
          const usage =
            event.usage && typeof event.usage === "object"
              ? (event.usage as Record<string, unknown>)
              : {};
          inputTokens =
            numberAt(usage.input_tokens) +
            numberAt(usage.cache_creation_input_tokens) +
            numberAt(usage.cache_read_input_tokens);
          outputTokens = numberAt(usage.output_tokens);
          if (typeof event.num_turns === "number") llmCalls = event.num_turns;
          if (event.is_error === true) {
            error = resultText || "Claude Code reported an unsuccessful turn.";
          }
        }
      },
    });
    if (initialized) {
      await writeFile(markerPath, `${sessionId}\n`, { mode: 0o600 });
    }
    if (cancellation.aborted && !error) {
      error = cancellation.reason?.message || "Claude Code turn was canceled.";
    }
    if (result.exitCode !== 0 && !error) {
      error =
        result.stderr.trim().slice(-4_000) ||
        `Claude Code exited with status ${result.exitCode ?? "unknown"}.`;
    }
    const limit = error ? claudeCodeSubscriptionLimitOf(error) : null;
    if (limit) {
      // Say so, with the reset when the CLI gave one. Nothing switches.
      error =
        limit.resetsAt !== undefined
          ? `Claude usage limit reached for ${options.claudeAccount.email}. It resets at ${new Date(limit.resetsAt).toUTCString()}.`
          : `Claude usage limit reached for ${options.claudeAccount.email}.`;
    }
    return {
      finalText,
      ...(error ? { error } : {}),
      usage: { inputTokens, outputTokens, llmCalls },
      sessionId: initialized ? sessionId : "",
    };
  } finally {
    // This directory contains the private loopback MCP bearer. It lives
    // outside every checkpoint root and exists only while Claude is alive.
    await mcpConfig.cleanup();
  }
};

/**
 * The general agent's coarse progress events (`/api/cloud/events`): one per
 * assistant text and one per tool call, as the agent loop reports them.
 */
export const cloudAgentProgressFromStream =
  (emitEvent: NativeEvent) =>
  (event: ClaudeStreamJsonEvent): void => {
    if (event.type !== "assistant") return;
    const message = event.message as { content?: unknown } | undefined;
    for (const text of textBlocks(message?.content)) {
      emitEvent("assistant_message", { text: text.slice(0, 8_000) });
    }
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use"
      ) {
        const tool = block as { name?: unknown; input?: unknown };
        emitEvent("tool_call", {
          name: typeof tool.name === "string" ? tool.name : "Claude tool",
          args: JSON.stringify(tool.input ?? {}).slice(0, 1_000),
        });
      }
    }
  };

export const runNativeAgentTurn = async (options: {
  profile: CloudClaudeRoleProfile;
  prompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  /** The owner's cloud Claude Code login this turn runs on. */
  claudeAccount: CloudClaudeAccountInput;
  threadId: string;
  turnId: string;
  authoritativeHistoryCursor: string;
  stateIntegrityKey: string;
  recoveryHistory?: AgentHistoryRow[];
  /** Test-only override; production always uses the root-only image path. */
  nativeStateRoot?: string;
  claudeMcpServerConfig?: CloudClaudeMcpServerConfig;
  onStreamEvent?: (event: ClaudeStreamJsonEvent) => void;
  cancellation?: NativeTurnCancellation;
}): Promise<NativeAgentTurnResult> => {
  const mcpServerConfig = options.claudeMcpServerConfig;
  if (!mcpServerConfig) {
    throw new Error("Stella's Claude tool bridge is unavailable.");
  }
  const stateRoot =
    options.nativeStateRoot ?? cloudNativeStateRootForThread(options.threadId);
  const relativeToWorkspace = path.relative(WORLD_ROOT, stateRoot);
  if (
    !path.isAbsolute(stateRoot) ||
    relativeToWorkspace === "" ||
    (!relativeToWorkspace.startsWith(`..${path.sep}`) &&
      relativeToWorkspace !== "..")
  ) {
    throw new Error(
      "Native agent session state must remain outside the agent workspace.",
    );
  }
  let inputPrompt = options.prompt;
  if (options.recoveryHistory !== undefined) {
    inputPrompt = buildNativeSessionRecoveryPrompt({
      history: options.recoveryHistory,
      expectedCursor: options.authoritativeHistoryCursor,
      prompt: options.prompt,
    });
    await assertFreshNativeState(stateRoot);
  } else {
    await assertNativeHistoryParity({
      stateRoot,
      engine: "anthropic",
      threadId: options.threadId,
      expectedCursor: options.authoritativeHistoryCursor,
      integrityKey: options.stateIntegrityKey,
    });
  }
  const result = await runCloudClaude({
    profile: options.profile,
    inputPrompt,
    systemPrompt: options.systemPrompt,
    execution: options.execution,
    claudeAccount: options.claudeAccount,
    stateRoot,
    mcpServerConfig,
    ...(options.onStreamEvent ? { onStreamEvent: options.onStreamEvent } : {}),
    ...(options.cancellation ? { cancellation: options.cancellation } : {}),
  });
  const messages = transcript({
    prompt: options.prompt,
    finalText: result.finalText || result.error || "",
    execution: options.execution,
    usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
  });
  if (!result.sessionId) {
    // The CLI exited before its init event; its own error says why.
    throw new Error(
      result.error
        ? `Claude Code did not start: ${result.error.slice(-1_000)}`
        : "Claude did not establish durable native session state.",
    );
  }
  const checkpoint = await sealNativeState({
    stateRoot,
    engine: "anthropic",
    threadId: options.threadId,
    sessionId: result.sessionId,
    cursor: nativeHistoryCursorFromMessages(options.turnId, messages),
    integrityKey: options.stateIntegrityKey,
  });
  const { sessionId: _sessionId, ...publicResult } = result;
  return {
    ...publicResult,
    messages,
    nativeStateCheckpoint: {
      engine: checkpoint.engine,
      sessionId: checkpoint.sessionId,
      cursor: checkpoint.cursor,
      tree: checkpoint.tree,
      mac: checkpoint.mac,
    },
  };
};
