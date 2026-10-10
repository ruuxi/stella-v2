import fs from "fs";
import os from "os";
import path from "path";
import type { AgentMessage } from "../agent-core/types.js";
import { getLocalCliWorkingDirectory } from "@stella/contracts/agent-runtime";

// Loop-adjacent helpers now live in the workerd-safe `run-shared.ts` so the
// cloud DO and sandbox executor run the same code; re-exported here for the
// desktop-side callers that always imported them from this module.
export {
  assistantMessageHasToolCall,
  extractAssistantText,
} from "./run-shared.js";

const MAX_RESULT_PREVIEW = 200;

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
