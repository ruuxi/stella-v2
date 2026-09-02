/**
 * The real cloud agent turn: Stella's own runtime (agent-core loop + tool
 * host) running headless in the sandbox as the spawned general agent.
 *
 * The BuildSession DO restores the workspace before invoking this and
 * checkpoints it after; this module only runs the loop. Model calls, events,
 * and transcript writes go through the short-lived Builder broker capability;
 * the reusable Convex turn token never enters this process. The final line on
 * stdout is the structured report the DO parses.
 */

import { constants as fsConstants, existsSync } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  readFile,
  mkdir,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { TSchema } from "@sinclair/typebox";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  isCloudBrowserResumeReceipt,
  type CloudBrowserResumeReceipt,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";
import type { ToolContext } from "@stella/runtime/kernel/tools/host.js";
import {
  createClaudeCodeToolMcpHost,
  type ClaudeCodeToolMcpHost,
} from "@stella/runtime/kernel/integrations/claude-code-tool-mcp-host.js";
import {
  TOOL_RESULT_AUTHORIZED_IMAGES,
  type ToolMetadata,
  type ToolResult,
  type ToolUpdateCallback,
} from "@stella/runtime/kernel/tools/types.js";
import {
  neutralizeLegacyAttachImageMarkers,
  prepareAuthorizedToolImageBlocks,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentRunWithRetry,
  prepareTransientResumeTail,
} from "@stella/runtime/kernel/agent-runtime/run-retry.js";
import {
  buildDefaultTransformContext,
  extractAssistantText,
  getAgentCompletion,
} from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import {
  createCloudRelayModel,
  resolveCloudThinkingLevel,
} from "./relay-model.js";
import { pruneAgentHistory } from "./prune-history.js";
import {
  emptyDriveSync,
  materializeDriveFiles,
  type DriveSyncResult,
} from "./drive-sync.js";
import {
  collectProducedFiles,
  reportProducedFiles,
  toDriveFile,
  type ProducedFileReport,
} from "./produced-files.js";
import {
  buildGeneralAgentPrompt,
  type GeneralAgentPromptSkills,
} from "./general-agent-prompt.js";
import {
  WORLD_DRIVE_ROOT,
  WORLD_DRIVE_WORKSPACE,
  WORLD_ROOT,
  toolStateDir,
} from "./workspace-paths.js";
import {
  nativeHistoryCursorFromMessages,
  nativeHistoryCursorFromRows,
  runNativeAgentTurn,
} from "./native-agent-turn.js";
import {
  parseAuthoritativeAgentHistory,
  type AgentHistoryRow,
} from "./agent-history.js";
import {
  TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
  type TurnBrokerInput,
  type TurnBrokerInteriorBuildRequest,
  type TurnBrokerTurnStateCheckpointRequest,
  type TurnBrokerTurnStateCheckpointReceipt,
} from "@stella/contracts/turn-credential-broker";
import {
  takeTurnBrokerHandoff,
  TurnCredentialBrokerClient,
} from "./turn-credential-broker.js";
import {
  assertCloudMountedDirectoryBoundary,
  assertToolOwnedDirectory,
  CLOUD_HOST_STATE,
  CLOUD_TOOL_HOME,
  CLOUD_TOOL_PROCESS_IDENTITY,
  proveStrictCloudProcessIsolation,
} from "./cloud-process-isolation.js";
import {
  isAgentToolSuspendedError,
  type AgentToolSuspendedError,
} from "@stella/runtime/kernel/agent-core/suspension.js";
import { createTurnBrokerBrowserSessionFactory } from "./cloud-browser-session.js";

export { CLOUD_TOOL_PROCESS_IDENTITY } from "./cloud-process-isolation.js";

/**
 * The turn input file sits above the workspace root and is readable by every
 * shell the agent runs, so the executor consumes it and immediately unlinks
 * it: the thread history and broker handoff it carries are executor inputs,
 * not the agent's context.
 */
const TURN_INPUT_PATH = "/workspace/turn-input.json";

export type CloudModelGatewayInput = {
  /** Public origin of the model gateway (`MODEL_GATEWAY_URL`). */
  origin: string;
  /** Turn capability minted by the admitting Durable Object. */
  capability: string;
};

/** Fail closed on anything but an HTTPS origin and a compact JWS capability. */
export const parseCloudModelGatewayInput = (
  value: unknown,
): CloudModelGatewayInput | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.origin !== "string" || typeof row.capability !== "string") {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(row.origin);
  } catch {
    return null;
  }
  const localHttp =
    origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
  if (
    (origin.protocol !== "https:" && !localHttp) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.capability)) {
    return null;
  }
  return { origin: origin.origin, capability: row.capability };
};

export type AgentTurnInput = {
  kind: "agent";
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  prompt: string;
  /** Builder-owned fact: this attempt restored a durable world backup. */
  workspaceRestored: boolean;
  /** Builder-derived HMAC key; consumed before any model/tool process exists. */
  nativeStateIntegrityKey: string;
  /** One-shot pointer to the Builder-owned, short-lived turn broker. */
  turnBroker: TurnBrokerInput;
  /**
   * Model gateway access for this exact turn. The capability is a signed,
   * turn-scoped, budgeted, expiring token that is only valid at the gateway;
   * the sandbox sends model traffic there directly.
   */
  modelGateway: CloudModelGatewayInput;
  /** Prior thread transcript rows, oldest first (send_input continuations). */
  history?: AgentHistoryRow[];
  /** Safe approval receipt used to resume a previously suspended code call. */
  browserResume?: CloudBrowserResumeReceipt;
  /** Canonical model route authorized for this turn at dispatch. */
  execution: CloudExecutionSelection;
  /**
   * Version-pinned, owner-authorized skill packages materialized by the
   * worker into this sandbox's ephemeral filesystem. Contains no R2 keys.
   */
  skills?: GeneralAgentPromptSkills;
};

