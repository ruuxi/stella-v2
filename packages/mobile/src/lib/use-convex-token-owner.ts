import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getConvexTokenOwnerForSubject } from "./auth-token";
import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import {
  isConvexTokenOwnerFenceCurrent,
  type ConvexTokenOwnerFence,
} from "./convex-token-owner";

type OwnerSource = ConvexTokenOwnerFence;

export type MobileConvexOwnerIdentity = OwnerSource &
  Readonly<{
    /** Exact `${JWT.iss}|${JWT.sub}` checked and echoed by owner APIs. */
    expectedSubject: string;
  }>;

type OwnerResolutionState = Readonly<{
  source: OwnerSource | null;
  identity: MobileConvexOwnerIdentity | null;
  failed: boolean;
}>;

/**
 * Resolves the issuer-qualified owner from the current authenticated JWT.
 * Every async result is fenced by the immutable account/session revision that
 * requested it, so an A-token can never become B-labelled request authority.
 */
export const useConvexTokenOwner = (
  identity: CloudConversationIdentity | null,
): {
  identity: MobileConvexOwnerIdentity | null;
  loading: boolean;
  unavailable: boolean;
} => {
  const accountScope = identity?.accountScope ?? null;
  const identityKey = identity?.identityKey ?? null;
  const identityRevision = identity?.revision ?? null;
  const userSubject = identity?.expectedSubject ?? null;
  const source = useMemo<OwnerSource | null>(
    () =>
      accountScope !== null &&
      identityKey !== null &&
      identityRevision !== null &&
      userSubject !== null
        ? Object.freeze({
            accountScope,
            identityKey,
            identityRevision,
            userSubject,
          })
        : null,
    [accountScope, identityKey, identityRevision, userSubject],
  );
  const committedSourceRef = useRef<OwnerSource | null>(source);
  const [state, setState] = useState<OwnerResolutionState>(() => ({
    source: null,
    identity: null,
    failed: false,
  }));

  useLayoutEffect(() => {
    committedSourceRef.current = source;
    return () => {
      if (isConvexTokenOwnerFenceCurrent(committedSourceRef.current, source)) {
        committedSourceRef.current = null;
      }
    };
  }, [source]);

  useEffect(() => {
    const requestedBy = source;
    if (!requestedBy) {
      setState({ source: null, identity: null, failed: false });
      return;
    }
    let cancelled = false;
    setState({ source: requestedBy, identity: null, failed: false });
    void getConvexTokenOwnerForSubject(requestedBy.userSubject).then(
      (owner) => {
        if (
          cancelled ||
          !isConvexTokenOwnerFenceCurrent(
            requestedBy,
            committedSourceRef.current,
          )
        ) {
          return;
        }
        setState({
          source: requestedBy,
          identity: Object.freeze({
            ...requestedBy,
            expectedSubject: owner.tokenIdentifier,
          }),
          failed: false,
        });
      },
      () => {
        if (
          cancelled ||
          !isConvexTokenOwnerFenceCurrent(
            requestedBy,
            committedSourceRef.current,
          )
        ) {
          return;
        }
        setState({ source: requestedBy, identity: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  const stateIsCurrent = isConvexTokenOwnerFenceCurrent(state.source, source);
  return {
    identity: stateIsCurrent ? state.identity : null,
    loading: Boolean(
      source && (!stateIsCurrent || (!state.identity && !state.failed)),
    ),
    unavailable: Boolean(source && stateIsCurrent && state.failed),
  };
};
