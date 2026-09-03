/**
 * Tool host factory.
 *
 * Builds the tool execution environment for a Stella session.
 *
 * Every model-facing tool lives as a contained `ToolDefinition` under
 * `runtime/kernel/tools/defs/`. `buildBuiltinTools()` returns the full set;
 * the host indexes them by name into a single Map that drives both:
 *
 *   - the catalog the model sees (`getToolCatalog`)
 *   - the handler dispatcher (`executeTool`)
 *
 * The legacy companion handlers (Bash / ShellStatus / KillShell, plus
 * extension-injected ToolDefinitions) sit alongside in the same map.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { AGENT_IDS, getAgentDefinition } from "@stella/contracts/agent-runtime";

import type { Api, Model } from "../../ai/types.js";
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  type FileEditAgentEngine,
  getFileEditToolFamily,
  WRITE_TOOL_NAME,
} from "./file-edit-policy.js";
import {
  TOOL_RESULT_AUTHORIZED_IMAGES,
  type ToolContext,
  type ToolHandler,
  type ToolHandlerExtras,
  type ToolMetadata,
  type ToolHostOptions,
  type ToolResult,
} from "./types.js";

import { log, logError, recoverStaleSecretFiles } from "./utils.js";
import {
  createShellState,
  listRunningShellSessionsOwnedBy,
  readShellExitSnapshot,
  shutdownManagedShells,
  waitForShellExit,
  watchShellExit,
  type ShellSessionAccess,
  type ShellState,
} from "./shell.js";
import { createStateContext, type StateContext } from "./state.js";
import {
  createShellToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { buildBuiltinTools } from "./defs/index.js";
import { AGENT_ORCHESTRATION_TOOL_NAMES } from "./defs/task.js";
import { isAgentToolSuspendedError } from "../agent-core/suspension.js";
import type { ToolDefinition as BuiltinToolDefinition } from "./types.js";
import { sanitizeToolError, sanitizeToolResult } from "./safety.js";
import { describeToolCatalogEntry, searchToolCatalog } from "./code-catalog.js";
import {
  LEGACY_NODE_REPL_TOOL_NAME,
  toolRequiresExplicitApproval,
} from "./code-tool.js";
import {
  NODE_REPL_EXCLUDED_TOOL_NAMES,
  NodeReplKernelRegistry,
} from "../computer-use/kernel.js";
import {
  createMacComputerUseSession,
  shutdownMacStellaComputerSession,
} from "../computer-use/stella-computer-executor.js";
import { createWindowsComputerUseSession } from "../computer-use/windows-session.js";
import { createComputerUseSession } from "../computer-use/session.js";
import { cleanupWindowsStellaComputerSessionDaemon } from "../cli/stella-computer-windows.js";
import { createReplConnectClient } from "../connectors/connect-service.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

const MAX_INLINE_TOOL_DESCRIPTION_CHARS = 256_000;
const TOOL_DESCRIPTION_CHUNK_CHARS = 192_000;

export const createBrowserOnlyComputerUseSession = () =>
  createComputerUseSession(async () => {
    throw new Error(
      "Typed Computer Use is not available in browser-only cloud execution.",
    );
  });

const copyCallableMetadata = (
  tool: BuiltinToolDefinition | ToolDefinition,
): ToolMetadata => ({
  name: tool.name,
  ...(tool.label ? { label: tool.label } : {}),
  ...(tool.workingText ? { workingText: tool.workingText } : {}),
  description: tool.description,
  parameters: tool.parameters,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  ...(tool.resultSchema ? { resultSchema: tool.resultSchema } : {}),
  ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
  ...(tool.sideEffects !== undefined ? { sideEffects: tool.sideEffects } : {}),
  ...(tool.reversible !== undefined ? { reversible: tool.reversible } : {}),
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
  ...(tool.demoted ? { demoted: tool.demoted } : {}),
  ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
});

/**
 * `$`-prefixed tool names are reserved for Node REPL intrinsics
 * (`tools.$search`, `tools.$describe`). Built-ins violating this fail loudly
 * at startup; extension tools are skipped with an error log so a bad extension
 * cannot shadow the intrinsic surface.
 */
const isReservedToolName = (name: string): boolean =>
  name.startsWith("$") || name === LEGACY_NODE_REPL_TOOL_NAME;

const reservedToolNameReason = (name: string): string =>
  name === LEGACY_NODE_REPL_TOOL_NAME
    ? '"node_repl" is reserved for legacy transcript compatibility; extensions must not advertise it because the public tool is "code".'
    : '"$" names belong to code-runtime intrinsics like tools.$search and tools.$describe.';

