import type {
  CloudConversation,
  CloudShellBootstrap,
} from "@/features/cloud/cloud-api";

type ReadyShellBootstrap = Extract<CloudShellBootstrap, { status: "ready" }>;
export type ShellBootstrapSelection = NonNullable<
  ReadyShellBootstrap["selection"]
>;

/**
 * The ids the one launch read looks up besides the list. They are captured
 * once per account (`key`) and then frozen, so navigating between chats never
 * re-keys the shell's subscription; later lookups use `getMyConversation`.
 */
export type ShellBootstrapLookups = {
  key: string;
  routeConversationId?: string;
  cachedConversationId?: string;
};

export const captureShellBootstrapLookups = (
  key: string,
  routeConversationId: string | null,
  cachedConversationId: string | null,
): ShellBootstrapLookups => ({
  key,
  ...(routeConversationId ? { routeConversationId } : {}),
  ...(cachedConversationId && cachedConversationId !== routeConversationId
    ? { cachedConversationId }
    : {}),
});

/**
 * TEMPORARY (remove once every backend a shipped client can reach serves
 * `cloud_apps:getMyShellBootstrap`): a production deployment that lags the
 * client answers with this error, and the shell falls back to the launch
 * chain the bootstrap replaces.
 */
export const isMissingPublicFunctionError = (error: unknown): boolean =>
  error instanceof Error &&
  /Could not find public function/iu.test(error.message);

/**
 * Only a `ready` result for the owner the renderer currently expects counts
 * as a proof of identity. Anything else reads as still pending, so a result
 * belonging to another account can never reach conversation selection.
 *
 * A failure throws, as the readiness-gated `useQuery` it replaces would: the
 * server only fails after the identity check, so the failure belongs to this
 * account. A missing function (the fallback case) reads as not yet loaded.
 */
export const readShellBootstrap = (
  result: CloudShellBootstrap | Error | undefined,
  ownerSubject: string | null,
): { settled: boolean; ready: ReadyShellBootstrap | null } => {
  if (result === undefined) return { settled: false, ready: null };
  if (result instanceof Error) {
    if (isMissingPublicFunctionError(result)) {
      return { settled: false, ready: null };
    }
    throw result;
  }
  if (
    result.status !== "ready" ||
    ownerSubject === null ||
    result.ownerId !== ownerSubject
  ) {
    return { settled: true, ready: null };
  }
  return { settled: true, ready: result };
};

/**
 * The launch read's answer for `conversationId`, or undefined when that read
 * did not look it up (the caller then asks `getMyConversation`).
 */
export const readShellBootstrapLookup = (
  selection: ShellBootstrapSelection | undefined,
  lookups: ShellBootstrapLookups | null,
  conversationId: string,
): CloudConversation | null | undefined => {
  if (!selection || !lookups) return undefined;
  if (conversationId === lookups.routeConversationId) {
    return selection.routeConversation;
  }
  if (conversationId === lookups.cachedConversationId) {
    return selection.cachedConversation;
  }
  return undefined;
};
