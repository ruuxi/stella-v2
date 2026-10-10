/**
 * The real cloud agent turn of a Claude agent: Claude Code's CLI running
 * headless in the sandbox as the spawned general agent, with Stella's tool
 * host behind it. Agents on Stella's models or the owner's ChatGPT plan run
 * on pi in their conversation instead.
 *
 * The BuildSession DO restores the workspace before invoking this and
 * checkpoints it after; this module only runs the turn. Events and
 * transcript writes go through the short-lived Builder broker capability;
 * no reusable turn token ever enters this process. The final line on
 * stdout is the structured report the DO parses.
 */

import type { CloudTurnAttemptPaths } from "@stella/contracts/cloud-turn-attempt";
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
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  parseCloudAgentSystemPrompt,
  type CloudCliTurnRoleInput,
} from "@stella/contracts/cloud-orchestrator-cli";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";
import type { ToolContext } from "@stella/runtime/kernel/tools/host.js";
import {
  createClaudeCodeToolMcpHost,
  type ClaudeCodeToolMcpHost,
} from "@stella/runtime/kernel/integrations/claude-code-tool-mcp-host.js";
import { buildClaudeCodeNativeToolRuntimePrompt } from "@stella/runtime/kernel/integrations/claude-code-session-runtime.js";
import {
  type ToolMetadata,
  type ToolResult,
  type ToolUpdateCallback,
} from "@stella/runtime/kernel/tools/types.js";
import { openAgentInbox } from "./agent-inbox.js";
import { createCloudUserAskHost } from "./cloud-user-ask.js";
import {
  emptyDriveSync,
  materializeDriveFiles,
  type DriveSyncResult,
} from "./drive-sync.js";
import { toDriveFile, type ProducedFileReport } from "./produced-files.js";
import { snapshotDriveTree, writeBackDrive } from "./drive-writeback.js";
import {
  buildGeneralAgentPrompt,
  type GeneralAgentPromptSkills,
} from "./general-agent-prompt.js";
import { cloudGeneralToolNames } from "./cloud-general-tools.js";
import {
  toolStateDir,
  worldDriveWorkspace,
  WORLD_ROOT,
} from "./workspace-paths.js";
import {
  pullWorldProjection,
  pushWorldProjection,
  type WorldSyncAccess,
} from "./world-sync.js";
import {
  cloudAgentProgressFromStream,
  cloudClaudeRoleProfile,
  nativeHistoryCursorFromMessages,
  nativeHistoryCursorFromRows,
  parseCloudClaudeAccountInput,
  runNativeAgentTurn,
  type CloudClaudeAccountInput,
} from "./native-agent-turn.js";
import { runOrchestratorTurn } from "./orchestrator-turn.js";
import {
  parseAuthoritativeAgentHistory,
  type AgentHistoryRow,
} from "./agent-history.js";
import {
  type TurnBrokerInput,
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
  CLOUD_TOOL_PROCESS_IDENTITY,
  proveStrictCloudProcessIsolation,
} from "./cloud-process-isolation.js";
import { CLOUD_TOOL_HOME } from "@stella/contracts/cloud-tool-home";
import { cloudAgentToolContext } from "./cloud-tool-context.js";

export { CLOUD_TOOL_PROCESS_IDENTITY } from "./cloud-process-isolation.js";

/**
 * turn-input.json. `role` (from the shared contract) says which loop runs:
 * an orchestrator turn also carries the DO's system prompt and tool catalog.
 */
export type AgentTurnInput = CloudCliTurnRoleInput & {
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
  rebuildNativeSession?: boolean;
  /** One-shot pointer to the Builder-owned, short-lived turn broker. */
  turnBroker: TurnBrokerInput;
  /** Short-lived capability for exporting and pushing this world's projection. */
  world: WorldSyncAccess;
  /**
   * Which of the owner's container Claude Code logins the CLI runs on (a
   * directory key and the account's email, never a credential).
   */
  claudeAccount?: CloudClaudeAccountInput;
  /** Prior thread transcript rows, oldest first (send_message continuations). */
  history?: AgentHistoryRow[];
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
};

