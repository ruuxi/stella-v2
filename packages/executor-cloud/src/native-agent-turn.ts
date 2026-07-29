import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileChangeRecord } from "@stella/contracts/file-changes";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import { stellaManagedRelayBaseUrlFromSiteUrl } from "@stella/contracts/stella-api";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { WorkspaceIdentity } from "./workspace-paths.js";

type NativeEngine = "anthropic" | "openai-codex";

export type NativeAgentTurnResult = {
  finalText: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  messages: AgentMessage[];
  editedFiles: FileChangeRecord[];
};

type NativeEvent = (kind: string, payload: unknown) => void;

const INTERNAL_DIRS = new Set([
  ".git",
  ".stella",
  "node_modules",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
]);

const safeSegment = (value: string): string => {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return (
    normalized || createHash("sha256").update(value).digest("hex").slice(0, 24)
  );
};

const engineStateRoot = (
  workspace: WorkspaceIdentity,
  threadId: string,
  engine: NativeEngine,
): string => {
  const parent =
    workspace.kind === "project"
      ? path.join(workspace.root, ".git", "stella-cloud")
      : path.join(workspace.root, ".stella");
  return path.join(parent, "cloud-agents", safeSegment(threadId), engine);
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

type FileStamp = { size: number; mtimeMs: number };

const snapshotFiles = async (root: string): Promise<Map<string, FileStamp>> => {
  const files = new Map<string, FileStamp>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (INTERNAL_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const details = await stat(absolute).catch(() => null);
        if (details) {
          files.set(absolute, {
            size: details.size,
            mtimeMs: details.mtimeMs,
          });
        }
      }
    }
  };
  await walk(root);
  return files;
};

const changedFiles = (
  before: ReadonlyMap<string, FileStamp>,
  after: ReadonlyMap<string, FileStamp>,
): FileChangeRecord[] => {
  const records: FileChangeRecord[] = [];
  for (const [absolute, current] of after) {
    const previous = before.get(absolute);
    if (
      !previous ||
      previous.size !== current.size ||
      previous.mtimeMs !== current.mtimeMs
    ) {
      records.push({
        path: absolute,
        kind: { type: previous ? "update" : "add" },
      });
    }
  }
  return records;
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
  onJson: (value: Record<string, unknown>) => void;
}): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
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

export const resolveCodexReasoningEffort = (
  effort: AgentModelReasoningEffort,
): Exclude<AgentModelReasoningEffort, "default"> | undefined =>
  effort === "default" ? undefined : effort;

export const buildClaudeChildEnv = (options: {
  initialEnv: NodeJS.ProcessEnv;
  callbackBase: string;
  stateRoot: string;
  turnToken: string;
  reasoningEffort: AgentModelReasoningEffort;
}): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    ...options.initialEnv,
    ANTHROPIC_BASE_URL: stellaManagedRelayBaseUrlFromSiteUrl(
      options.callbackBase,
    ),
    CLAUDE_CODE_OAUTH_TOKEN: options.turnToken,
    CLAUDE_CONFIG_DIR: options.stateRoot,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    ANTHROPIC_CUSTOM_HEADERS: [
      `x-stella-turn-token: ${options.turnToken}`,
      "x-stella-llm-credential: anthropic",
      "x-stella-agent-type: general",
    ].join("\n"),
  };
  // These are executor credentials, not Claude credentials. Even if a future
  // caller imports this module before env-secrets consumes STELLA_TURN_TOKEN,
  // neither name may enter Claude's environment and reach a tool subprocess.
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

const tomlString = (value: string): string => JSON.stringify(value);

const transcript = (prompt: string, finalText: string): AgentMessage[] =>
  [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "assistant", content: [{ type: "text", text: finalText }] },
  ] as AgentMessage[];

