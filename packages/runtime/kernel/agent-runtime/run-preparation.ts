import type { AgentMessage } from "../agent-core/types.js";
import type { ImageContent } from "../../ai/types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import {
  renderSystemPrompt,
  type SystemPromptSection,
} from "./frozen-context.js";
import { resolveAgentWorkingDirectory } from "./shared.js";
import { buildSystemPromptSections } from "./thread-memory.js";
import type { OrchestratorRunOptions, SubagentRunOptions } from "./types.js";

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

const toImageContent = (
  attachment: RuntimeAttachmentRef,
): ImageContent | null => {
  const match = DATA_URL_RE.exec(attachment.url.trim());
  if (!match) {
    return null;
  }
  const mimeType = (attachment.mimeType?.trim() || match[1])
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  return {
    type: "image",
    mimeType,
    data: match[2],
    ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
  };
};

/**
 * Whether this attachment is carried by the message itself, as an inline
 * image block. The journal mirrors those blocks verbatim, so a caller that
 * also lists attachments as metadata must exclude these or the same file is
 * presented twice. Shares `toImageContent` with the message builder so the
 * two cannot disagree about what inlines.
 */
export const isInlineImageAttachment = (
  attachment: RuntimeAttachmentRef,
): boolean => toImageContent(attachment) !== null;

/**
 * Keep tool paths in durable model context, separate from the visible user
 * turn.
 *
 * Every attachment the worker put on disk is named here, images included. An
 * image is already inlined as pixels, so this is not how the turn sees it —
 * it is how the turn can *delegate* it: a subagent or a placed agent receives
 * a prompt, never this turn's image blocks, so an absolute path is the only
 * thing it can act on. Without it, "look at the screenshot I attached" worked
 * for a document and silently lost an image.
 *
 * Keyed on an explicit `kind`, not on `sourcePath` alone: the ambient window
 * screenshot is also persisted and also has a path, but the user never
 * attached it and announcing it as an attachment would be a lie.
 */
export const createFileAttachmentPromptInput = (
  attachments?: RuntimeAttachmentRef[],
): RuntimePromptMessage | null => {
  const described = (attachments ?? []).flatMap((attachment) => {
    if (!attachment.sourcePath) return [];
    if (attachment.kind === "file") {
      return [
        `The user attached a file: ${JSON.stringify(attachment.name || "attachment")} (${attachment.mimeType || "application/octet-stream"}). The file is available locally at ${JSON.stringify(attachment.sourcePath)}. Use Read or delegate to an agent to inspect it. Pass this absolute path to any agent that needs its contents.`,
      ];
    }
    if (attachment.kind === "image") {
      return [
        `The user attached an image: ${JSON.stringify(attachment.name || "image")} (${attachment.mimeType || "image/png"}). It is already attached to this message, and the same bytes are saved locally at ${JSON.stringify(attachment.sourcePath)}. Use Read with that path to look at it again, and pass this absolute path to any agent that needs to see it.`,
      ];
    }
    return [];
  });
  if (described.length === 0) return null;
  return {
    text: described.join("\n"),
    messageType: "message",
    customType: "runtime.file_attachments",
    display: false,
    uiVisibility: "hidden",
  };
};

export const withFileAttachmentPromptInput = (
  promptMessages: RuntimePromptMessage[],
  attachments?: RuntimeAttachmentRef[],
): RuntimePromptMessage[] => {
  const fileContext = createFileAttachmentPromptInput(attachments);
  return fileContext ? [...promptMessages, fileContext] : promptMessages;
};

export const createUserPromptMessage = (
  text: string,
  attachments?: RuntimeAttachmentRef[],
) => ({
  role: "user" as const,
  content: [
    { type: "text" as const, text },
    ...(attachments ?? [])
      .map((attachment) => toImageContent(attachment))
      .filter((attachment): attachment is ImageContent => attachment !== null),
  ],
});

export const createRuntimePromptAgentMessage = (
  message: RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] },
  timestamp: number,
): AgentMessage => {
  const content = [
    { type: "text" as const, text: message.text },
    ...(message.attachments ?? [])
      .map((attachment) => toImageContent(attachment))
      .filter((attachment): attachment is ImageContent => attachment !== null),
  ];
  if (message.messageType === "message") {
    return {
      role: "runtimeInternal",
      content,
      timestamp,
      ...(message.customType ? { customType: message.customType } : {}),
      ...(message.eventId ? { eventId: message.eventId } : {}),
      ...(message.display !== undefined ? { display: message.display } : {}),
    };
  }
  return {
    role: "user",
    content,
    timestamp,
  };
};

export { renderSystemPrompt, type SystemPromptSection };

const workingDirectorySection = (
  opts: Pick<
    OrchestratorRunOptions,
    "agentType" | "stellaAppDir" | "toolWorkspaceRoot"
  >,
): SystemPromptSection[] => {
  const cwd = resolveAgentWorkingDirectory({
    agentType: opts.agentType,
    stellaAppDir: opts.stellaAppDir,
    workingDirectory: opts.toolWorkspaceRoot,
  });
  return cwd
    ? [{ id: "working-directory", text: `Current working directory: ${cwd}` }]
    : [];
};

/**
 * The run's system prompt sections: the agent's own, the working directory,
 * the thread id when there is one (it never changes for the thread's life),
 * then each `before_agent_start` extension's addition in registration order.
 */
const buildRunSystemPromptSections = async (
  opts: (OrchestratorRunOptions | SubagentRunOptions) & { runId?: string },
  threadId: string | undefined,
): Promise<SystemPromptSection[]> => {
  const sections: SystemPromptSection[] = [
    ...buildSystemPromptSections(opts.agentContext),
    ...workingDirectorySection(opts),
    ...(threadId ? [{ id: "thread-id", text: `Thread ID: ${threadId}` }] : []),
  ];
  if (!opts.hookEmitter) {
    return sections;
  }
  // Compose every hook result in registration order; `emit` would only keep
  // the last non-empty result.
  const hookResults = await opts.hookEmitter.emitAll(
    "before_agent_start",
    {
      agentType: opts.agentType,
      systemPrompt: renderSystemPrompt(sections),
      conversationId: opts.conversationId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      isUserTurn: opts.uiVisibility !== "hidden",
    },
    { agentType: opts.agentType },
  );
  let prompt = sections;
  hookResults.forEach((result, index) => {
    if (result?.systemPromptReplace) {
      prompt = [{ id: "instructions", text: result.systemPromptReplace }];
    }
    if (result?.systemPromptAppend) {
      prompt = [
        ...prompt,
        { id: `extension-${index}`, text: result.systemPromptAppend },
      ];
    }
  });
  return prompt;
};

export const buildRuntimeSystemPrompt = (
  opts: OrchestratorRunOptions & { runId?: string },
): Promise<SystemPromptSection[]> =>
  buildRunSystemPromptSections(opts, opts.conversationId);

// Symmetric with `buildRuntimeSystemPrompt` (orchestrator). Subagents get the
// same `before_agent_start` fan-out so user extensions that subscribe to the
// event for a subagent agentType (e.g. layering additional system-prompt
// context onto General runs) are invoked without extensions needing
// engine-specific knowledge.
export const buildSubagentSystemPrompt = (
  opts: SubagentRunOptions & { runId?: string },
): Promise<SystemPromptSection[]> =>
  buildRunSystemPromptSections(opts, opts.agentId);