export type AgentTurnResult = AgentTurnTerminalResult;

export { cloudGeneralToolNames };

export const createBuilderFallbackAgentTurnResult = (args: {
  finalText: string;
  notice?: string;
  error?: string;
  usage: AgentTurnTerminalResult["usage"];
  historyCursor: string;
  messages: NonNullable<AgentTurnTerminalResult["builderFallback"]>["messages"];
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
      } else if (
        details.uid === CLOUD_TOOL_PROCESS_IDENTITY.uid &&
        details.gid === CLOUD_TOOL_PROCESS_IDENTITY.gid
      ) {
        // A world materialized from its export (or made by the worker shell)
        // carries 0755 directories; the tool account's own state directory
        // is tightened rather than refused. Ownership is still checked below.
        await handle.chmod(0o700);
      }
    } finally {
      await handle.close();
    }
    await assertToolOwnedDirectory(target, 0o700);
  };
  // The drive state dir lives under the world's drive directory, which an
  // empty world does not carry yet; create that parent for the tool account.
  if (args.driveStateDir) {
    const driveRoot = path.dirname(args.driveStateDir);
    try {
      await mkdir(driveRoot, { mode: 0o750 });
      await chown(
        driveRoot,
        CLOUD_TOOL_PROCESS_IDENTITY.uid,
        CLOUD_TOOL_PROCESS_IDENTITY.gid,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
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
  broker: Pick<TurnCredentialBrokerClient, "commitTurnStateCheckpoint">;
  appendTranscript: () => Promise<void>;
}): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  const receipt = await args.broker.commitTurnStateCheckpoint({
    historyCursor: args.historyCursor,
    ...(args.nativeCheckpoint
      ? { nativeCheckpoint: args.nativeCheckpoint }
      : {}),
  });
  await args.appendTranscript();
  return receipt;
};

/**
 * The office CLI ships inside the image next to the runtime. The tool host
 * turns this into `STELLA_OFFICE_BIN`, so document work runs through `Bash`
 * rather than a dedicated tool. Both cloud tool hosts (this executor and the
 * attached daemon) configure it the same way, because both render the same
 * `general.md`, which tells the agent `stella-office` is there.
 */
export const resolveOfficeBinPath = (): string | undefined => {
  const candidate =
    process.env.STELLA_OFFICE_BIN?.trim() ||
    fileURLToPath(
      new URL("../../stella-office/bin/stella-office.js", import.meta.url),
    );
  return existsSync(candidate) ? candidate : undefined;
};

/**
 * The container path's prompt: `body` is the `general.md` render the worker
 * sent for this engine's tools, and the world is on disk with the drive
 * synchronized before the model ran, so it appends the materialized variant.
 * Kept as a named export because prompt tests assert on the sentences a given
 * `DriveSyncResult` produces.
 */
