import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { authClient } from "./auth-client";
import {
  observeAuthIdentityRevision,
  resolveAuthSessionCacheScope,
  resolveCloudConversationIdentityGate,
} from "./auth-identity";
import { cloudConversationApi } from "./cloud-conversation-api";
import {
  getOrCreateCloudConversationCreateId,
  readActiveCloudConversationId,
  resolveOwnedCloudConversation,
  resolveOwnershipMigrationGate,
  rotateCloudConversationCreateId,
  writeActiveCloudConversationId,
  type CloudConversation,
} from "./cloud-conversation-state";
import { resetCloudConversationAccountScope } from "./cloud-conversation-store";

type ScopedConversationId = {
  accountScope: string;
  conversationId: string | null;
  loaded: boolean;
};

export type CloudConversationController = {
  accountScope: string;
  /** Exact Convex identity and ownership migration are both resolved. */
  canUseOwnerData: boolean;
  conversation: CloudConversation | null;
  conversations: CloudConversation[];
  isLoading: boolean;
  isMigrationPending: boolean;
  migrationError: string | null;
  createError: string | null;
  selectConversation(conversationId: string): void;
  retryCreate(): void;
  retryMigration(): void;
};

const CloudConversationContext =
  createContext<CloudConversationController | null>(null);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function CloudConversationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const session = authClient.useSession();
  const convexAuth = useConvexAuth();
  const accountScope = resolveAuthSessionCacheScope(session.data);
  const ownerId = session.data?.user?.id?.trim() ?? "";
  const identityRevision = observeAuthIdentityRevision(session.data).revision;
  const shouldConfirmIdentity =
    Boolean(ownerId) &&
    !session.isPending &&
    !convexAuth.isLoading &&
    convexAuth.isAuthenticated;
  const identityConfirmed = useQuery(
    cloudConversationApi.confirmMySessionIdentity,
    shouldConfirmIdentity
      ? {
          expectedSubject: ownerId,
          identityRevision,
        }
      : "skip",
  );
  const identityGate = resolveCloudConversationIdentityGate({
    expectedSubject: ownerId,
    sessionIsPending: session.isPending,
    convexIsLoading: convexAuth.isLoading,
    convexIsAuthenticated: convexAuth.isAuthenticated,
    identityConfirmed: identityConfirmed === true,
  });
  const cloudMode = identityGate.canUseOwnerData;

  const ownershipMigration = useQuery(
    cloudConversationApi.getMyOwnershipMigrationStatus,
    cloudMode ? {} : "skip",
  );
  const migrationGate = resolveOwnershipMigrationGate(
    ownershipMigration === undefined
      ? undefined
      : (ownershipMigration?.status ?? null),
    cloudMode,
  );
  const conversations = useQuery(
    cloudConversationApi.listMyConversations,
    cloudMode && migrationGate.canSelectConversation ? {} : "skip",
  );
  const createConversation = useMutation(
    cloudConversationApi.createMyConversation,
  );
  const retryMigrationMutation = useMutation(
    cloudConversationApi.retryMyLatestFailedOwnershipMigration,
  );

  const [cachedSelection, setCachedSelection] = useState<ScopedConversationId>({
    accountScope: "signed-out",
    conversationId: null,
    loaded: false,
  });
  const [justCreated, setJustCreated] = useState<{
    accountScope: string;
    conversation: CloudConversation;
  } | null>(null);
  const [createError, setCreateError] = useState<{
    accountScope: string;
    message: string;
  } | null>(null);
  const [migrationRetryError, setMigrationRetryError] = useState<{
    accountScope: string;
    message: string;
  } | null>(null);
  const [createRetrySignal, setCreateRetrySignal] = useState(0);
  const createInFlightRef = useRef<string | null>(null);
  const accountScopeRef = useRef(accountScope);
  const previousAccountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;

  useEffect(() => {
    const previous = previousAccountScopeRef.current;
    previousAccountScopeRef.current = accountScope;
    if (previous !== accountScope) {
      resetCloudConversationAccountScope(previous);
    }
  }, [accountScope]);

  useEffect(() => {
    setCachedSelection({
      accountScope,
      conversationId: null,
      loaded: false,
    });
    setJustCreated(null);
    setCreateError(null);
    setMigrationRetryError(null);
    createInFlightRef.current = null;
    if (!cloudMode) return;

    let cancelled = false;
    void readActiveCloudConversationId(AsyncStorage, accountScope)
      .then((conversationId) => {
        if (cancelled) return;
        setCachedSelection({
          accountScope,
          conversationId,
          loaded: true,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setCachedSelection({
          accountScope,
          conversationId: null,
          loaded: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [accountScope, cloudMode]);

  const scopedCache =
    cachedSelection.accountScope === accountScope
      ? cachedSelection
      : {
          accountScope,
          conversationId: null,
          loaded: false,
        };
  // These are authenticated owner-scoped functions. Their ownerId field is a
  // Convex token identifier, not the raw Better Auth user id used by our local
  // cache scope.
  const ownerConversations = useMemo(
    () => conversations ?? [],
    [conversations],
  );
  const cachedConversationIsListed = Boolean(
    scopedCache.conversationId &&
    ownerConversations.some(
      (conversation) =>
        conversation.conversationId === scopedCache.conversationId,
    ),
  );
  const exactCachedConversation = useQuery(
    cloudConversationApi.getMyConversation,
    cloudMode &&
      migrationGate.canSelectConversation &&
      scopedCache.loaded &&
      scopedCache.conversationId &&
      !cachedConversationIsListed
      ? { conversationId: scopedCache.conversationId }
      : "skip",
  );
  const exactCacheIsLoading = Boolean(
    cloudMode &&
    migrationGate.canSelectConversation &&
    scopedCache.loaded &&
    scopedCache.conversationId &&
    !cachedConversationIsListed &&
    exactCachedConversation === undefined,
  );
  const scopedCreated =
    justCreated?.accountScope === accountScope
      ? justCreated.conversation
      : null;
  const conversation = migrationGate.canSelectConversation
    ? resolveOwnedCloudConversation({
        conversations: ownerConversations,
        exactCachedConversation: exactCachedConversation ?? null,
        cachedConversationId: scopedCache.conversationId,
        justCreatedConversation: scopedCreated,
      })
    : null;

  useEffect(() => {
    if (
      !migrationGate.canSelectConversation ||
      conversations === undefined ||
      !scopedCache.loaded ||
      exactCacheIsLoading ||
      conversation ||
      createError?.accountScope === accountScope ||
      createInFlightRef.current === accountScope
    ) {
      return;
    }

    createInFlightRef.current = accountScope;
    void getOrCreateCloudConversationCreateId(
      AsyncStorage,
      accountScope,
      Crypto.randomUUID,
    )
      .then((id) => {
        return createConversation({ clientCreateId: id });
      })
      .then((created) => {
        if (accountScopeRef.current !== accountScope) {
          return;
        }
        setJustCreated({ accountScope, conversation: created });
        setCachedSelection({
          accountScope,
          conversationId: created.conversationId,
          loaded: true,
        });
        // The server create already succeeded. A local persistence failure
        // must not advertise a failed create or dispatch a second mutation;
        // retaining the old create id makes a later retry converge on the same
        // server row.
        void writeActiveCloudConversationId(
          AsyncStorage,
          accountScope,
          created.conversationId,
        )
          .then(() =>
            rotateCloudConversationCreateId(
              AsyncStorage,
              accountScope,
              Crypto.randomUUID,
            ),
          )
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (accountScopeRef.current !== accountScope) return;
        setCreateError({
          accountScope,
          message: errorMessage(
            error,
            "Stella couldn't create a cloud conversation.",
          ),
        });
      })
      .finally(() => {
        if (createInFlightRef.current === accountScope) {
          createInFlightRef.current = null;
        }
      });
  }, [
    accountScope,
    conversation,
    conversations,
    createConversation,
    createError,
    createRetrySignal,
    exactCacheIsLoading,
    migrationGate.canSelectConversation,
    scopedCache.loaded,
  ]);

  useEffect(() => {
    if (
      !conversation ||
      scopedCache.conversationId === conversation.conversationId
    ) {
      return;
    }
    setCachedSelection({
      accountScope,
      conversationId: conversation.conversationId,
      loaded: true,
    });
    void writeActiveCloudConversationId(
      AsyncStorage,
      accountScope,
      conversation.conversationId,
    );
  }, [accountScope, conversation, scopedCache.conversationId]);

  const selectConversation = useCallback(
    (conversationId: string) => {
      const selected = ownerConversations.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (!selected) return;
      setCachedSelection({
        accountScope,
        conversationId,
        loaded: true,
      });
      void writeActiveCloudConversationId(
        AsyncStorage,
        accountScope,
        conversationId,
      );
    },
    [accountScope, ownerConversations],
  );

  const retryCreate = useCallback(() => {
    setCreateError(null);
    setCreateRetrySignal((signal) => signal + 1);
  }, []);

  const retryMigration = useCallback(() => {
    setMigrationRetryError(null);
    void retryMigrationMutation({})
      .then(({ scheduled }) => {
        if (!scheduled) {
          setMigrationRetryError({
            accountScope,
            message:
              "Stella couldn't find the failed account transfer to retry.",
          });
        }
      })
      .catch((error: unknown) => {
        setMigrationRetryError({
          accountScope,
          message: errorMessage(
            error,
            "Stella couldn't retry the account transfer.",
          ),
        });
      });
  }, [accountScope, retryMigrationMutation]);

  const isLoading =
    identityGate.isLoading ||
    (cloudMode &&
      (migrationGate.isLoading ||
        migrationGate.isPending ||
        (migrationGate.canSelectConversation &&
          (conversations === undefined ||
            !scopedCache.loaded ||
            exactCacheIsLoading ||
            (!conversation && createError?.accountScope !== accountScope)))));
  const value = useMemo<CloudConversationController>(
    () => ({
      accountScope,
      canUseOwnerData: cloudMode && migrationGate.canSelectConversation,
      conversation,
      conversations: ownerConversations,
      isLoading,
      isMigrationPending: migrationGate.isPending,
      migrationError:
        migrationRetryError?.accountScope === accountScope
          ? migrationRetryError.message
          : migrationGate.isFailed
            ? (ownershipMigration?.error ??
              "Stella couldn't finish moving this anonymous conversation.")
            : null,
      createError:
        createError?.accountScope === accountScope ? createError.message : null,
      selectConversation,
      retryCreate,
      retryMigration,
    }),
    [
      accountScope,
      cloudMode,
      conversation,
      createError,
      isLoading,
      migrationGate.isFailed,
      migrationGate.isPending,
      migrationGate.canSelectConversation,
      migrationRetryError,
      ownerConversations,
      ownershipMigration?.error,
      retryCreate,
      retryMigration,
      selectConversation,
    ],
  );

  return (
    <CloudConversationContext.Provider value={value}>
      {children}
    </CloudConversationContext.Provider>
  );
}

export function useCloudConversationController(): CloudConversationController {
  const value = useContext(CloudConversationContext);
  if (!value) {
    throw new Error(
      "useCloudConversationController must be used inside CloudConversationProvider.",
    );
  }
  return value;
}