const runClaude = async (options: {
  inputPrompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  callbackBase: string;
  turnToken: string;
  workspace: WorkspaceIdentity;
  threadId: string;
  emitEvent: NativeEvent;
}): Promise<Omit<NativeAgentTurnResult, "editedFiles" | "messages">> => {
  const stateRoot = engineStateRoot(
    options.workspace,
    options.threadId,
    "anthropic",
  );
  await mkdir(stateRoot, { recursive: true });
  const sessionId = deterministicUuid(
    `stella-cloud:claude:${options.threadId}`,
  );
  const markerPath = path.join(stateRoot, "session-started");
  const resume = await stat(markerPath).then(
    () => true,
    () => false,
  );
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    ...resolveClaudeModelArgs(options.execution.model),
    ...resolveClaudeReasoningArgs(options.execution.reasoningEffort),
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--append-system-prompt",
    options.systemPrompt,
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    options.inputPrompt,
  ];
  let finalText = "";
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  let initialized = resume;
  const childEnv = buildClaudeChildEnv({
    initialEnv: process.env,
    callbackBase: options.callbackBase,
    stateRoot,
    turnToken: options.turnToken,
    reasoningEffort: options.execution.reasoningEffort,
  });
  const result = await runJsonLines({
    command: "claude",
    args,
    cwd: options.workspace.root,
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
                name: typeof tool.name === "string" ? tool.name : "Claude tool",
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
  };
};