export const CLOUD_GENERAL_PROMPT = (options: {
  body: string;
  threadId?: string;
  drive?: DriveSyncResult;
  skills?: GeneralAgentPromptSkills;
}): string =>
  buildGeneralAgentPrompt(options.body, {
    workspace: "materialized",
    ...(options.threadId ? { threadId: options.threadId } : {}),
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

/**
 * The turn input sits in this attempt's root-only directory (see
 * cloud-turn-attempt.ts). The executor still consumes it and unlinks it at
 * once: the thread history, capabilities and broker handoff it carries are
 * executor inputs, never the agent's context.
 */
export const runAgentTurn = (
  attempt: CloudTurnAttemptPaths,
): Effect.Effect<AgentTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: async () => {
          const raw = await readFile(attempt.input, "utf8");
          await rm(attempt.input, { force: true });
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
      // This loop builds an agent's own prompt and tools; an orchestrator
      // turn runs the DO's, in its own executor mode.
      if (input.role === "orchestrator") {
        return yield* Effect.promise(() =>
          runOrchestratorTurn({ input, broker }),
        );
      }
      const promptBody = parseCloudAgentSystemPrompt(input.systemPrompt);
      if (!promptBody) {
        return {
          ok: false,
          finalText: "",
          error:
            "Stella lost this agent's instructions before it could run. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      // Only Claude agents run in a container; the rest are pi agents.
      if (input.execution.engine !== "anthropic") {
        return {
          ok: false,
          finalText: "",
          error:
            "This agent runs in its conversation, not in a container. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      const nativeExecution = input.execution;
      const claudeAccount = parseCloudClaudeAccountInput(input.claudeAccount);
      if (!claudeAccount) {
        return {
          ok: false,
          finalText: "",
          error:
            "Stella couldn't validate this agent's managed model access. Try again.",
          usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
          checkpointPolicy: "preserve_prior",
        };
      }
      try {
        parseAuthoritativeAgentHistory(input.history ?? []);
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
      const driveWorkspace = worldDriveWorkspace(workspaceRoot);
      const toolHome = CLOUD_TOOL_HOME;
      yield* Effect.tryPromise({
        try: () =>
          pullWorldProjection({ root: workspaceRoot, access: input.world }),
        catch: asError,
      });
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

      const userAsks = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createCloudUserAskHost({
            post: postJson,
            turnId: input.turnId,
            conversationId: input.conversationId,
          }),
        ),
        (host) =>
          Effect.promise(async () => {
            await host.cancelOpenAsks(
              "This agent stopped before you answered, so the question was withdrawn.",
            );
          }),
      );

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
      // What the drive copy looks like before any agent process exists: the
      // write-back saves what changes from here. An unreadable tree counts
      // every file as changed, and the ledger still spares the unchanged.
      const driveBefore = yield* Effect.promise(() =>
        snapshotDriveTree(driveWorkspace.root).catch(() => new Map()),
      );

      const officeBinPath = resolveOfficeBinPath();
      const cloudSystemPrompt = CLOUD_GENERAL_PROMPT({
        body: promptBody,
        threadId: input.threadId,
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
            ...(officeBinPath ? { stellaOfficeBinPath: officeBinPath } : {}),
            askUser: userAsks.handlers.askUser,
            requestSecureInput: userAsks.handlers.requestSecureInput,
            useSecureValue: userAsks.handlers.useSecureValue,
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

      const context: ToolContext = cloudAgentToolContext({
        threadId: input.threadId,
        workspaceRoot,
        workspaceStateDir,
        toolHome,
        // `code` reaches the turn's other tools as `tools.<name>`, as on the
        // desktop.
        allowedToolNames: cloudGeneralToolNames(),
      });

      const catalog = [
        ...toolHost.getToolCatalog("general", {}),
        ...toolHost.getToolCatalog("general", {
          agentEngine: "claude_code_local",
        }),
      ];
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const cloudToolMetadata = [
        ...cloudGeneralToolNames()
          .map((name) => byName.get(name))
          .filter((tool): tool is ToolMetadata => Boolean(tool)),
      ];
      const executeCloudTool = async (
        toolCallId: string,
        name: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: ToolUpdateCallback,
      ): Promise<ToolResult> => {
        const result = await toolHost.executeTool(
          name,
          params,
          { ...context, requestId: toolCallId },
          signal,
          onUpdate,
        );
        return result;
      };
      const claudeToolMcpHost: ClaudeCodeToolMcpHost =
        yield* Effect.acquireRelease(
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

      // Messages sent to this agent while it works. It stops taking them
      // when it finishes; a message that lands later is refused, never lost.
      const inbox = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => openAgentInbox(attempt.inbox),
          catch: asError,
        }),
        (opened) => Effect.promise(() => opened.close().catch(() => [])),
      );

      let llmCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let checkpointMs = 0;
      let turnStateCheckpoint: TurnBrokerTurnStateCheckpointReceipt | undefined;
      let execution: { finalText: string; errorMessage?: string };
      let produced: AgentMessage[];
      let forceBuilderFallback = false;
      let nativeStateCheckpoint:
        | Awaited<
            ReturnType<typeof runNativeAgentTurn>
          >["nativeStateCheckpoint"]
        | undefined;
      const nativeOutcome = yield* Effect.promise(async () => {
        try {
          return {
            ok: true as const,
            value: await runNativeAgentTurn({
              profile: cloudClaudeRoleProfile({
                role: "agent",
                threadId: input.threadId,
                conversationId: input.conversationId,
              }),
              prompt: input.prompt,
              // Built-ins are off (`--tools ""`), the same as the cloud
              // orchestrator's Claude Code turn, so it gets the same note.
              systemPrompt:
                buildClaudeCodeNativeToolRuntimePrompt(cloudSystemPrompt),
              execution: nativeExecution,
              claudeAccount,
              threadId: input.threadId,
              turnId: input.turnId,
              authoritativeHistoryCursor: nativeHistoryCursorFromRows(
                input.history ?? [],
              ),
              stateIntegrityKey: input.nativeStateIntegrityKey,
              ...(input.rebuildNativeSession === true
                ? { recoveryHistory: input.history ?? [] }
                : {}),
              claudeMcpServerConfig: claudeToolMcpHost.mcpServerConfig,
              onStreamEvent: cloudAgentProgressFromStream(emitEvent),
              inbox,
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
        if (!native.error) {
          readinessError = yield* Effect.promise(async () => {
            try {
              await claudeToolMcpHost.waitForClientReady(undefined, 1_000);
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
      // The agent has stopped; nothing more is accepted for it. (A finished
      // run already closed it; one that failed takes no more messages.)
      yield* Effect.promise(() => inbox.close().catch(() => []));
      const executorBoundaryPushFailure = yield* Effect.promise(async () => {
        try {
          await pushWorldProjection({
            root: workspaceRoot,
            access: input.world,
          });
          return undefined;
        } catch (error) {
          return asError(error);
        }
      });
      if (executorBoundaryPushFailure && !execution.errorMessage) {
        execution.errorMessage = executorBoundaryPushFailure.message;
      }
      if (produced.length === 0) {
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

      // The drive copy is not part of the world, so this is the only way the
      // turn's drive work survives the sandbox: everything it created,
      // changed or deleted under drive/ is written back to the drive now.
      // Best-effort per file, and every file it could not save is named in
      // the report rather than silently dropped.
      const outputs = yield* Effect.promise(
        async (): Promise<{
          files: ProducedFileReport[];
          stored: Set<string>;
          notice: string;
        }> => {
          try {
            // The card is the reply's own: markdown links in the turn's final
            // assistant text, the same contract the local lane uses. Each
            // linked path is still an agent-chosen string; the write-back
            // reads every one beneath the descriptor boundary.
            const writeBack = await writeBackDrive({
              turnId: input.turnId,
              driveRoot: driveWorkspace.root,
              stateDir: driveWorkspace.stateDir,
              identity: { ...CLOUD_TOOL_PROCESS_IDENTITY, home: workspaceRoot },
              sync: driveSync,
              before: driveBefore,
              linked: extractLocalFileLinkPaths(execution.finalText),
              post: postJson,
            });
            return {
              files: writeBack.files,
              stored: new Set(writeBack.files.map((file) => file.path)),
              notice: writeBack.notice,
            };
          } catch (failure) {
            console.error(
              `drive write-back failed: ${asError(failure).message}`,
            );
            return {
              files: [],
              stored: new Set<string>(),
              notice:
                "\n\nHeads up: saving this turn's drive changes failed, so they are only in this sandbox.",
            };
          }
        },
      );
      if (outputs.files.length > 0) {
        emitEvent("output_files", {
          // Every file on the card is in the drive with its bytes, which is
          // what lets the chat surface offer it as a download.
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
      // ToolHost shutdown is joined and idempotent; closing the Claude MCP
      // listener also prevents a surviving descendant from starting another
      // tool call after the workspace snapshot begins.
      const shutdownFailures = yield* Effect.promise(async () => {
        const results = await Promise.allSettled([
          toolHost.shutdown(),
          claudeToolMcpHost?.close() ?? Promise.resolve(),
          pushWorldProjection({ root: workspaceRoot, access: input.world }),
        ]);
        return results.flatMap((result) =>
          result.status === "rejected" ? [asError(result.reason)] : [],
        );
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
