import type { CloudConversationIdentity } from "./cloud-conversation-auth";

export type CloudRealtimeConfig = {
  httpOrigin: string | null;
  socketOrigin: string | null;
  protocol: number;
};

export type CloudConversationAuthority = {
  identityKey: string;
  accountScope: string;
  ownerGeneration: string;
  conversationId: string;
  socketOrigin: string;
};

export type CloudAuthorityIssue = {
  message: string;
  retryable: boolean;
};

export class CloudAuthorityError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CloudAuthorityError";
    this.retryable = retryable;
  }
}

/** Everything the chat needs, in one read (`conversations.bootstrap`). */
export type CloudChatBootstrap =
  | { status: "identity_pending" }
  | {
      status: "ready";
      ownerId: string;
      ownerGeneration: string;
      /** Null until the one chat is first created. */
      conversationId: string | null;
      realtime: CloudRealtimeConfig;
    };

export type CloudAuthorityPorts = {
  getBootstrap: () => Promise<CloudChatBootstrap>;
  /** Idempotent: always resolves the same chat for this account. */
  createConversation: (expectedOwnerGeneration: string) => Promise<string>;
};

/**
 * Framework-free authority handshake used by the hook and focused tests.
 *
 * One read normally resolves everything; the chat is created (deterministic
 * and idempotent) only the first time an account opens it, so a clean install
 * discovers the existing chat instead of creating a new one.
 */
export const loadCloudConversationAuthority = async (
  identity: CloudConversationIdentity,
  expectedOwnerId: string,
  ports: CloudAuthorityPorts,
): Promise<CloudConversationAuthority> => {
  const bootstrap = await ports.getBootstrap();
  if (bootstrap.status !== "ready") {
    throw new CloudAuthorityError(
      "Stella is still securing this account. Try again in a moment.",
      true,
    );
  }
  if (bootstrap.ownerId !== expectedOwnerId) {
    throw new CloudAuthorityError(
      "Stella is still securing this account. Try again in a moment.",
      true,
    );
  }
  const ownerGeneration = bootstrap.ownerGeneration.trim();
  if (!ownerGeneration) {
    throw new CloudAuthorityError(
      "Stella could not verify this account generation.",
      true,
    );
  }
  const config = bootstrap.realtime;
  const socketOrigin = config.socketOrigin?.trim().replace(/\/+$/, "") ?? "";
  if (config.protocol !== 1) {
    throw new CloudAuthorityError(
      "This version of Stella cannot safely load cloud history. Update the app.",
      false,
    );
  }
  if (!socketOrigin) {
    throw new CloudAuthorityError(
      "Cloud conversation history is not available on this deployment.",
      false,
    );
  }
  const conversationId = (
    bootstrap.conversationId ??
    (await ports.createConversation(ownerGeneration))
  ).trim();
  if (!conversationId) {
    throw new CloudAuthorityError(
      "Stella could not identify this cloud conversation.",
      true,
    );
  }
  return {
    identityKey: identity.identityKey,
    accountScope: identity.accountScope,
    ownerGeneration,
    conversationId,
    socketOrigin,
  };
};