const runCodex = async (options: {
  inputPrompt: string;
  systemPrompt: string;
  execution: Extract<CloudExecutionSelection, { engine: "openai-codex" }>;
  callbackBase: string;
  turnToken: string;
  workspace: WorkspaceIdentity;
  threadId: string;
  emitEvent: NativeEvent;
}): Promise<Omit<NativeAgentTurnResult, "editedFiles" | "messages">> => {
  const stateRoot = engineStateRoot(
    options.workspace,
    options.threadId,
    "openai-codex",
  );
  await mkdir(stateRoot, { recursive: true });
  const sessionPath = path.join(stateRoot, "session-id");
  const existingSession = await readFile(sessionPath, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const relayBase = stellaManagedRelayBaseUrlFromSiteUrl(options.callbackBase);
  const reasoningEffort = resolveCodexReasoningEffort(
    options.execution.reasoningEffort,
  );
  const config = [
    'model_provider = "stella-cloud"',
    `model = ${tomlString(options.execution.model)}`,
    ...(reasoningEffort
      ? [`model_reasoning_effort = ${tomlString(reasoningEffort)}`]
      : []),
    `developer_instructions = ${tomlString(options.systemPrompt)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[features]",
    "enable_request_compression = false",
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    'exclude = ["STELLA_CODEX_TURN_TOKEN", "STELLA_TURN_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]',
    "",
    "[model_providers.stella-cloud]",
    'name = "Stella Cloud Codex"',
    `base_url = ${tomlString(relayBase)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'http_headers = { "x-stella-llm-credential" = "openai-codex", "x-stella-agent-type" = "general" }',
    'env_http_headers = { "x-stella-turn-token" = "STELLA_CODEX_TURN_TOKEN" }',
    "",
    "[model_providers.stella-cloud.auth]",
    'command = "node"',
    'args = ["/opt/stella/packages/executor-cloud/src/codex-token.mjs"]',
    "timeout_ms = 5000",
    "refresh_interval_ms = 0",
    `cwd = ${tomlString(stateRoot)}`,
    "",
  ].join("\n");
  await writeFile(path.join(stateRoot, "config.toml"), config, {
    mode: 0o600,
  });
  const commonArgs = [
    "--json",
    "--model",
    options.execution.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  const args = existingSession
    ? ["exec", "resume", ...commonArgs, existingSession, options.inputPrompt]
    : [
        "exec",
        ...commonArgs,
        "--cd",
        options.workspace.root,
        options.inputPrompt,
      ];
  let sessionId = existingSession;
  let finalText = "";
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  const result = await runJsonLines({
    command: "codex",
    args,
    cwd: options.workspace.root,
    env: {
      ...process.env,
      CODEX_HOME: stateRoot,
      STELLA_CODEX_TURN_TOKEN: options.turnToken,
    },
    onJson: (event) => {
      if (event.type === "thread.started") {
        const id = event.thread_id;
        if (typeof id === "string" && id.trim()) {
          sessionId = id.trim();
          void writeFile(sessionPath, `${sessionId}\n`, { mode: 0o600 });
        }
        return;
      }
      if (event.type === "item.started" || event.type === "item.completed") {
        const item =
          event.item && typeof event.item === "object"
            ? (event.item as Record<string, unknown>)
            : {};
        if (
          event.type === "item.started" &&
          (item.type === "command_execution" ||
            item.type === "mcp_tool_call" ||
            item.type === "web_search")
        ) {
          options.emitEvent("tool_call", {
            name:
              item.type === "command_execution"
                ? "exec_command"
                : String(item.type ?? "Codex tool"),
            args: String(
              item.command ?? item.query ?? item.arguments ?? "",
            ).slice(0, 1_000),
          });
        }
        if (event.type === "item.completed" && item.type === "agent_message") {
          const text =
            typeof item.text === "string"
              ? item.text.trim()
              : textBlocks(item.content).join("\n");
          if (text) {
            llmCalls += 1;
            finalText = text;
            options.emitEvent("assistant_message", {
              text: text.slice(0, 8_000),
            });
          }
        }
        return;
      }
      if (event.type === "turn.completed") {
        const usage =
          event.usage && typeof event.usage === "object"
            ? (event.usage as Record<string, unknown>)
            : {};
        inputTokens = numberAt(usage.input_tokens);
        outputTokens = numberAt(usage.output_tokens);
        return;
      }
      if (event.type === "error" || event.type === "turn.failed") {
        const candidate =
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : event.error && typeof event.error === "object"
                ? String((event.error as { message?: unknown }).message ?? "")
                : "";
        if (candidate.trim()) error = candidate.trim();
      }
    },
  });
  if (sessionId) {
    await writeFile(sessionPath, `${sessionId}\n`, { mode: 0o600 });
  }
  if (result.exitCode !== 0 && !error) {
    error =
      result.stderr.trim().slice(-4_000) ||
      `Codex exited with status ${result.exitCode ?? "unknown"}.`;
  }
  return {
    finalText,
    ...(error ? { error } : {}),
    usage: { inputTokens, outputTokens, llmCalls },
  };
};

export const runNativeAgentTurn = async (options: {
  prompt: string;
  systemPrompt: string;
  execution: Exclude<CloudExecutionSelection, { engine: "stella" }>;
  callbackBase: string;
  turnToken: string;
  workspace: WorkspaceIdentity;
  threadId: string;
  emitEvent: NativeEvent;
}): Promise<NativeAgentTurnResult> => {
  const before = await snapshotFiles(options.workspace.root);
  const result =
    options.execution.engine === "anthropic"
      ? await runClaude({
          inputPrompt: options.prompt,
          systemPrompt: options.systemPrompt,
          execution: options.execution,
          callbackBase: options.callbackBase,
          turnToken: options.turnToken,
          workspace: options.workspace,
          threadId: options.threadId,
          emitEvent: options.emitEvent,
        })
      : await runCodex({
          inputPrompt: options.prompt,
          systemPrompt: options.systemPrompt,
          execution: options.execution,
          callbackBase: options.callbackBase,
          turnToken: options.turnToken,
          workspace: options.workspace,
          threadId: options.threadId,
          emitEvent: options.emitEvent,
        });
  const after = await snapshotFiles(options.workspace.root);
  return {
    ...result,
    messages: transcript(
      options.prompt,
      result.finalText || result.error || "",
    ),
    editedFiles: changedFiles(before, after),
  };
};
