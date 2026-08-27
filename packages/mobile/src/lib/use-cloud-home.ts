import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  MobileCloudHomeError,
  createMobileCloudHomeClient,
  type MobileCloudHomeClientIdentity,
  type MobileCloudMemoryWrite,
} from "./cloud-home";
import { getConvexTokenForOwner } from "./auth-token";
import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import { useConvexTokenOwner } from "./use-convex-token-owner";

const realtimeConfigRef = makeFunctionReference<
  "query",
  Record<string, never>,
  {
    httpOrigin: string | null;
    socketOrigin: string | null;
    protocol: number;
  }
>("cloud_apps:getCloudRealtimeConfig");

/** Authenticated mobile list/read/write surface for a Memory settings editor. */
export const useMobileCloudHome = (
  identity: CloudConversationIdentity | null,
) => {
  const config = useQuery(realtimeConfigRef, {});
  const tokenOwner = useConvexTokenOwner(identity);
  const boundIdentity = useMemo(() => {
    const owner = tokenOwner.identity;
    if (!owner) return null;
    return Object.freeze({
      requestIdentity: Object.freeze({
        accountScope: owner.accountScope,
        identityKey: owner.identityKey,
        identityRevision: owner.identityRevision,
        expectedSubject: owner.expectedSubject,
      }) satisfies MobileCloudHomeClientIdentity,
      tokenSubject: owner.userSubject,
    });
  }, [tokenOwner.identity]);
  const committedIdentityRef = useRef<MobileCloudHomeClientIdentity | null>(
    boundIdentity?.requestIdentity ?? null,
  );
  useLayoutEffect(() => {
    const committed = boundIdentity?.requestIdentity ?? null;
    committedIdentityRef.current = committed;
    return () => {
      if (committedIdentityRef.current === committed) {
        committedIdentityRef.current = null;
      }
    };
  }, [boundIdentity]);
  const client = useMemo(() => {
    if (!boundIdentity || config?.protocol !== 1 || !config.httpOrigin) {
      return null;
    }
    try {
      return createMobileCloudHomeClient({
        builderOrigin: config.httpOrigin,
        identity: boundIdentity.requestIdentity,
        getCurrentIdentity: () => committedIdentityRef.current,
        getToken: () =>
          getConvexTokenForOwner(
            boundIdentity.tokenSubject,
            boundIdentity.requestIdentity.expectedSubject,
          ),
      });
    } catch {
      // A malformed/non-TLS origin is a deployment capability problem. Keep it
      // in the explicit unavailable state instead of throwing during render.
      return null;
    }
  }, [boundIdentity, config?.httpOrigin, config?.protocol]);
  const listMemory = useCallback(async () => {
    if (!client) throw new MobileCloudHomeError("unavailable");
    return await client.listMemory();
  }, [client]);
  const readMemory = useCallback(
    async (name: string) => {
      if (!client) throw new MobileCloudHomeError("unavailable");
      return await client.readMemory(name);
    },
    [client],
  );
  const writeMemory = useCallback(
    async (input: MobileCloudMemoryWrite) => {
      if (!client) throw new MobileCloudHomeError("unavailable");
      return await client.writeMemory(input);
    },
    [client],
  );
  return {
    available: Boolean(client),
    loading: config === undefined || tokenOwner.loading,
    unavailable:
      config !== undefined && !tokenOwner.loading && Boolean(!client),
    listMemory,
    readMemory,
    writeMemory,
  };
};
