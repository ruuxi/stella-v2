import fs from "fs";
import os from "os";
import path from "path";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent-core/agent.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "../agent-core/types.js";
import type { Message, ServiceTier } from "../../ai/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import {
  getAgentFollowUpMode,
  getAgentSteeringMode,
  getLocalCliWorkingDirectory,
} from "@stella/contracts/agent-runtime";
import { resolveAgentThinkingLevel } from "./run-shared.js";
import { AGENT_RUN_MAX_ATTEMPTS } from "./run-retry.js";
import { preflightProviderPayload } from "./context-budget.js";

// Loop-adjacent helpers now live in the workerd-safe `run-shared.ts` so the
// cloud DO and sandbox executor run the same code; re-exported here for the
// desktop-side callers that always imported them from this module.
export {
  assistantMessageHasToolCall,
  buildDefaultTransformContext,
  extractAssistantText,
  getAgentCompletion,
  resolveAgentThinkingLevel,
} from "./run-shared.js";

const MAX_RESULT_PREVIEW = 200;

export const DEFAULT_MAX_TURNS = 40;

export const PI_AGENT_MESSAGE_FILTER = (messages: AgentMessage[]): Message[] =>
  messages.flatMap((msg): Message[] => {
    if (
      msg.role === "user" ||
      msg.role === "assistant" ||
      msg.role === "toolResult"
    ) {
      return [msg];
    }
    if (msg.role === "runtimeInternal") {
      return [
        {
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        },
      ];
    }
    return [];
  });

export const AnyToolArgsSchema = Type.Object(
  {},
  { additionalProperties: true },
);

export const now = () => Date.now();

const expandWorkingDirectory = (
  value: string,
  homeDirectory: string,
): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

const isDirectory = (value: string): boolean => {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Resolve the filesystem root an agent should operate from. The install root
 * remains a separate absolute path for bundled assets; it is only selected
 * here for the legacy `frontend` mode when it is a real directory. Packaged
 * Electron builds expose `app.asar` as the install root, but child-process
 * `cwd` must be a directory, so those builds fall back to the user's home.
 */
export const resolveAgentWorkingDirectory = ({
  agentType,
  stellaAppDir,
  workingDirectory,
}: {
  agentType: string;
  stellaAppDir?: string;
  workingDirectory?: string;
}): string | undefined => {
  const homeDirectory = os.homedir().trim();
  const explicitWorkingDirectory = workingDirectory?.trim();
  if (explicitWorkingDirectory) {
    return path.resolve(
      expandWorkingDirectory(explicitWorkingDirectory, homeDirectory),
    );
  }
  const normalizedStellaAppDir = stellaAppDir?.trim();
  if (
    getLocalCliWorkingDirectory(agentType) === "frontend" &&
    normalizedStellaAppDir &&
    isDirectory(normalizedStellaAppDir)
  ) {
    return normalizedStellaAppDir;
  }
  if (homeDirectory) return path.resolve(homeDirectory);
  return undefined;
};

/** Historical name for {@link resolveAgentWorkingDirectory}. */
export const resolveLocalCliCwd = resolveAgentWorkingDirectory;

export const textFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const textFromToolLikeValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.result === "string") {
      return record.result;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
    if (typeof record.text === "string") {
      return record.text;
    }
    if (record.details && typeof record.details === "object") {
      const details = record.details as Record<string, unknown>;
      if (typeof details.text === "string") {
        return details.text;
      }
    }
  }
  return textFromUnknown(value);
};

export const getToolResultPreview = (
  _toolName: string,
  result: unknown,
): string => textFromToolLikeValue(result).slice(0, MAX_RESULT_PREVIEW);

export const toAgentMessages = (
  history: Array<{ role: "user" | "assistant"; content: string }>,
): AgentMessage[] => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };

  return history
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => {
      if (entry.role === "user") {
        return {
          role: "user" as const,
          content: [{ type: "text" as const, text: entry.content }],
          timestamp: now(),
        };
      }

      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: entry.content }],
        api: "openai-completions" as const,
        provider: "openai",
        model: "history",
        usage,
        stopReason: "stop" as const,
        timestamp: now(),
      };
    });
};

export const createBeforeProviderPayloadTransform = (
  hookEmitter: HookEmitter | undefined,
  agentType: string,
) =>
  hookEmitter
    ? async (payload: unknown, model: { id: string }) => {
        const result = await hookEmitter.emit("before_provider_request", {
          agentType,
          model: model.id,
          payload,
        });
        return result?.payload;
      }
    : undefined;