/**
 * Defense-in-depth gate consulted both at catalog filter time and at
 * executeTool time. A tool with no `agentTypes` is unrestricted; a tool
 * with `agentTypes` must list the requesting agent or it's denied.
 */
const isAgentAllowedForTool = (
  tool: { agentTypes?: readonly string[] },
  agentType: string | undefined,
): boolean => {
  if (!tool.agentTypes || tool.agentTypes.length === 0) return true;
  if (!agentType) return false;
  return tool.agentTypes.includes(agentType);
};

/**
 * Second, ownership-based gate. A parent-owned agent (one spawned BY another
 * agent) runs with a top-level agent's toolset minus the orchestration
 * tools, so it cannot open a third level or steer a sibling thread. Applied
 * at catalog build time so the tools are simply absent from what the model
 * sees, and mirrored at executeTool time as defense in depth.
 */
const isOrchestrationToolWithheld = (
  toolName: string,
  parentOwned: boolean | undefined,
): boolean =>
  parentOwned === true && AGENT_ORCHESTRATION_TOOL_NAMES.includes(toolName);

/**
 * Tools that `tools.$search` may return for one calling context.
 *
 * Searchable MUST equal callable: every result must be invocable as
 * `tools.<name>` in the same REPL, so membership in the context's
 * `allowedToolNames` is required for demoted and normal tools alike —
 * wherever a demoted tool is legitimately reachable, the runtime adapter
 * (or the external-engine widening) has already added its name to the
 * union. A context that never widened (e.g. a surface without demoted
 * support) therefore gets no hit for it. The agent-type / ownership /
 * connector gates stay as defense in depth.
 *
 * Exported for tests.
 */
export const collectReplSearchableTools = (
  tools: Iterable<ToolMetadata>,
  context: ToolContext,
): ToolMetadata[] => {
  const allowedNames = new Set(context.allowedToolNames ?? []);
  const connectorProvider = context.connectorDeliveryTarget?.provider;
  const reachable: ToolMetadata[] = [];
  for (const tool of tools) {
    if (NODE_REPL_EXCLUDED_TOOL_NAMES.has(tool.name)) continue;
    if (!allowedNames.has(tool.name)) continue;
    if (toolRequiresExplicitApproval(tool.approval)) continue;
    if (!isAgentAllowedForTool(tool, context.agentType)) continue;
    if (
      isOrchestrationToolWithheld(tool.name, Boolean(context.parentAgentId))
    ) {
      continue;
    }
    const requiredProvider = tool.demoted?.requiredConnectorProvider;
    if (requiredProvider && requiredProvider !== connectorProvider) {
      continue;
    }
    reachable.push(tool);
  }
  return reachable;
};

