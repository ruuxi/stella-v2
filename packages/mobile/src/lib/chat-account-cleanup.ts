import {
  clearMessageIndex,
  ensureMessageIndexRebuildIntent,
  rebuildMessageIndex,
} from "./chat-message-index";
import {
  beginAccountChatCleanupIntent,
  finalizeAccountChatCleanup,
  markAccountCanonicalChatCleared,
  markAccountChatIndexCleared,
} from "./chat-account-cleanup-state";
import {
  clearAllChatStorage,
  invalidateChatStorageForAccountCleanup,
} from "./offline-chat-storage";

type ChatAccountCleanupOperations = {
  beginCleanupIntent: () => Promise<string>;
  invalidateMountedOwners: () => void;
  beginIndexRebuild: () => Promise<void>;
  clearCanonicalStorage: () => Promise<void>;
  markCanonicalCleared: (token: string) => Promise<void>;
  rebuildIndex: () => Promise<void>;
  clearIndex: () => Promise<void>;
  markIndexCleared: (token: string) => Promise<void>;
  finalizeCleanup: (token: string) => Promise<boolean>;
};

const defaultOperations: ChatAccountCleanupOperations = {
  beginCleanupIntent: beginAccountChatCleanupIntent,
  invalidateMountedOwners: invalidateChatStorageForAccountCleanup,
  beginIndexRebuild: ensureMessageIndexRebuildIntent,
  clearCanonicalStorage: clearAllChatStorage,
  markCanonicalCleared: markAccountCanonicalChatCleared,
  rebuildIndex: rebuildMessageIndex,
  clearIndex: clearMessageIndex,
  markIndexCleared: markAccountChatIndexCleared,
  finalizeCleanup: finalizeAccountChatCleanup,
};

export async function clearAccountChatData(
  operations: ChatAccountCleanupOperations = defaultOperations,
): Promise<void> {
  // This owner marker precedes both per-store intents. A kill in the gap
  // between them therefore rolls the entire account wipe forward on mount.
  const token = await operations.beginCleanupIntent();
  operations.invalidateMountedOwners();
  try {
    // Canonical rows remain intact until recall is durably blocked.
    await operations.beginIndexRebuild();
    await operations.clearCanonicalStorage();
    await operations.markCanonicalCleared(token);
  } catch (error) {
    // The account owner marker remains for cold-start recovery. Best-effort
    // rebuilding only restores this process when canonical mutation never
    // started; failures remain blocked and retry from the durable marker.
    await operations.rebuildIndex().catch(() => {});
    throw error;
  }
  await operations.clearIndex();
  await operations.markIndexCleared(token);
  if (!(await operations.finalizeCleanup(token))) {
    throw new Error("Local chat account cleanup did not finalize");
  }
}