export const createRuntimeAgent = (args: {
  agentType: string;
  systemPrompt: string;
  resolvedLlm: ResolvedLlmRoute;
  /**
   * Optional dynamic resolver for the current `ResolvedLlmRoute`. When
   * provided, the Agent's `getApiKey`/`refreshApiKey`/`transformContext`
   * closures read from this getter on every call instead of capturing
   * `args.resolvedLlm` at construction time. Long-lived sessions
   * (`OrchestratorSession`) pass this so the user can switch models
   * mid-conversation: update the ref + `agent.state.model`, and the next
   * provider call uses the new credentials, base URL, and context-window
   * budget. Per-turn callers can omit this and the static `resolvedLlm` is
   * used for the lifetime of the run.
   */
  resolvedLlmOverride?: () => ResolvedLlmRoute;
  reasoningEffort?: ThinkingLevel;
  hookEmitter?: HookEmitter;
  tools: AgentTool[];
  historySource: AgentMessage[];
  /**
   * Stable identifier used for upstream prompt-cache routing affinity
   * (Anthropic ephemeral cache, OpenAI/Fireworks `prompt_cache_key`, etc.).
   * Pass the threadKey or agentType so repeated turns within the same
   * conversation hit the same cache shard.
   */
  cacheSessionId?: string;
  /**
   * Stable per-conversation prompt-cache routing key forwarded to providers
   * that support one (OpenAI/Fireworks `prompt_cache_key`). Distinct from
   * `cacheSessionId`, which keys local session resources by thread.
   */
  promptCacheKey?: string;
  /** Provider request tier, currently used for ChatGPT/Codex Fast mode. */
  serviceTier?: ServiceTier;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) =>
    | Promise<AfterToolCallResult | undefined>
    | AfterToolCallResult
    | undefined;
  /**
   * Surface a transient "trying again in X" status when the provider
   * adapter retries a recoverable failure. Sessions wire this to a STATUS
   * event so the desktop can show a brief retry toast.
   */
  onProviderRetry?: (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }) => void;
}): Agent => {
  const resolveLlm = args.resolvedLlmOverride ?? (() => args.resolvedLlm);
  const toolInactivityRaw = process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
  const toolInactivityParsed = toolInactivityRaw ? Number(toolInactivityRaw) : Number.NaN;
  return new Agent({
    initialState: {
      systemPrompt: args.systemPrompt,
      model: resolveLlm().model,
      thinkingLevel:
        args.reasoningEffort ??
        resolveAgentThinkingLevel({ resolvedLlm: args.resolvedLlm }),
      tools: args.tools,
      messages: args.historySource,
    },
    sessionId: args.cacheSessionId ?? args.agentType,
    promptCacheKey: args.promptCacheKey,
    serviceTier: args.serviceTier,
    // Per-tool inactivity bound (default 10 min in agent-core): a tool that
    // goes fully silent is cancelled with an error tool result instead of
    // tripping the run-level idle watchdog and killing the whole agent.
    ...(Number.isFinite(toolInactivityParsed)
      ? { toolInactivityTimeoutMs: toolInactivityParsed }
      : {}),
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    // Only pass steering / follow-up modes when the agent opts out of
    // the Pi default ("one-at-a-time").
    ...(getAgentSteeringMode(args.agentType) === "all"
      ? { steeringMode: "all" as const }
      : {}),
    ...(getAgentFollowUpMode(args.agentType) === "all"
      ? { followUpMode: "all" as const }
      : {}),
    getApiKey: () => resolveLlm().getApiKey(),
    // Always defined when an override is in play, since the *current*
    // route may have a refresher even if the original didn't (and vice
    // versa). The inner `?.()` returns `undefined` when the route lacks
    // one, which the agent loop already handles.
    refreshApiKey: () => resolveLlm().refreshApiKey?.(),
    onPayload: async (payload, model) => {
      const transform = createBeforeProviderPayloadTransform(
        args.hookEmitter,
        args.agentType,
      );
      const transformed = await transform?.(payload, model);
      preflightProviderPayload(
        args.cacheSessionId ?? args.agentType,
        transformed ?? payload,
        model,
      );
      return transformed;
    },
    onProviderRetry: args.onProviderRetry,
    // The runtime's four-attempt policy owns empty completions. Leaving the
    // Agent core's default one-shot enabled here would allow every outer
    // attempt to make two provider calls.
    degenerateResponseRetries: 0,
    // Adapter continuations, outer recovery resumes, and provider SDK retries
    // share the same physical-request ceiling for one logical model completion.
    // A successful tool-use completion releases it before the next model round.
    providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
    afterToolCall: args.afterToolCall
      ? async (context, signal) => await args.afterToolCall?.(context, signal)
      : undefined,
  });
};