export type AgentTurnTerminalResult = {
  outcome?: "completed";
  ok: boolean;
  finalText: string;
  error?: string;
  /**
   * A pre-agent failure must not replace the last good checkpoint (or create
   * an empty first checkpoint), so the same preflight can be retried safely.
   */
  checkpointPolicy?: "preserve_prior" | "builder_fallback";
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  /** Builder-owned archive commit latency observed through the broker. */
  checkpointMs?: number;
  /** Exact staged archive pair; Builder promotes it only after transcript ACK. */
  turnStateCheckpoint?: TurnBrokerTurnStateCheckpointReceipt;
  /**
   * All model-controlled writers were not proven joined in-process. Builder
   * must kill the exact execution session, then archive and append these rows.
   */
  builderFallback?: {
    historyCursor: string;
    messages: Array<{ ordinal: number; role: string; payloadJson: string }>;
    nativeCheckpoint?: Awaited<
      ReturnType<typeof runNativeAgentTurn>
    >["nativeStateCheckpoint"];
  };
  suspension?: never;
};

export type AgentTurnSuspendedResult = {
  outcome: "suspended";
  ok: false;
  finalText: "";
  suspension: CloudBrowserSuspension;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  checkpointMs: number;
  turnStateCheckpoint: TurnBrokerTurnStateCheckpointReceipt;
};

export type AgentTurnResult =
  | AgentTurnTerminalResult
  | AgentTurnSuspendedResult;

const CLOUD_BROWSER_RESUME_KEYS = [
  "schemaVersion",
  "interactionId",
  "interactionRevision",
  "profileId",
  "profileEpoch",
  "toolCallId",
  "requestDigest",
  "result",
  "safeMessage",
] as const;

/**
 * Rebuild the one provider-visible result at the durable continuation seam.
 * Extra input keys are rejected so a malformed dispatch cannot piggyback
 * browser state into the transcript.
 */
export const createCloudBrowserResumeToolResult = (
  history: readonly AgentMessage[],
  receipt: CloudBrowserResumeReceipt,
  timestamp = Date.now(),
): AgentMessage => {
  if (
    !isCloudBrowserResumeReceipt(receipt) ||
    Object.keys(receipt).sort().join(",") !==
      [...CLOUD_BROWSER_RESUME_KEYS].sort().join(",")
  ) {
    throw new Error("Cloud browser resume receipt is invalid.");
  }
  if (
    history.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolCallId === receipt.toolCallId,
    )
  ) {
    throw new Error("Cloud browser resume was already appended.");
  }

  let toolName: string | undefined;
  let assistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "assistant") continue;
    const matches = message.content.filter(
      (part): part is AgentToolCall =>
        part.type === "toolCall" && part.id === receipt.toolCallId,
    );
    if (matches.length === 1) {
      toolName = matches[0]!.name;
      assistantIndex = index;
      break;
    }
  }
  if (toolName !== "code" || assistantIndex < 0) {
    throw new Error(
      "Cloud browser resume does not match the canonical assistant tool call.",
    );
  }
  if (
    history
      .slice(assistantIndex + 1)
      .some((message) => message.role !== "toolResult")
  ) {
    throw new Error("Cloud browser resume history is not continuable.");
  }
  return {
    role: "toolResult",
    toolCallId: receipt.toolCallId,
    toolName,
    content: [{ type: "text", text: receipt.safeMessage }],
    details: {
      browserResume: {
        schemaVersion: 1,
        interactionId: receipt.interactionId,
        interactionRevision: receipt.interactionRevision,
        profileId: receipt.profileId,
        profileEpoch: receipt.profileEpoch,
        requestDigest: receipt.requestDigest,
        result: receipt.result,
      },
    },
    isError: receipt.result !== "approved",
    timestamp,
  };
};

export const createSuspendedAgentTurnResult = (args: {
  error: AgentToolSuspendedError;
  usage: AgentTurnSuspendedResult["usage"];
  checkpointMs: number;
  turnStateCheckpoint: TurnBrokerTurnStateCheckpointReceipt;
}): AgentTurnSuspendedResult => ({
  outcome: "suspended",
  ok: false,
  finalText: "",
  suspension: args.error.suspension,
  usage: args.usage,
  checkpointMs: args.checkpointMs,
  turnStateCheckpoint: args.turnStateCheckpoint,
});

/**
 * Pinned in code, not read from agent-metadata: the sandbox image's home-seed
 * copy is agent-writable in principle, and the cloud contract is that
 * allowlists governing execution surfaces are never data-driven.
 *
 * The document and media stack adds no tool names — the host exposes
 * `stella-office`, poppler and `mediainfo` as shell commands, so they arrive
 * through `exec_command`. `Read` is the one catalog addition they need: a
 * plain-text read of extracted document text that does not cost a PTY turn.
 * `Grep` stays out deliberately; its handler downloads ripgrep into
 * `stellaDataDir/bin` on first use, which lands inside the checkpointed
 * workspace forever.
 */
const CLOUD_GENERAL_TOOLS = [
  "exec_command",
  "write_stdin",
  "apply_patch",
  "web",
  "view_image",
  "Read",
] as const;

const CLOUD_STELLA_TOOLS = [...CLOUD_GENERAL_TOOLS, "code"] as const;

export const cloudGeneralToolNames = (
  engine: CloudExecutionSelection["engine"],
): readonly string[] =>
  engine === "stella" ? CLOUD_STELLA_TOOLS : CLOUD_GENERAL_TOOLS;

export const PUBLISH_STELLA_INTERIOR_TOOL = "publish_stella_interior";

