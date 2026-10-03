import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getTokenOwnerForSubject } from "./auth-token";
import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import {
  isTokenOwnerFenceCurrent,
  type TokenOwnerFence,
} from "./token-owner";

type OwnerSource = TokenOwnerFence;

export type MobileOwnerIdentity = OwnerSource &
  Readonly<{
    /** The JWT `sub`, checked and echoed by owner APIs. */
    expectedSubject: string;
  }>;

type OwnerResolutionState = Readonly<{
  source: OwnerSource | null;
  identity: MobileOwnerIdentity | null;
  failed: boolean;
}>;

/**
 * Resolves the owner (JWT `sub`) from the current authenticated JWT.
 * Every async result is fenced by the immutable account/session revision that
 * requested it, so an A-token can never become B-labelled request authority.
 */
export const useTokenOwner = (
  identity: CloudConversationIdentity | null,
): {
  identity: MobileOwnerIdentity | null;
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
      if (isTokenOwnerFenceCurrent(committedSourceRef.current, source)) {
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
    void getTokenOwnerForSubject(requestedBy.userSubject).then(
      (owner) => {
        if (
          cancelled ||
          !isTokenOwnerFenceCurrent(
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
            expectedSubject: owner.subject,
          }),
          failed: false,
        });
      },
      () => {
        if (
          cancelled ||
          !isTokenOwnerFenceCurrent(
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

  const stateIsCurrent = isTokenOwnerFenceCurrent(state.source, source);
  return {
    identity: stateIsCurrent ? state.identity : null,
    loading: Boolean(
      source && (!stateIsCurrent || (!state.identity && !state.failed)),
    ),
    unavailable: Boolean(source && stateIsCurrent && state.failed),
  };
};
