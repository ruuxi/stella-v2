import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Conversations and the owner identity, served from the owner's object.
 * The conversation's transcript stays in its own `OrchestratorSession`; this
 * is the index a client lists and selects from.
 */

export type ConversationSummary = {
  /** The account this row belongs to; clients drop rows for any other. */
  ownerId: string;
  conversationId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPreview?: string;
  lastRole?: string;
  activity?: "idle" | "running";
};

export type OwnerIdentity = {
  ownerId: string;
  /** Changes when the owner resets or deletes their data; fences stale work. */
  ownerGeneration: string;
};

export type ConversationCalls = {
  "owner.identity": { args: Record<string, never>; result: OwnerIdentity };
  /**
   * Create a conversation without starting a turn. `clientCreateId` makes a
   * retried create return the same conversation.
   */
  "conversations.create": {
    args: {
      clientCreateId: string;
      requestedConversationId?: string;
      title?: string;
      execution?: CloudExecutionSelection;
    };
    result: ConversationSummary;
  };
  /**
   * The conversation already created under `clientCreateId`, if any, plus the
   * owner identity: everything a client needs before showing its chat.
   */
  "conversations.bootstrap": {
    args: { clientCreateId: string };
    result: OwnerIdentity & { conversationId: string | null };
  };
  /** Sidebar history, newest first; pass the last row back as the cursor. */
  "conversations.page": {
    args: {
      before?: { updatedAt: number; conversationId: string };
      limit?: number;
    };
    result: { conversations: ConversationSummary[]; hasMore: boolean };
  };
  /**
   * Copy a conversation through `throughSeq` into a new one. The expected
   * head fences the copy against a turn the client hasn't seen; a retried
   * `requestId` returns the same fork.
   */
  "conversations.fork": {
    args: {
      sourceConversationId: string;
      throughSeq: number;
      expectedEpoch: number;
      expectedLastSeq: number;
      requestId: string;
    };
    result: {
      conversationId: string;
      sourceEpoch: number;
      throughSeq: number;
      targetEpoch: number;
      lastSeq: number;
      replayed: boolean;
    };
  };
  /** Cut a conversation back to `throughSeq`, advancing its epoch. */
  "conversations.rewind": {
    args: {
      conversationId: string;
      throughSeq: number;
      expectedEpoch: number;
      expectedLastSeq: number;
      requestId: string;
      activeTurnPolicy: "conflict" | "cancel";
    };
    result: {
      conversationId: string;
      previousEpoch: number;
      nextEpoch: number;
      lastSeq: number;
      replayed: boolean;
    };
  };
};

export type ConversationViews = {
  /** The newest conversations, for selection and the sidebar's first page. */
  "conversations.recent": { args: Record<string, never>; result: ConversationSummary[] };
  "conversations.get": {
    args: { conversationId: string };
    result: ConversationSummary | null;
  };
};

export const RECENT_CONVERSATIONS_LIMIT = 25;
export const CONVERSATION_TITLE_MAX = 56;
export const CONVERSATION_PREVIEW_MAX = 160;