/**
 * The one pinned tool with no ToolHost handler behind it. `executeCloudTool`
 * answers it by posting a turn-broker command, which keeps the name identical
 * in the Stella agent loop and in Claude's MCP catalog.
 */
const PUBLISH_STELLA_INTERIOR_METADATA: ToolMetadata = {
  name: PUBLISH_STELLA_INTERIOR_TOOL,
  label: "Publish interior build",
  workingText: "Requesting the interior build",
  description:
    "Ask Stella to run the immutable production build of this Stella interior workspace after this turn finishes, and record the result as a candidate the user can select in Settings. Call it once, only when your source changes are complete and you would stand behind them. It publishes nothing on its own: the user chooses whether to switch to the candidate.",
  parameters: {
    type: "object",
    properties: {
      note: {
        type: "string",
        maxLength: 512,
        description:
          "Optional one-line summary of what changed, for the build record.",
      },
    },
    additionalProperties: false,
  },
};

/** Only Claude Code owns a native CLI loop; Codex uses Stella's Agent loop. */
export const usesNativeCloudRuntime = (
  execution: CloudExecutionSelection,
): execution is Extract<CloudExecutionSelection, { engine: "anthropic" }> =>
  execution.engine === "anthropic";

/**
 * Every cloud agent turn can reach the interior source at `world/stella`, so
 * the request tool is always in the catalog.
 */
export const cloudPinnedWorkspaceTools = (): readonly ToolMetadata[] => [
  PUBLISH_STELLA_INTERIOR_METADATA,
];

export const requestStellaInteriorBuild = async (args: {
  post: (route: string, body: unknown) => Promise<Response>;
  params: Record<string, unknown>;
}): Promise<ToolResult> => {
  const note = args.params.note;
  if (note !== undefined && (typeof note !== "string" || note.length > 512)) {
    return { error: "note must be a string of at most 512 characters." };
  }
  const request: TurnBrokerInteriorBuildRequest = {
    schemaVersion: 1,
    ...(note ? { note } : {}),
  };
  const response = await args.post(
    TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
    request,
  );
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    return {
      error:
        "Stella could not accept the interior build request for this turn.",
    };
  }
  return {
    result:
      "Interior build will run when the turn completes successfully. It produces a candidate; the user selects it in Settings.",
  };
};

export const checkpointCloudBrowserTurnBeforeTeardown = async (args: {
  codeToolCallIds: readonly string[];
  suspended: boolean;
  endBrowserTurn: (
    toolCallId: string,
    behavior: "retain-tabs",
  ) => Promise<void>;
}): Promise<void> => {
  if (args.suspended) return;
  // A later Code cell might not touch the browser, so walk every call id
  // newest-first; only the id held by a live browser session acts.
  for (const toolCallId of [...args.codeToolCallIds].reverse()) {
    await args.endBrowserTurn(toolCallId, "retain-tabs");
  }
};

export const createBuilderFallbackAgentTurnResult = (args: {
  finalText: string;
  notice?: string;
  error?: string;
  usage: AgentTurnTerminalResult["usage"];
  historyCursor: string;
  messages: NonNullable<
    AgentTurnTerminalResult["builderFallback"]
  >["messages"];
  nativeCheckpoint?: NonNullable<
    AgentTurnTerminalResult["builderFallback"]
  >["nativeCheckpoint"];
}): AgentTurnTerminalResult => ({
  ok: !args.error,
  finalText:
    `${args.finalText || (args.error ? "" : "The agent finished without a report.")}${args.notice ?? ""}`.trim(),
  ...(args.error ? { error: args.error } : {}),
  checkpointPolicy: "builder_fallback",
  usage: args.usage,
  builderFallback: {
    historyCursor: args.historyCursor,
    messages: args.messages,
    ...(args.nativeCheckpoint
      ? { nativeCheckpoint: args.nativeCheckpoint }
      : {}),
  },
});

/**
 * Make the restored workspace writable by the fixed tool account without ever
 * following a workspace symlink. The trusted executor and native Claude
 * process remain root; only model-authored ToolHost child processes use this
 * identity, so `/home/stella-native-state` stays unreadable to them.
 */
export const chownTreeWithoutFollowingSymlinks = async (
  root: string,
  uid: number = CLOUD_TOOL_PROCESS_IDENTITY.uid,
  gid: number = CLOUD_TOOL_PROCESS_IDENTITY.gid,
): Promise<void> => {
  const visit = async (target: string, isRoot: boolean): Promise<void> => {
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      if (isRoot) {
        throw new Error("Cloud workspace root must not be a symbolic link.");
      }
      await lchown(target, uid, gid);
      return;
    }
    if (details.isFile() && details.nlink !== 1) {
      throw new Error("Cloud workspace contains a hard-linked file.");
    }
    await chown(target, uid, gid);
    if (!details.isDirectory()) return;
    for (const entry of await readdir(target)) {
      await visit(path.join(target, entry), false);
    }
  };
  await visit(root, true);
};

