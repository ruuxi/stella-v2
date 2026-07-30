export type CloudConversation = {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPreview?: string;
  lastRole?: string;
  activity?: string;
};

export type OwnershipMigrationStatus =
  | "pending"
  | "running"
  | "failed"
  | "complete";

export type AsyncKeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const ACTIVE_CONVERSATION_KEY_PREFIX =
  "stella-mobile:active-cloud-conversation:";
const CREATE_ID_KEY_PREFIX = "stella-mobile:cloud-conversation-create-id:";
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CREATE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

function activeConversationKey(accountScope: string): string {
  return `${ACTIVE_CONVERSATION_KEY_PREFIX}${encodeURIComponent(accountScope)}`;
}

function createIdKey(accountScope: string): string {
  return `${CREATE_ID_KEY_PREFIX}${encodeURIComponent(accountScope)}`;
}

export function resolveOwnershipMigrationGate(
  status: OwnershipMigrationStatus | null | undefined,
  cloudMode: boolean,
): {
  isLoading: boolean;
  isPending: boolean;
  isFailed: boolean;
  canSelectConversation: boolean;
} {
  const isLoading = cloudMode && status === undefined;
  const isPending = status === "pending" || status === "running";
  const isFailed = status === "failed";
  return {
    isLoading,
    isPending,
    isFailed,
    canSelectConversation: cloudMode && !isLoading && !isPending && !isFailed,
  };
}

/**
 * The Convex functions feeding these rows are owner-scoped and
 * `getMyConversation` returns null for a foreign id. `ownerId` is the Convex
 * token identifier (not the raw Better Auth user id), so clients must not try
 * to reproduce or compare it locally.
 */
export function resolveOwnedCloudConversation(args: {
  conversations: readonly CloudConversation[];
  exactCachedConversation: CloudConversation | null;
  cachedConversationId: string | null;
  justCreatedConversation: CloudConversation | null;
}): CloudConversation | null {
  if (args.cachedConversationId) {
    if (
      args.justCreatedConversation?.conversationId === args.cachedConversationId
    ) {
      return args.justCreatedConversation;
    }
    if (
      args.exactCachedConversation?.conversationId === args.cachedConversationId
    ) {
      return args.exactCachedConversation;
    }
    const listed = args.conversations.find(
      (conversation) =>
        conversation.conversationId === args.cachedConversationId,
    );
    if (listed) return listed;
  }

  return args.conversations[0] ?? null;
}

export async function readActiveCloudConversationId(
  storage: AsyncKeyValueStorage,
  accountScope: string,
): Promise<string | null> {
  const value = await storage.getItem(activeConversationKey(accountScope));
  return value && CONVERSATION_ID_PATTERN.test(value) ? value : null;
}

export async function writeActiveCloudConversationId(
  storage: AsyncKeyValueStorage,
  accountScope: string,
  conversationId: string,
): Promise<void> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("Invalid cloud conversation id.");
  }
  await storage.setItem(activeConversationKey(accountScope), conversationId);
}

export async function getOrCreateCloudConversationCreateId(
  storage: AsyncKeyValueStorage,
  accountScope: string,
  createUuid: () => string,
): Promise<string> {
  const key = createIdKey(accountScope);
  const existing = await storage.getItem(key);
  if (existing && CREATE_ID_PATTERN.test(existing)) return existing;
  const created = `mobile:${createUuid()}`;
  await storage.setItem(key, created);
  return created;
}

export async function rotateCloudConversationCreateId(
  storage: AsyncKeyValueStorage,
  accountScope: string,
  createUuid: () => string,
): Promise<void> {
  await storage.setItem(createIdKey(accountScope), `mobile:${createUuid()}`);
}
