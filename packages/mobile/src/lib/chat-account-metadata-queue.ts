import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadAccountChatCleanupIntent } from "./chat-account-cleanup-state";

const TRANSCRIPT_CLEANUP_REQUIRED_KEY =
  "stella-mobile-transcript-cleanup-required-v1";

let cleanupInProgress = false;
let generation = 0;
let writeQueue: Promise<unknown> = Promise.resolve();

const durableCleanupPending = async (): Promise<boolean> =>
  Boolean(await loadAccountChatCleanupIntent()) ||
  (await AsyncStorage.getItem(TRANSCRIPT_CLEANUP_REQUIRED_KEY)) === "1";

export function beginAccountChatMetadataCleanup(): void {
  cleanupInProgress = true;
  generation += 1;
}

export function finishAccountChatMetadataCleanup(): void {
  cleanupInProgress = false;
}

export async function waitForAccountChatMetadataWrites(): Promise<void> {
  await writeQueue.catch(() => {});
}

export async function runAccountChatMetadataWrite<T>(
  work: () => Promise<T>,
): Promise<{ executed: true; value: T } | { executed: false }> {
  if (cleanupInProgress || (await durableCleanupPending())) {
    return { executed: false };
  }
  const writeGeneration = generation;
  const run = writeQueue.then(async () => {
    if (
      cleanupInProgress ||
      writeGeneration !== generation ||
      (await durableCleanupPending())
    ) {
      return { executed: false } as const;
    }
    return { executed: true, value: await work() } as const;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function accountChatMetadataReadsBlocked(): Promise<boolean> {
  return cleanupInProgress || durableCleanupPending();
}
