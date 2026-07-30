import { makeFunctionReference } from "convex/server";
import type {
  CloudConversation,
  OwnershipMigrationStatus,
} from "./cloud-conversation-state";

/** One durable spawned-agent row owned by the active cloud conversation. */
export type CloudAgentThread = {
  threadId: string;
  ownerId: string;
  conversationId: string;
  parentTurnId?: string;
  description: string;
  workspace: string;
  agentType: string;
  status: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

export const cloudConversationApi = {
  confirmMySessionIdentity: makeFunctionReference<
    "query",
    { expectedSubject: string; identityRevision: number },
    boolean
  >("cloud_apps:confirmMySessionIdentity"),
  getMyOwnershipMigrationStatus: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      status: OwnershipMigrationStatus;
      updatedAt: number;
      error?: string;
    } | null
  >("auth_migration:getMyOwnershipMigrationStatus"),
  retryMyLatestFailedOwnershipMigration: makeFunctionReference<
    "mutation",
    Record<string, never>,
    { scheduled: boolean }
  >("auth_migration:retryMyLatestFailedOwnershipMigration"),
  listMyConversations: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudConversation[]
  >("cloud_apps:listMyConversations"),
  getMyConversation: makeFunctionReference<
    "query",
    { conversationId: string },
    CloudConversation | null
  >("cloud_apps:getMyConversation"),
  createMyConversation: makeFunctionReference<
    "mutation",
    { clientCreateId: string; title?: string },
    CloudConversation
  >("cloud_apps:createMyConversation"),
  getCloudRealtimeConfig: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      httpOrigin: string | null;
      socketOrigin: string | null;
      protocol: number;
    }
  >("cloud_apps:getCloudRealtimeConfig"),
  startCloudChat: makeFunctionReference<
    "mutation",
    {
      prompt: string;
      conversationId?: string;
      clientMsgId?: string;
      locale?: string;
      attachments?: string[];
    },
    { conversationId: string; appId?: string; turnId: string }
  >("cloud_apps:startCloudChat"),
  listMyAgentThreads: makeFunctionReference<
    "query",
    { conversationId: string },
    CloudAgentThread[]
  >("cloud_apps:listMyAgentThreads"),
};
