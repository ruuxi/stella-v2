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

export type CloudAuthorityPorts = {
  confirmIdentity: (args: {
    expectedSubject: string;
    identityRevision: number;
  }) => Promise<boolean>;
  getOwnerGeneration: () => Promise<string>;
  ensureConversation: () => Promise<string>;
  getRealtimeConfig: () => Promise<CloudRealtimeConfig>;
};

/**
 * Framework-free authority handshake used by the hook and focused tests.
 * Conversation creation is deterministic/idempotent; a clean install therefore
 * discovers the exact placement conversation instead of creating a new one.
 */
export const loadCloudConversationAuthority = async (
  identity: CloudConversationIdentity,
  ports: CloudAuthorityPorts,
): Promise<CloudConversationAuthority> => {
  // The realtime config is deployment-wide and read-only, so it rides along
  // with the identity chain instead of adding its own round trip to the
  // splash-held handshake. Its result (or failure) is only read below, in the
  // same place as before, so error precedence is unchanged.
  const configRequest = Promise.resolve().then(() => ports.getRealtimeConfig());
  configRequest.catch(() => undefined);
  const confirmed = await ports.confirmIdentity({
    expectedSubject: identity.expectedSubject,
    identityRevision: identity.revision,
  });
  if (!confirmed) {
    throw new CloudAuthorityError(
      "Stella is still securing this account. Try again in a moment.",
      true,
    );
  }
  const conversationId = (await ports.ensureConversation()).trim();
  if (!conversationId) {
    throw new CloudAuthorityError(
      "Stella could not identify this cloud conversation.",
      true,
    );
  }
  const config = await configRequest;
  const ownerGeneration = (await ports.getOwnerGeneration()).trim();
  if (!ownerGeneration) {
    throw new CloudAuthorityError(
      "Stella could not verify this account generation.",
      true,
    );
  }
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
  return {
    identityKey: identity.identityKey,
    accountScope: identity.accountScope,
    ownerGeneration,
    conversationId,
    socketOrigin,
  };
};