export const prepareCloudToolFilesystem = async (args: {
  workspaceRoot: string;
  workspaceStateDir?: string;
  driveStateDir?: string;
  toolHome: string;
}): Promise<void> => {
  await assertCloudMountedDirectoryBoundary({
    workspaceRoot: args.workspaceRoot,
  });
  const ensureToolDirectory = async (target: string): Promise<void> => {
    let created = false;
    try {
      await mkdir(target, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const handle = await open(
      target,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (!details.isDirectory()) {
        throw new Error("Cloud tool state must be a real directory.");
      }
      if (created) {
        await handle.chown(
          CLOUD_TOOL_PROCESS_IDENTITY.uid,
          CLOUD_TOOL_PROCESS_IDENTITY.gid,
        );
        await handle.chmod(0o700);
      }
    } finally {
      await handle.close();
    }
    await assertToolOwnedDirectory(target, 0o700);
  };
  await ensureToolDirectory(args.toolHome);
  for (const target of new Set(
    [args.workspaceStateDir, args.driveStateDir].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate !== args.toolHome,
    ),
  )) {
    await ensureToolDirectory(target);
  }
  await proveStrictCloudProcessIsolation();
};

export const commitTurnStateBeforeTranscript = async (args: {
  historyCursor: string;
  nativeCheckpoint?: Awaited<
    ReturnType<typeof runNativeAgentTurn>
  >["nativeStateCheckpoint"];
  suspensionTranscript?: TurnBrokerTurnStateCheckpointRequest["suspensionTranscript"];
  broker: Pick<TurnCredentialBrokerClient, "commitTurnStateCheckpoint">;
  appendTranscript: () => Promise<void>;
}): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  const receipt = await args.broker.commitTurnStateCheckpoint({
    historyCursor: args.historyCursor,
    ...(args.nativeCheckpoint
      ? { nativeCheckpoint: args.nativeCheckpoint }
      : {}),
    ...(args.suspensionTranscript
      ? { suspensionTranscript: args.suspensionTranscript }
      : {}),
  });
  await args.appendTranscript();
  return receipt;
};

/**
 * The office CLI ships inside the image next to the runtime. The tool host
 * turns this into a `stella-office` shell function plus `STELLA_OFFICE_BIN`,
 * so document work runs through `exec_command` rather than a dedicated tool.
 */
const resolveOfficeBinPath = (): string | undefined => {
  const candidate =
    process.env.STELLA_OFFICE_BIN?.trim() ||
    fileURLToPath(
      new URL("../../stella-office/bin/stella-office.js", import.meta.url),
    );
  return existsSync(candidate) ? candidate : undefined;
};

/**
 * The container path's prompt: the world is on disk and the drive was
 * synchronized before the model ran, so it renders the materialized variant.
 * Kept as a named export because both prompt tests and the interior-build
 * suite assert on the sentences a given `DriveSyncResult` produces.
 */
