/**
 * `agent_status` without a thread_id, and `send_message` to anyone the caller
 * did not start, for both cloud callers: the conversation's orchestrator and
 * a cloud agent. Both read and write through the owner's agent-thread index,
 * which sees every placement and every conversation.
 */

import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_MESSAGE_MAX_CHARS,
  buildAgentDirectoryResult,
  type AgentDirectoryAgentRow,
  type AgentDirectoryCaller,
  type AgentDirectorySessionRow,
  type AgentMessageSender,
} from "@stella/contracts/agent-directory";
import type { AgentMessageDelivery } from "@stella/contracts/backend/agent-threads";

/** The longest a framed message gets: the text plus its `<agent-message>` envelope. */
export const AGENT_MESSAGE_FRAMED_MAX_CHARS = AGENT_MESSAGE_MAX_CHARS + 1_024;

export type AgentMessagingCaller = Readonly<{
  /** `OwnerGate.ownerInternal`, already scoped to the owner and generation. */
  ownerInternal: (name: string, args: unknown) => Promise<unknown>;
  ownerGeneration: string;
}>;

export type AgentDirectory = {
  agents: AgentDirectoryAgentRow[];
  sessions: AgentDirectorySessionRow[];
};

export const readAgentDirectory = async (
  caller: AgentMessagingCaller,
  conversationId: string,
): Promise<AgentDirectory> =>
  (await caller.ownerInternal("agentThreads.directory", {
    ownerGeneration: caller.ownerGeneration,
    conversationId,
  })) as AgentDirectory;

export const agentDirectoryStatus = async (
  caller: AgentMessagingCaller,
  you: AgentDirectoryCaller,
): Promise<AgentToolResult<unknown>> => {
  const directory = await readAgentDirectory(caller, you.conversationId);
  const listing = buildAgentDirectoryResult({ caller: you, ...directory });
  return {
    content: [{ type: "text", text: JSON.stringify(listing, null, 2) }],
    details: listing,
  };
};

/** `agent_status` on a session's thread_id: the row the listing shows for it. */
export const sessionStatus = async (
  caller: AgentMessagingCaller,
  conversationId: string,
  threadId: string,
): Promise<AgentToolResult<unknown> | null> => {
  const { sessions } = await readAgentDirectory(caller, conversationId);
  const session = sessions.find((row) => row.conversationId === threadId);
  if (!session) return null;
  const title = session.title.trim() || "Untitled chat";
  const status = session.active ? "running" : "idle";
  return {
    content: [
      {
        type: "text",
        text: `Thread ${threadId} is another Stella session ("${title}"), ${status} in ${session.where}, last active ${new Date(session.updatedAt).toISOString()}. send_message queues a note as its next turn. This snapshot did not message it.`,
      },
    ],
    details: {
      thread_id: threadId,
      title,
      status,
      where: session.where,
      last_active_at: new Date(session.updatedAt).toISOString(),
    },
  };
};

export const sendAgentMessage = async (
  caller: AgentMessagingCaller,
  input: { messageId: string; to: string; text: string; from: AgentMessageSender },
): Promise<AgentMessageDelivery> =>
  (await caller.ownerInternal("agentThreads.message", {
    ownerGeneration: caller.ownerGeneration,
    messageId: input.messageId,
    to: input.to,
    text: input.text,
    from: input.from,
  })) as AgentMessageDelivery;

export const agentMessageResult = (
  delivery: AgentMessageDelivery,
): AgentToolResult<unknown> => ({
  content: [
    {
      type: "text",
      text:
        delivery.delivered === "steered"
          ? `Delivered to ${delivery.threadId}. It is working and reads your message before its next step.`
          : delivery.delivered === "resumed"
            ? `Delivered to ${delivery.threadId}. It was idle, so your message started its next run.`
            : `Delivered to ${delivery.threadId}. That Stella reads it as its next turn.`,
    },
  ],
  details: { thread_id: delivery.threadId, delivered: delivery.delivered },
});
