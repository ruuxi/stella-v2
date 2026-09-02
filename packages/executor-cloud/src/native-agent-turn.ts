import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
  GATEWAY_AGENT_TYPE_HEADER,
  gatewayRelayBaseUrl,
} from "@stella/contracts/gateway/api";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import { WORLD_ROOT } from "./workspace-paths.js";
import {
  assertFreshNativeState,
  assertNativeState,
  sealNativeState,
  type NativeStateAttestation,
} from "./native-state-integrity.js";

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
      JSON.stringify({ mcpServers: { stella: serverConfig } }),
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

export const CLOUD_NATIVE_STATE_ROOT = "/home/stella-native-state/anthropic";
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
  processIdentity?: ToolProcessIdentity;
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
      stdio: ["ignore", "pipe", "pipe"],
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
    child.on("error", reject);
    child.on("close", (exitCode) => {
      consume(pending);
      resolve({ exitCode, stderr });
    });
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
 * Claude Code talks to the model gateway's native lane directly: its base URL
 * is the gateway relay prefix and its OAuth bearer is the turn capability.
 * The gateway swaps that bearer for the owner's connected Anthropic
 * credential; no provider secret ever enters this process tree.
 */
export const buildClaudeChildEnv = (options: {
  initialEnv: NodeJS.ProcessEnv;
  gatewayOrigin: string;
  stateRoot: string;
  capability: string;
  reasoningEffort: AgentModelReasoningEffort;
}): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    ...options.initialEnv,
    ANTHROPIC_BASE_URL: gatewayRelayBaseUrl(options.gatewayOrigin),
    CLAUDE_CODE_OAUTH_TOKEN: options.capability,
    CLAUDE_CONFIG_DIR: options.stateRoot,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    ANTHROPIC_CUSTOM_HEADERS: [
      `${GATEWAY_AGENT_TYPE_HEADER}: general`,
      "x-stella-llm-credential: anthropic",
    ].join("\n"),
  };
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
  return childEnv;
};

export const buildCloudClaudeTakeoverArgs = (options: {
  model: string;
  reasoningEffort: AgentModelReasoningEffort;
  systemPrompt: string;
  mcpConfigPath: string;
  resume: boolean;
  sessionId: string;
  inputPrompt: string;
}): string[] => [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
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
  options.inputPrompt,
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

const runClaude = async (options: {
  inputPrompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  gatewayOrigin: string;
  capability: string;
  stateRoot: string;
  threadId: string;
  mcpServerConfig: CloudClaudeMcpServerConfig;
  emitEvent: NativeEvent;
}): Promise<NativeCliTurnResult> => {
  const stateRoot = options.stateRoot;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const sessionId = deterministicUuid(
    `stella-cloud:claude:${options.threadId}`,
  );
  const markerPath = path.join(stateRoot, "session-started");
  const resume = await stat(markerPath).then(
    () => true,
    () => false,
  );
  const mcpConfig = await createCloudClaudeMcpConfig(options.mcpServerConfig);
  try {
    const args = buildCloudClaudeTakeoverArgs({
      model: options.execution.model,
      reasoningEffort: options.execution.reasoningEffort,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: mcpConfig.path,
      resume,
      sessionId,
      inputPrompt: options.inputPrompt,
    });
    let finalText = "";
    let error: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let llmCalls = 0;
    let initialized = resume;
    const childEnv = buildClaudeChildEnv({
      initialEnv: process.env,
      gatewayOrigin: options.gatewayOrigin,
      stateRoot,
      capability: options.capability,
      reasoningEffort: options.execution.reasoningEffort,
    });
    const result = await runJsonLines({
      command: "claude",
      args,
      cwd: WORLD_ROOT,
      env: childEnv,
      onJson: (event) => {
        const type = event.type;
        if (type === "system" && event.subtype === "init") {
          initialized = true;
          void writeFile(markerPath, `${sessionId}\n`, { mode: 0o600 });
          return;
        }
        if (type === "assistant") {
          llmCalls += 1;
          const message = event.message as
            | { content?: unknown; usage?: Record<string, unknown> }
            | undefined;
          const texts = textBlocks(message?.content);
          for (const text of texts) {
            finalText = text;
            options.emitEvent("assistant_message", {
              text: text.slice(0, 8_000),
            });
          }
          if (Array.isArray(message?.content)) {
            for (const block of message.content) {
              if (
                block &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "tool_use"
              ) {
                const tool = block as {
                  name?: unknown;
                  input?: unknown;
                };
                options.emitEvent("tool_call", {
                  name:
                    typeof tool.name === "string" ? tool.name : "Claude tool",
                  args: JSON.stringify(tool.input ?? {}).slice(0, 1_000),
                });
              }
            }
          }
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
    if (result.exitCode !== 0 && !error) {
      error =
        result.stderr.trim().slice(-4_000) ||
        `Claude Code exited with status ${result.exitCode ?? "unknown"}.`;
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

export const runNativeAgentTurn = async (options: {
  prompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  /** Public origin of the model gateway (`MODEL_GATEWAY_URL`). */
  gatewayOrigin: string;
  /** Turn capability; only valid at the gateway, budgeted, and expiring. */
  capability: string;
  threadId: string;
  turnId: string;
  authoritativeHistoryCursor: string;
  stateIntegrityKey: string;
  /** Test-only override; production always uses the root-only image path. */
  nativeStateRoot?: string;
  claudeMcpServerConfig?: CloudClaudeMcpServerConfig;
  emitEvent: NativeEvent;
}): Promise<NativeAgentTurnResult> => {
  const mcpServerConfig = options.claudeMcpServerConfig;
  if (!mcpServerConfig) {
    throw new Error("Stella's Claude tool bridge is unavailable.");
  }
  const stateRoot = options.nativeStateRoot ?? CLOUD_NATIVE_STATE_ROOT;
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
  await assertNativeHistoryParity({
    stateRoot,
    engine: "anthropic",
    threadId: options.threadId,
    expectedCursor: options.authoritativeHistoryCursor,
    integrityKey: options.stateIntegrityKey,
  });
  const result = await runClaude({
    inputPrompt: options.prompt,
    systemPrompt: options.systemPrompt,
    execution: options.execution,
    gatewayOrigin: options.gatewayOrigin,
    capability: options.capability,
    stateRoot,
    threadId: options.threadId,
    mcpServerConfig,
    emitEvent: options.emitEvent,
  });
  const messages = transcript({
    prompt: options.prompt,
    finalText: result.finalText || result.error || "",
    execution: options.execution,
    usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
  });
  if (!result.sessionId) {
    throw new Error("Claude did not establish durable native session state.");
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