export const CLOUD_GENERAL_PROMPT = (options: {
  office: boolean;
  drive?: DriveSyncResult;
  skills?: GeneralAgentPromptSkills;
}): string =>
  buildGeneralAgentPrompt({
    workspace: "materialized",
    office: options.office,
    ...(options.drive ? { drive: options.drive } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
  });

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const hydrateDriveForAgentTurn = async (
  options: Parameters<typeof materializeDriveFiles>[0],
  materialize: typeof materializeDriveFiles = materializeDriveFiles,
): Promise<DriveSyncResult> => {
  try {
    return await materialize(options);
  } catch (error) {
    throw new Error(
      `Drive hydration could not establish an authoritative workspace; refusing to run the agent against stale or incomplete files: ${asError(error).message}`,
      { cause: error },
    );
  }
};

export const runAgentTurn = (): Effect.Effect<AgentTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: async () => {
          const raw = await readFile(TURN_INPUT_PATH, "utf8");
          await rm(TURN_INPUT_PATH, { force: true });
          return JSON.parse(raw) as AgentTurnInput;
        },
        catch: asError,
      });
      const broker = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () =>
            new TurnCredentialBrokerClient(
              await takeTurnBrokerHandoff(input.turnBroker),
            ),
          catch: asError,
        }),
        (client) => Effect.sync(() => client.close()),
      );
      const modelGateway = parseCloudModelGatewayInput(input.modelGateway);
      if (!modelGateway) {
        return {
          ok: false,
          finalText: "",
          error:
            "Stella couldn't validate this agent's managed model access. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      let history: AgentMessage[];
      try {
        history = pruneAgentHistory(
          parseAuthoritativeAgentHistory(input.history ?? []),
        );
      } catch (error) {
        console.error(
          `authoritative agent history rejected: ${asError(error).message}`,
        );
        return {
          ok: false,
          finalText: "",
          error:
            "Stella couldn't validate this agent's conversation history. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      let browserResumeMessage: AgentMessage | undefined;
      if (input.browserResume) {
        if (input.execution.engine !== "stella") {
          return {
            ok: false,
            finalText: "",
            error: "Cloud browser resume requires the Stella engine.",
            usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
            checkpointPolicy: "preserve_prior",
          };
        }
        try {
          browserResumeMessage = createCloudBrowserResumeToolResult(
            history,
            input.browserResume,
          );
          history = [...history, browserResumeMessage];
        } catch {
          return {
            ok: false,
            finalText: "",
            error:
              "Stella couldn't validate this browser continuation. Try again.",
            usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
            checkpointPolicy: "preserve_prior",
          };
        }
      }
      if (!/^[0-9a-f]{64}$/.test(input.nativeStateIntegrityKey)) {
        return {
          ok: false,
          finalText: "",
          error:
            "Stella couldn't validate this agent's native session state. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      const workspaceRoot = WORLD_ROOT;
      const workspaceStateDir = toolStateDir(workspaceRoot);
      const driveWorkspace = WORLD_DRIVE_WORKSPACE;
      const toolHome = CLOUD_TOOL_HOME;
      yield* Effect.tryPromise({
        try: () =>
          prepareCloudToolFilesystem({
            workspaceRoot,
            workspaceStateDir,
            driveStateDir: driveWorkspace.stateDir,
            toolHome,
          }),
        catch: asError,
      });
      const postJson = async (
        route: string,
        body: unknown,
      ): Promise<Response> => await broker.postJson(route, body);

      // Ordered, best-effort progress events; a lost event never fails the
      // turn (the DO writes the terminal event either way).
      let eventChain: Promise<unknown> = Promise.resolve();
      const emitEvent = (kind: string, payload: unknown): void => {
        eventChain = eventChain
          .then(() =>
            postJson("/api/cloud/events", {
              turnId: input.turnId,
              attemptGeneration: input.attemptGeneration,
              sessionId: input.threadId,
              seq: "auto",
              kind,
              payload,
            }),
          )
          .catch((error) => {
            console.error(`event ${kind} failed: ${asError(error).message}`);
          });
      };

      // Bring the drive into `world/drive` before any agent tool exists. Its
      // hydration ledger lives in the contained Drive state directory created
      // above, and lets a turn skip re-downloading a drive it already has.
      const hydration = yield* Effect.promise(async () => {
        try {
          return {
            ok: true as const,
            value: await hydrateDriveForAgentTurn({
              turnId: input.turnId,
              prompt: input.prompt,
              workspaceRoot: driveWorkspace.root,
              workspaceRestored: input.workspaceRestored,
              stateDir: driveWorkspace.stateDir,
              owner: CLOUD_TOOL_PROCESS_IDENTITY,
              post: postJson,
              onProgress: (message) => emitEvent("progress", { message }),
            }),
          };
        } catch (error) {
          return { ok: false as const, error: asError(error) };
        }
      });
      if (!hydration.ok) {
        return {
          ok: false,
          finalText: "",
          error: hydration.error.message,
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      const driveSync = hydration.value;

      const officeBinPath = resolveOfficeBinPath();
      const cloudSystemPrompt = CLOUD_GENERAL_PROMPT({
        office: Boolean(officeBinPath),
        ...(input.skills ? { skills: input.skills } : {}),
        drive: driveSync,
      });
      const toolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: CLOUD_HOST_STATE,
            recoverStaleSecrets: false,
            enableShellShims: false,
            ...(input.execution.engine === "stella"
              ? {
                  allowCloudCode: true,
                  browserSessionFactory:
                    createTurnBrokerBrowserSessionFactory(broker),
                }
              : {}),
            ...(officeBinPath ? { stellaOfficeBinPath: officeBinPath } : {}),
            webSearch: async (query, options) => {
              const response = await postJson("/api/cloud/web-search", {
                query,
                category: options?.category,
              });
              if (!response.ok) {
                return { text: `WebSearch failed (${response.status}).` };
              }
              return (await response.json()) as {
                text: string;
                results?: Array<{
                  title: string;
                  url: string;
                  snippet: string;
                }>;
              };
            },
          }),
        ),
        (host) =>
          Effect.tryPromise({
            try: () => host.shutdown(),
            catch: asError,
          }).pipe(Effect.orDie),
      );

      const context: ToolContext = {
        conversationId: input.threadId,
        deviceId: "cloud",
        requestId: crypto.randomUUID(),
        agentType: "general",
        workingDirectory: workspaceRoot,
        stellaAppDir: workspaceRoot,
        stellaDataDir: workspaceStateDir,
        toolWorkspaceRoot: workspaceRoot,
        storageMode: "cloud",
        toolProcessIdentity: {
          ...CLOUD_TOOL_PROCESS_IDENTITY,
          home: toolHome,
        },
        agentId: input.threadId,
        agentDepth: 1,
        maxAgentDepth: 1,
      };

      const cloudCodeToolCallIds: string[] = [];

      const catalog = toolHost.getToolCatalog("general", {});
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const cloudToolMetadata = [
        ...cloudGeneralToolNames(input.execution.engine)
          .map((name) => byName.get(name))
          .filter((tool): tool is ToolMetadata => Boolean(tool)),
        ...cloudPinnedWorkspaceTools(),
      ];
      const executeCloudTool = async (
        toolCallId: string,
        name: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: ToolUpdateCallback,
      ): Promise<ToolResult> => {
        if (name === "code" && !cloudCodeToolCallIds.includes(toolCallId)) {
          cloudCodeToolCallIds.push(toolCallId);
        }
        if (name === PUBLISH_STELLA_INTERIOR_TOOL) {
          return await requestStellaInteriorBuild({
            post: postJson,
            params,
          });
        }
        const result = await toolHost.executeTool(
          name,
          params,
          { ...context, requestId: toolCallId },
          signal,
          onUpdate,
        );
        return result;
      };
      const tools: AgentTool[] = cloudToolMetadata.map((meta) => ({
        name: meta.name,
        label: meta.label ?? meta.name,
        ...(meta.workingText ? { workingText: meta.workingText } : {}),
        description: meta.description,
        parameters: meta.parameters as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const result = await executeCloudTool(
            toolCallId,
            meta.name,
            (params ?? {}) as Record<string, unknown>,
            signal,
          );
          if (result.error) throw new Error(result.error);
          const rawText =
            typeof result.result === "string"
              ? result.result
              : result.result === undefined
                ? ""
                : JSON.stringify(result.result, null, 2);
          const text = neutralizeLegacyAttachImageMarkers(rawText);
          const images = await prepareAuthorizedToolImageBlocks(
            result[TOOL_RESULT_AUTHORIZED_IMAGES],
            {
              provider: input.execution.provider,
              modelId: input.execution.model,
            },
          );
          const visibleText =
            text.length > 30_000
              ? `${text.slice(0, 15_000)}\n…[truncated]…\n${text.slice(-15_000)}`
              : text;
          return {
            content: [
              ...(visibleText || images.length === 0
                ? [
                    {
                      type: "text" as const,
                      text: visibleText || "(no output)",
                    },
                  ]
                : []),
              ...images,
            ],
            details: result.details ?? null,
          };
        },
      }));

      let claudeToolMcpHost: ClaudeCodeToolMcpHost | undefined;
      if (usesNativeCloudRuntime(input.execution)) {
        claudeToolMcpHost = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              createClaudeCodeToolMcpHost({
                tools: cloudToolMetadata,
                identityScope: `${input.threadId}:${input.turnId}`,
                allowLegacyImagePathReopen: false,
                getActiveTurn: () => ({
                  identityScope: `${input.threadId}:${input.turnId}`,
                  executeTool: (toolCallId, toolName, args, signal, onUpdate) =>
                    executeCloudTool(
                      toolCallId,
                      toolName,
                      args,
                      signal,
                      onUpdate,
                    ),
                }),
              }),
            catch: asError,
          }),
          (host) =>
            Effect.promise(async () => {
              await host.close().catch((error) => {
                console.error(
                  `Claude MCP finalizer failed: ${asError(error).message}`,
                );
              });
            }),
        );
      }

      // Long-running threads accumulate transcript across send_input
      // continuations; keep the newest window that fits the model.

      let llmCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let checkpointMs = 0;
      let turnStateCheckpoint: TurnBrokerTurnStateCheckpointReceipt | undefined;
      let execution: { finalText: string; errorMessage?: string };
      let produced: AgentMessage[];
      let suspendedError: AgentToolSuspendedError | undefined;
      let forceBuilderFallback = false;
      let nativeStateCheckpoint:
        | Awaited<
            ReturnType<typeof runNativeAgentTurn>
          >["nativeStateCheckpoint"]
        | undefined;
      if (usesNativeCloudRuntime(input.execution)) {
        const nativeExecution = input.execution;
        const nativeOutcome = yield* Effect.promise(async () => {
          try {
            return {
              ok: true as const,
              value: await runNativeAgentTurn({
                prompt: input.prompt,
                systemPrompt: cloudSystemPrompt,
                execution: nativeExecution,
                gatewayOrigin: modelGateway.origin,
                capability: modelGateway.capability,
                threadId: input.threadId,
                turnId: input.turnId,
                authoritativeHistoryCursor: nativeHistoryCursorFromRows(
                  input.history ?? [],
                ),
                stateIntegrityKey: input.nativeStateIntegrityKey,
                ...(claudeToolMcpHost
                  ? {
                      claudeMcpServerConfig: claudeToolMcpHost.mcpServerConfig,
                    }
                  : {}),
                emitEvent,
              }),
            };
          } catch (error) {
            return { ok: false as const, error: asError(error) };
          }
        });
        if (!nativeOutcome.ok) {
          forceBuilderFallback = true;
          execution = {
            finalText: "",
            errorMessage: nativeOutcome.error.message,
          };
          produced = [];
        } else {
          const native = nativeOutcome.value;
          let readinessError: Error | undefined;
          if (!native.error && claudeToolMcpHost) {
            readinessError = yield* Effect.promise(async () => {
              try {
                await claudeToolMcpHost!.waitForClientReady(undefined, 1_000);
                return undefined;
              } catch (error) {
                return asError(error);
              }
            });
          }
          llmCalls = native.usage.llmCalls;
          inputTokens = native.usage.inputTokens;
          outputTokens = native.usage.outputTokens;
          execution = {
            finalText: native.finalText.trim(),
            ...(native.error || readinessError
              ? { errorMessage: native.error ?? readinessError!.message }
              : {}),
          };
          produced = native.messages;
          nativeStateCheckpoint = native.nativeStateCheckpoint;
        }
      } else {
        const model = yield* Effect.tryPromise({
          try: () =>
            createCloudRelayModel({
              gatewayOrigin: modelGateway.origin,
              capability: modelGateway.capability,
              agentType: "general",
              execution: input.execution,
            }),
          catch: asError,
        });
        const agent = new Agent({
          initialState: {
            systemPrompt: cloudSystemPrompt,
            model,
            thinkingLevel: resolveCloudThinkingLevel(
              model,
              input.execution.reasoningEffort,
            ),
            tools,
            messages: history,
          },
          sessionId: input.threadId,
          getApiKey: () => modelGateway.capability,
          toolExecution: "sequential",
          toolInactivityTimeoutMs: 5 * 60_000,
          // Same division of labor as the desktop runtime and the orchestrator
          // DO: re-prune before every provider call, and let the outer ladder
          // own empty completions and the physical-request ceiling.
          transformContext: buildDefaultTransformContext({ model }),
          degenerateResponseRetries: 0,
          providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
        });
        const unsubscribe = agent.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            llmCalls += 1;
            const usage = (
              event.message as {
                usage?: {
                  input?: number;
                  output?: number;
                  inputTokens?: number;
                  outputTokens?: number;
                };
              }
            ).usage;
            inputTokens += usage?.inputTokens ?? usage?.input ?? 0;
            outputTokens += usage?.outputTokens ?? usage?.output ?? 0;
            const text = extractAssistantText(event.message).trim();
            if (text)
              emitEvent("assistant_message", { text: text.slice(0, 8_000) });
          }
          if (event.type === "tool_execution_start") {
            emitEvent("tool_call", {
              name: event.toolName,
              args: JSON.stringify(event.args ?? {}).slice(0, 1_000),
            });
          }
        });

        // A resume tool result belongs to this new physical turn even though
        // it must already be present when Agent.continue() makes its provider
        // request.
        const before =
          agent.state.messages.length - (browserResumeMessage ? 1 : 0);
        // The desktop runtime's transient ladder: a retryable provider or
        // transport failure resumes the same in-memory context instead of
        // failing the whole turn. The DO's watchdog still bounds the turn; a
        // full ladder adds at most ~10s of backoff.
        const runOutcome = yield* Effect.promise(async () => {
          try {
            return {
              ok: true as const,
              value: await executeAgentRunWithRetry({
                state: { attemptsUsed: 0, retriesUsed: 0 },
                initialResume: Boolean(browserResumeMessage),
                execute: async (resume) => {
                  if (resume) {
                    await agent.continue();
                  } else {
                    await agent.prompt(input.prompt);
                  }
                  const completion = getAgentCompletion(agent);
                  return {
                    ...completion,
                    finalText: completion.finalText.trim(),
                  };
                },
                prepareResume: (reason, classification) => {
                  const prepared = prepareTransientResumeTail(
                    agent.state.messages,
                    classification,
                  );
                  if (prepared) {
                    console.error(
                      `transient run retry (${classification.category}): ${reason}`,
                    );
                  }
                  return prepared;
                },
              }),
            };
          } catch (error) {
            return {
              ok: false as const,
              error: isAgentToolSuspendedError(error) ? error : asError(error),
            };
          } finally {
            unsubscribe();
          }
        });
        if (!runOutcome.ok && isAgentToolSuspendedError(runOutcome.error)) {
          suspendedError = runOutcome.error;
          execution = { finalText: "" };
        } else {
          execution = runOutcome.ok
            ? runOutcome.value
            : { finalText: "", errorMessage: runOutcome.error.message };
        }
        // Errored assistant messages have empty content; one empty assistant
        // row poisons every future Anthropic request for this thread.
        produced = agent.state.messages.slice(before).filter((message) => {
          const record = message as { role?: string; content?: unknown };
          return !(
            record.role === "assistant" &&
            Array.isArray(record.content) &&
            record.content.length === 0
          );
        });
      }
      if (produced.length === 0) {
        if (suspendedError) {
          throw new Error(
            "Suspended cloud browser turn did not retain its assistant tool call.",
          );
        }
        // A tool-only/error path can still mutate the workspace before an
        // engine emits a transcript row. Give that physical turn an explicit
        // canonical row instead of silently dropping its durable state or
        // trying to replace a checkpoint under an unchanged cursor.
        const timestamp = Date.now();
        produced = [
          {
            role: "user",
            content: [{ type: "text", text: input.prompt }],
            timestamp,
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  execution.finalText ||
                  execution.errorMessage ||
                  "The agent finished without a report.",
              },
            ],
            api: "stella-cloud",
            provider: input.execution.provider,
            model: input.execution.model,
            usage: {
              input: inputTokens,
              output: outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: inputTokens + outputTokens,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: execution.errorMessage ? "error" : "stop",
            ...(execution.errorMessage
              ? { errorMessage: execution.errorMessage }
              : {}),
            timestamp,
          },
        ] as AgentMessage[];
      }
      const eventFailure = yield* Effect.promise(async () => {
        try {
          await eventChain;
          return undefined;
        } catch (error) {
          return asError(error);
        }
      });
      if (eventFailure && !execution.errorMessage) {
        execution.errorMessage = eventFailure.message;
      }

      // Delivery is best-effort: the bytes are already in the checkpointed
      // workspace, so a failed registration costs visibility, not work — but
      // it has to be visible in the report rather than silently dropped.
      const outputs = yield* Effect.promise(
        async (): Promise<{
          files: ProducedFileReport[];
          stored: Set<string>;
          notice: string;
        }> => {
          // The file list is the reply's own: markdown links in the turn's
          // final assistant text, the same contract the local lane uses. Each
          // linked path is still an agent-chosen string; `collectProducedFiles`
          // authorizes every one beneath the workspace boundary.
          const collected = await collectProducedFiles({
            workspaceRoot: WORLD_DRIVE_ROOT,
            linked: extractLocalFileLinkPaths(execution.finalText),
            gitAware: false,
            drivePrefix: "",
            processIdentity: {
              ...CLOUD_TOOL_PROCESS_IDENTITY,
              home: toolHome,
            },
          }).catch(() => null);
          const files = collected?.files ?? [];
          const omitted = collected?.omitted ?? [];
          // The system prompt promises the user that workspace files are
          // delivered, so a cap that holds some back has to say so rather than
          // let the agent report success over a shorter list.
          const truncated =
            omitted.length > 0
              ? `\n\nHeads up: only ${files.length} of the files from this turn were delivered. ${omitted.length} more (${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? ", …" : ""}) are in the workspace but were not.`
              : "";
          if (files.length === 0) {
            return { files, stored: new Set<string>(), notice: truncated };
          }
          try {
            const delivery = await reportProducedFiles({
              turnId: input.turnId,
              files,
              known: driveSync.known,
              uploads: driveSync.uploads,
              post: postJson,
            });
            // The drive's answer is part of the turn's report: a file saved
            // under a different name to spare the user's own upload, or one
            // the quota turned away, is something the agent's summary would
            // otherwise claim it delivered.
            const renamedBy = new Map(
              delivery.renamed.map((entry) => [entry.from, entry.to]),
            );
            const refused = new Set(
              delivery.skipped.map((entry) => entry.path),
            );
            const notes = [
              ...delivery.renamed.map((entry) => entry.reason),
              ...delivery.skipped.map((entry) => entry.reason),
              ...delivery.replaced.map((entry) => entry.reason),
            ];
            return {
              files: files
                .filter((file) => !refused.has(file.path))
                .map((file) => {
                  const to = renamedBy.get(file.path);
                  return to
                    ? {
                        ...file,
                        path: to,
                        name: to.slice(to.lastIndexOf("/") + 1),
                      }
                    : file;
                }),
              stored: delivery.stored,
              notice:
                notes.length > 0
                  ? `${truncated}\n\n${notes.join(" ")}`
                  : truncated,
            };
          } catch (failure) {
            console.error(
              `drive file report failed: ${asError(failure).message}`,
            );
            return {
              files: [],
              stored: new Set<string>(),
              notice: `${truncated}\n\nHeads up: delivering the files from this turn (${files
                .map((file) => file.path)
                .join(", ")}) failed. They are still in the workspace.`,
            };
          }
        },
      );
      if (outputs.files.length > 0) {
        emitEvent("output_files", {
          // `stored` is the route's answer, not ours: a file too large to send
          // inline is registered but its bytes stay in the workspace, so the
          // chat surface must not offer it as a download.
          files: outputs.files.map((file) => ({
            ...toDriveFile(file),
            stored: outputs.stored.has(file.path),
          })),
        });
        const outputEventFailure = yield* Effect.promise(async () => {
          try {
            await eventChain;
            return undefined;
          } catch (error) {
            return asError(error);
          }
        });
        if (outputEventFailure && !execution.errorMessage) {
          execution.errorMessage = outputEventFailure.message;
        }
      }

      const historyCursor = nativeHistoryCursorFromMessages(
        input.turnId,
        produced,
      );
      const transcriptRows = produced.map((message, ordinal) => ({
        ordinal,
        role: (message as { role: string }).role,
        payloadJson: JSON.stringify(message),
      }));

      // Freeze every model-controlled writer before the archive is built.
      // A normal cloud Code turn checkpoints its Browser Run profile before
      // the sandbox and its turn authority disappear. A suspended login/device
      // handoff is still under human control and must receive no automation
      // command here; the next physical turn resumes it from Convex instead.
      const browserTurnFailure = yield* Effect.promise(async () => {
        try {
          await checkpointCloudBrowserTurnBeforeTeardown({
            codeToolCallIds: cloudCodeToolCallIds,
            suspended: Boolean(suspendedError),
            endBrowserTurn: (toolCallId, behavior) =>
              toolHost.endBrowserTurn(toolCallId, behavior),
          });
          return undefined;
        } catch (error) {
          return asError(error);
        }
      });

      // Freeze every remaining model-controlled writer before the archive is built.
      // ToolHost shutdown is joined and idempotent; closing the Claude MCP
      // listener also prevents a surviving descendant from starting another
      // tool call after the workspace snapshot begins.
      const shutdownFailures = yield* Effect.promise(async () => {
        const results = await Promise.allSettled([
          toolHost.shutdown(),
          claudeToolMcpHost?.close() ?? Promise.resolve(),
        ]);
        return [
          ...(browserTurnFailure ? [browserTurnFailure] : []),
          ...results.flatMap((result) =>
            result.status === "rejected" ? [asError(result.reason)] : [],
          ),
        ];
      });

      if (forceBuilderFallback || shutdownFailures.length > 0) {
        const shutdownReason = shutdownFailures[0]?.message;
        const error =
          execution.errorMessage ||
          shutdownReason ||
          "The executor could not prove that every workspace writer stopped.";
        return createBuilderFallbackAgentTurnResult({
          finalText: execution.finalText,
          notice: outputs.notice,
          error,
          usage: { inputTokens, outputTokens, llmCalls },
          historyCursor,
          messages: transcriptRows,
          ...(nativeStateCheckpoint
            ? { nativeCheckpoint: nativeStateCheckpoint }
            : {}),
        });
      }

      {
        // Workspace and optional native bytes are durably staged together
        // before the transcript can make this exact cursor authoritative. An
        // exact broker replay returns the already committed pair after a lost
        // response; it never uploads a second archive.
        const checkpointStarted = performance.now();
        const checkpointAttempt = yield* Effect.promise(async () => {
          try {
            return {
              receipt: await commitTurnStateBeforeTranscript({
              historyCursor,
              ...(nativeStateCheckpoint
                ? { nativeCheckpoint: nativeStateCheckpoint }
                : {}),
              ...(suspendedError
                ? { suspensionTranscript: transcriptRows }
                : {}),
              broker,
              appendTranscript: async () => {
                // One mutation owns the complete produced transcript: a
                // committed prefix would poison the next continuation's
                // canonical state.
                let response = await postJson("/api/cloud/messages", {
                  conversationId: input.threadId,
                  turnId: input.turnId,
                  messages: transcriptRows,
                });
                if (!response.ok) {
                  response = await postJson("/api/cloud/messages", {
                    conversationId: input.threadId,
                    turnId: input.turnId,
                    messages: transcriptRows,
                  });
                }
                if (!response.ok) {
                  throw new Error(
                    `Thread transcript persist failed (${response.status}).`,
                  );
                }
              },
              }),
            } as const;
          } catch (error) {
            return { error: asError(error) } as const;
          }
        });
        checkpointMs = Math.round(performance.now() - checkpointStarted);
        if ("error" in checkpointAttempt) {
          // A lost checkpoint/transcript response does not erase the model's
          // completed report. Hand the exact transcript to Builder, which
          // quiesces the process tree and resumes the idempotent journal.
          return createBuilderFallbackAgentTurnResult({
            finalText: execution.finalText,
            notice: outputs.notice,
            ...(execution.errorMessage
              ? { error: execution.errorMessage }
              : {}),
            usage: { inputTokens, outputTokens, llmCalls },
            historyCursor,
            messages: transcriptRows,
            ...(nativeStateCheckpoint
              ? { nativeCheckpoint: nativeStateCheckpoint }
              : {}),
          });
        }
        turnStateCheckpoint = checkpointAttempt.receipt;
      }

      const finalText = execution.finalText;
      const error = execution.errorMessage;
      if (suspendedError) {
        return createSuspendedAgentTurnResult({
          error: suspendedError,
          usage: { inputTokens, outputTokens, llmCalls },
          checkpointMs,
          turnStateCheckpoint,
        });
      }
      return {
        ok: !error,
        finalText:
          `${finalText || (error ? "" : "The agent finished without a report.")}${outputs.notice}`.trim(),
        ...(error ? { error } : {}),
        usage: { inputTokens, outputTokens, llmCalls },
        checkpointMs,
        ...(turnStateCheckpoint ? { turnStateCheckpoint } : {}),
      } satisfies AgentTurnResult;
    }),
  );