export const createToolHost = ({
  stellaAppDir,
  recoverStaleSecrets = true,
  enableShellShims = true,
  allowCloudCode = false,
  browserSessionFactory,
  stellaDataDir,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaComputerCliPath,
  stellaMediaCliPath,
  stellaXApiCliPath,
  cliBridgeSocketPath,
  requestCredential,
  requestBrowserExtensionConnect,
  requestConnectorConnection,
  agentApi,
  validateSpawnModel,
  validateSpawnModelWithMetadata,
  captureSpawnModelConfig,
  resolveCloudExecutionSelection,
  scheduleApi,

  fashionApi,
  extensionTools,
  webSearch,
  getStellaSiteAuth,
  queryConvex,
  actionConvex,
  contextProvider,
}: ToolHostOptions) => {
  const stateRoot = stellaDataDir ?? stellaAppDir;
  const toolCatalog = new Map<string, ToolMetadata>();

  const shellState: ShellState = createShellState(stateRoot, {
    enableShellShims,
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    getStellaSiteAuth,
    cliBridgeSocketPath,
  });
  const stateContext: StateContext = createStateContext(
    stateRoot,
    agentApi,
    validateSpawnModel,
    validateSpawnModelWithMetadata,
    resolveCloudExecutionSelection,
    captureSpawnModelConfig,
  );
  let executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => Promise<ToolResult>;
  const nodeReplRegistry = new NodeReplKernelRegistry({
    browserBinPath: _stellaBrowserBinPath,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    sessionFactory: ({ sessionId, getSignal, timeoutMs }) => {
      if (process.platform === "win32") {
        return createWindowsComputerUseSession();
      }
      if (process.platform === "darwin") {
        return createMacComputerUseSession({
          sessionId,
          getSignal,
          commandTimeoutMs: timeoutMs,
          ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
        });
      }
      if (browserSessionFactory) {
        return createBrowserOnlyComputerUseSession();
      }
      // Keep the code-runtime session; throw only if a cell hits computer use.
      return createComputerUseSession(async () => {
        throw new Error(
          `Typed Computer Use is not available on ${process.platform}.`,
        );
      });
    },
    ...(browserSessionFactory ? { browserSessionFactory } : {}),
    disposeSession: async (sessionId) => {
      if (process.platform === "win32") {
        await cleanupWindowsStellaComputerSessionDaemon(sessionId);
      } else if (process.platform === "darwin") {
        shutdownMacStellaComputerSession(sessionId);
      }
    },
    executeTool: (toolName, args, context, signal, onUpdate) => {
      const metadata = toolCatalog.get(toolName);
      if (toolRequiresExplicitApproval(metadata?.approval)) {
        return Promise.resolve({
          error: `${toolName} requires explicit approval and cannot be invoked from code. Call it directly so the approval flow can run.`,
        });
      }
      return executeTool(toolName, args, context, signal, onUpdate);
    },
    // In-REPL `tools.$search` — runs host-side over the LIVE catalog so
    // connector/extension changes are visible immediately. Scope: exactly
    // the tools the calling context can invoke as `tools.<name>` in the
    // same REPL (see collectReplSearchableTools).
    searchTools: (query, context, limit) =>
      searchToolCatalog(
        collectReplSearchableTools(toolCatalog.values(), context),
        query,
        limit,
      ),
    describeTool: (name, context, cursor) => {
      const tool = collectReplSearchableTools(
        toolCatalog.values(),
        context,
      ).find((entry) => entry.name === name);
      if (!tool) {
        throw new Error(
          `Tool "${name}" is unknown or not available to describe in this context.`,
        );
      }

      const description = describeToolCatalogEntry(tool);
      const serialized = JSON.stringify(description);
      if (serialized.length <= MAX_INLINE_TOOL_DESCRIPTION_CHARS) {
        if (cursor !== undefined && cursor !== 0) {
          throw new Error(
            `Tool "${name}" does not have another description page.`,
          );
        }
        return description;
      }

      const start = cursor ?? 0;
      if (start >= serialized.length) {
        throw new Error(
          `Tool "${name}" description cursor is past the end of the document.`,
        );
      }
      let end = Math.min(
        serialized.length,
        start + TOOL_DESCRIPTION_CHUNK_CHARS,
      );
      if (
        end < serialized.length &&
        /[\uD800-\uDBFF]/.test(serialized.charAt(end - 1))
      ) {
        end -= 1;
      }
      const nextCursor = end < serialized.length ? end : undefined;
      return {
        name,
        complete: nextCursor === undefined,
        format: "lossless-json-chunks",
        totalChars: serialized.length,
        totalBytes: Buffer.byteLength(serialized, "utf8"),
        sha256: createHash("sha256").update(serialized).digest("hex"),
        cursor: start,
        chunk: serialized.slice(start, end),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        instruction:
          "Concatenate chunk values in cursor order, requesting each nextCursor with await tools.$describe(name, { cursor: nextCursor }), then JSON.parse the exact combined string. No schema fields were clipped.",
      };
    },
    // In-REPL `connect` client — the only agent surface for third-party
    // app integrations: catalog from the shared disk cache, action
    // execution through the CLI bridge → backend connector action broker.
    connectClient: createReplConnectClient({
      stellaAppDir: stateRoot,
      ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
      onBridgeUnreachable: (message) =>
        logError("code connect bridge unreachable", message),
    }),
  });

  if (recoverStaleSecrets) {
    void recoverStaleSecretFiles(stateRoot)
      .then((result) => {
        if (result.recovered > 0 || result.skipped > 0) {
          log("Recovered stale secret mounts", result);
        }
      })
      .catch((error) => {
        logError("Failed to recover stale secret mounts", error);
      });
  }

  // Legacy companion handlers (no schema in the catalog; reachable only by
  // direct executeTool calls from non-model code paths). These predate the
  // def-driven surface and stay until their callers are folded in.
  const handlers: Record<string, ToolHandler> = mergeToolHandlers(
    createShellToolHandlers(shellState),
  );

  // Built-in def-driven tools. Each `defs/<name>.ts` owns its own schema +
  // description + handler; they're the single source of truth for everything
  // the model sees.
  const builtinTools: BuiltinToolDefinition[] = buildBuiltinTools({
    stellaAppDir,
    stellaDataDir: stateRoot,
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    requestCredential,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    ...(requestConnectorConnection ? { requestConnectorConnection } : {}),
    agentApi,
    scheduleApi,

    fashionApi,
    extensionTools,
    webSearch,
    getStellaSiteAuth,
    queryConvex,
    actionConvex,
    contextProvider,
    shellState,
    stateContext,
    nodeReplRegistry,
    executeTool: (toolName, toolArgs, context, signal, onUpdate) =>
      executeTool(toolName, toolArgs, context, signal, onUpdate),
  });
  // Names of built-in tools live in a dedicated Set so the
  // extension-registration paths below can reject collisions instead
  // of silently overwriting handlers. Without this guard, an extension
  // that registers `web` or `exec_command` would replace the built-in
  // implementation; on F1 reload `unregisterExtensionTools` would then
  // delete the name entirely, leaving the runtime without a built-in
  // handler until the worker restarts.
  const builtinToolNames = new Set<string>();
  for (const tool of builtinTools) {
    if (isReservedToolName(tool.name)) {
      throw new Error(
        `Built-in tool "${tool.name}" uses a reserved name; ${reservedToolNameReason(tool.name)}`,
      );
    }
    toolCatalog.set(tool.name, copyCallableMetadata(tool));
    handlers[tool.name] = (args, context, extras) =>
      tool.execute(args, context, extras);
    builtinToolNames.add(tool.name);
  }

  // Filter out any startup-time `extensionTools` that collide with
  // built-ins (or use a reserved "$" name) before letting them touch the
  // catalog or handler map. Same policy as the runtime
  // `registerExtensionTools` below.
  const acceptedStartupExtensionTools = (extensionTools ?? []).filter(
    (tool) => {
      if (isReservedToolName(tool.name)) {
        logError(
          `Extension tool "${tool.name}" uses a reserved name; skipping registration. ${reservedToolNameReason(tool.name)}`,
        );
        return false;
      }
      if (builtinToolNames.has(tool.name)) {
        logError(
          `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
        );
        return false;
      }
      return true;
    },
  );
  registerExtensionToolHandlers(handlers, acceptedStartupExtensionTools);
  for (const tool of acceptedStartupExtensionTools) {
    toolCatalog.set(tool.name, copyCallableMetadata(tool));
  }

  executeTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => {
    const extras: ToolHandlerExtras = {
      ...(signal ? { signal } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    };
    log(`Executing tool: ${toolName}`, {
      args: toolArgs,
      context,
    });

    if (context.executionHost === "sandbox") {
      const workspaceRoot = context.toolWorkspaceRoot?.trim();
      if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
        throw new Error(
          "Sandbox tool execution requires an absolute workspace boundary.",
        );
      }
    }

    // Sandbox execution deliberately has no unrestricted in-process REPL. Keep
    // this at the dispatcher as well as the catalog so a replayed/hallucinated
    // legacy call cannot bypass the cloud adapter's allowlist.
    if (
      context.executionHost === "sandbox" &&
      (toolName === "code" || toolName === LEGACY_NODE_REPL_TOOL_NAME) &&
      !(allowCloudCode && browserSessionFactory)
    ) {
      return {
        error: `${toolName} is not available in sandbox execution.`,
      } satisfies ToolResult;
    }

    // Ownership gate, mirroring the catalog filter for the same
    // catalog-bypass reasons. A parent-owned agent never sees these tools, so
    // reaching here means a hallucinated or replayed call.
    if (isOrchestrationToolWithheld(toolName, Boolean(context.parentAgentId))) {
      return {
        error: `${toolName} is not available to a subagent. Complete the work in this task and report the result to the agent that started you.`,
      };
    }

    // Declarative agent-type gate. Mirrors the catalog filter so a tool that
    // declares `agentTypes` is rejected here too, defending against
    // hallucinated tool names and against any future catalog filter bypass.
    const catalogEntry = toolCatalog.get(toolName);
    if (
      catalogEntry &&
      !isAgentAllowedForTool(catalogEntry, context.agentType)
    ) {
      const allowed = catalogEntry.agentTypes ?? [];
      // Format the denial message to match historical per-agent wording.
      // Pre-migration the orchestrator helper read "only available to the
      // orchestrator" (lowercase agent id, no " agent" suffix) and the
      // Fashion helper read "only available to the Fashion agent." (capitalized
      // display name, " agent" suffix). Use the agent definition's `name`
      // field so the Fashion path doesn't degrade to "the fashion." (broken
      // grammar, leaked internal id) — but special-case the orchestrator so
      // existing UI/error consumers that depend on that exact substring
      // keep working.
      const formatAllowedAgent = (id: string): string => {
        if (id === AGENT_IDS.ORCHESTRATOR) return "the orchestrator";
        const def = getAgentDefinition(id);
        return def?.name ? `the ${def.name} agent` : `the ${id} agent`;
      };
      const formatted =
        allowed.length === 1
          ? formatAllowedAgent(allowed[0]!)
          : allowed.map(formatAllowedAgent).join(", ");
      return {
        error: `${toolName} is only available to ${formatted}.`,
      } satisfies ToolResult;
    }

    const handler = handlers[toolName];
    if (!handler) {
      const available = Object.keys(handlers);
      logError(`Unknown tool: ${toolName}. Available tools:`, available);
      return { error: `Unknown tool: ${toolName}` } satisfies ToolResult;
    }

    const startedAt = Date.now();
    try {
      const rawResult = await handler(toolArgs, context, extras);
      const authorizedImages = rawResult[TOOL_RESULT_AUTHORIZED_IMAGES];
      const result = sanitizeToolResult(rawResult);
      // `sanitizeToolResult` deliberately rebuilds enumerable JSON-shaped
      // data. Reattach only the symbol-keyed trusted bytes emitted by the
      // built-in handler so a descriptor-authorized image is not reopened by
      // pathname after an attacker-controlled race.
      if (authorizedImages) {
        Object.defineProperty(result, TOOL_RESULT_AUTHORIZED_IMAGES, {
          configurable: false,
          enumerable: false,
          value: authorizedImages,
          writable: false,
        });
      }
      const duration = Date.now() - startedAt;
      log(`Tool ${toolName} completed in ${duration}ms`, {
        hasResult: "result" in result,
        hasError: "error" in result,
        resultPreview: result.error
          ? result.error.slice(0, 500)
          : typeof result.result === "string"
            ? result.result.slice(0, 500)
            : "(non-string result)",
      });
      return result;
    } catch (error) {
      if (isAgentToolSuspendedError(error)) throw error;
      const duration = Date.now() - startedAt;
      logError(`Tool ${toolName} threw after ${duration}ms:`, error);
      return {
        error: sanitizeToolError(
          `Tool ${toolName} failed: ${(error as Error).message}`,
        ),
      };
    }
  };

  const killAllShells = () => {
    for (const shell of shellState.shells.values()) {
      if (shell.running) shell.kill();
    }
  };

  const killShellsByPort = (port: number) => {
    const portStr = String(port);
    for (const shell of shellState.shells.values()) {
      if (shell.running && shell.command.includes(portStr)) {
        shell.kill();
      }
    }
  };

  const killShell = async (sessionId: string) => {
    const shell = shellState.shells.get(sessionId);
    if (!shell) return;
    if (shell.running) {
      shell.kill();
    }
    // Event-driven join on the shell's exit latch (was a 25ms poll),
    // bounded at the same 1.5s so a TERM-ignoring child can't hang the
    // caller; the ladder's SIGKILL fires at 1s.
    await waitForShellExit(shell, 1_500);
  };

  /**
   * Idempotent, bounded, JOINED teardown (finalizer ordering: shells →
   * repl kernels). `shutdownManagedShells` starts every running shell's
   * TERM→1s→KILL ladder and then joins every exit latch in parallel under
   * a single 3s bound (comfortably past the ladder), so a wedged process
   * can never hang worker stop; anything still alive at the bound is
   * logged and left to the OS as the ladder's KILL already fired.
   * Conversation-scoped shells are deliberately worker-lifetime resources:
   * they die here, never earlier.
   */
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await shutdownManagedShells(shellState);
      await nodeReplRegistry.dispose();
    })();
    return shutdownPromise;
  };

  const getToolCatalog = (
    agentType?: string,
    options?: {
      model?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
      agentEngine?: FileEditAgentEngine;
      /** This thread was spawned by another agent; withhold orchestration tools. */
      parentOwned?: boolean;
    },
  ) => {
    const fileEditToolFamily = getFileEditToolFamily({
      agentType,
      model: options?.model,
      agentEngine: options?.agentEngine,
    });
    return Array.from(toolCatalog.values()).filter((tool) => {
      // A tool's `agentTypes` is the single audience gate: a tool with no
      // `agentTypes` is available to every agent, and the per-agent
      // frontmatter `tools:` allowlist (applied downstream in
      // tool-adapters) decides what each agent is actually offered.
      if (!isAgentAllowedForTool(tool, agentType)) return false;
      if (isOrchestrationToolWithheld(tool.name, options?.parentOwned)) {
        return false;
      }
      // Demoted tools stay in the catalog: the runtime adapter
      // (`createPiTools`) decides per turn whether they surface directly or
      // only through code's catalog. Voice and other realtime surfaces
      // filter them out explicitly.
      // Swap the file-edit tool family to the agent's engine: Claude Code
      // wants Write/Edit, Stella wants apply_patch.
      if (
        fileEditToolFamily === "write_edit" &&
        tool.name === APPLY_PATCH_TOOL_NAME
      ) {
        return false;
      }
      if (
        fileEditToolFamily === "apply_patch" &&
        (tool.name === WRITE_TOOL_NAME || tool.name === EDIT_TOOL_NAME)
      ) {
        return false;
      }
      return true;
    });
  };

  // Track tool names that came from user-installable extensions so a
  // reload (F1) can sweep them without touching built-in tools. The Set
  // is rebuilt on every successful `registerExtensionTools` call.
  const extensionToolNames = new Set<string>();

  return {
    executeTool,
    getToolCatalog,
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    /**
     * Session ids still running, optionally scoped to the sessions a run
     * touched. Shells outlive the run that started them by design (see the
     * shutdown comment above), so a non-empty answer at run teardown means
     * the agent left work running past the end of its turn.
     */
    listRunningShellSessionIds: (sessionIds?: string[]) => {
      const scope = sessionIds ? new Set(sessionIds) : null;
      const running: string[] = [];
      for (const shell of shellState.shells.values()) {
        if (!shell.running) continue;
        if (scope && !scope.has(shell.id)) continue;
        running.push(shell.id);
      }
      return running;
    },
    /** Running sessions owned by one conversation/agent thread across runs. */
    listRunningShellSessionsOwnedBy: (access: ShellSessionAccess) =>
      listRunningShellSessionsOwnedBy(shellState, access),
    /** Subscribe to one session's exit. Returns a disposer. */
    watchShellExit: (sessionId: string, listener: () => void) =>
      watchShellExit(shellState, sessionId, listener),
    /** Terminal facts about an exited session; null while it still runs. */
    readShellExitSnapshot: (sessionId: string) =>
      readShellExitSnapshot(shellState, sessionId),
    /** Finalize and detach browser ownership for one completed agent run. */
    endBrowserTurn: (
      runId: string,
      behavior: import("../browser-use/client.js").BrowserTurnEndBehavior,
    ) => nodeReplRegistry.endBrowserTurn(runId, behavior),
    killAllShells,
    killShell,
    killShellsByPort,
    shutdown,
    registerExtensionTools: (tools: ToolDefinition[]) => {
      // Reject tools that collide with built-in names. Pre-fix, an
      // extension registering e.g. `web` or `exec_command` would
      // overwrite the built-in handler/catalog entry AND get tracked in
      // `extensionToolNames`. On F1 reload `unregisterExtensionTools`
      // would then `delete` that name from both maps, leaving the
      // runtime without a built-in until worker restart. Skipping the
      // collision keeps the built-in intact — the right user fix is to
      // rename the extension tool.
      const accepted: ToolDefinition[] = [];
      for (const tool of tools) {
        if (isReservedToolName(tool.name)) {
          logError(
            `Extension tool "${tool.name}" uses a reserved name; skipping registration. ${reservedToolNameReason(tool.name)}`,
          );
          continue;
        }
        if (builtinToolNames.has(tool.name)) {
          logError(
            `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
          );
          continue;
        }
        accepted.push(tool);
      }
      registerExtensionToolHandlers(handlers, accepted);
      for (const tool of accepted) {
        toolCatalog.set(tool.name, copyCallableMetadata(tool));
        extensionToolNames.add(tool.name);
      }
    },
    /**
     * Remove all tools that came from user-installable extensions. Used by
     * F1 (extension hot-reload) before re-registering the freshly-loaded
     * extension set; built-in tools remain in the catalog and handler
     * maps untouched.
     */
    unregisterExtensionTools: () => {
      for (const name of extensionToolNames) {
        toolCatalog.delete(name);
        delete handlers[name];
      }
      extensionToolNames.clear();
    },
  };
};
