import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { getConvexTokenForSubject } from "@/global/auth/services/auth-token";
import { uiState } from "@/platform/ui-state";
import { cloudHomeApi } from "./cloud-home-api";
import {
  cloudHomeSyncRetryStore,
  cloudHomeSyncStatusStore,
  runCloudHomeSync,
} from "./cloud-home-sync";

const unavailable = (accountScope: string, message: string) =>
  cloudHomeSyncStatusStore.set({
    accountScope,
    phase: "unavailable",
    memoryUploaded: 0,
    memoryCloudWins: 0,
    skillsUploaded: 0,
    skillsCloudWins: 0,
    skipped: 0,
    warnings: [],
    issues: [{ code: "not_available", message }],
  });

/**
 * Passive startup bridge that mirrors this Mac's Cloud Home root into the
 * cloud. Existing divergent cloud heads are never overwritten, and a skill the
 * root has dropped is tombstoned so cloud turns stop loading it; a settings
 * status card exposes conflicts and lets the user retry transient failures.
 */
export function CloudHomeSyncBridge() {
  const convex = useConvex();
  const {
    cloudMode,
    accountScope,
    identityRevision,
    ownerSubject,
  } = useCloudMode();
  const retry = useSyncExternalStore(
    cloudHomeSyncRetryStore.subscribe,
    cloudHomeSyncRetryStore.getSnapshot,
    cloudHomeSyncRetryStore.getServerSnapshot,
  );
  const requests = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (cloudMode) {
      queries.realtime = {
        query: cloudHomeApi.getCloudRealtimeConfig,
        args: {},
      };
    }
    return queries;
  }, [cloudMode]);
  const results = useQueries(requests);
  const identityKey = `${accountScope}:${identityRevision}:${ownerSubject ?? "missing"}`;
  const activeIdentityRef = useRef(identityKey);

  // Clear the old owner's labels before the browser can paint a transition
  // frame. AccountTab independently filters by scope as defense in depth.
  useLayoutEffect(() => {
    activeIdentityRef.current = identityKey;
    cloudHomeSyncStatusStore.reset(cloudMode ? accountScope : null);
  }, [accountScope, cloudMode, identityKey]);

  useEffect(() => {
    if (!cloudMode) {
      cloudHomeSyncStatusStore.reset(null);
      return;
    }
    const cloudHome = window.electronAPI?.cloudHome;
    if (!cloudHome) {
      unavailable(
        accountScope,
        "Local Cloud Home import is available in the Stella desktop app.",
      );
      return;
    }
    const configResult = results.realtime;
    if (configResult === undefined) return;
    if (configResult instanceof Error) {
      unavailable(
        accountScope,
        "Cloud Home is not available in this deployment.",
      );
      return;
    }
    const config = configResult as {
      httpOrigin?: unknown;
      protocol?: unknown;
    };
    if (
      config.protocol !== 1 ||
      typeof config.httpOrigin !== "string" ||
      !config.httpOrigin
    ) {
      unavailable(
        accountScope,
        "Cloud Home is not available in this deployment.",
      );
      return;
    }

    const controller = new AbortController();
    const scopeAtStart = accountScope;
    const identityAtStart = identityKey;
    void (async () => {
      const token = ownerSubject
        ? await getConvexTokenForSubject(ownerSubject)
        : null;
      if (
        controller.signal.aborted ||
        activeIdentityRef.current !== identityAtStart
      ) {
        return;
      }
      if (!token) {
        unavailable(scopeAtStart, "Sign in again to synchronize Cloud Home.");
        return;
      }
      await runCloudHomeSync({
        accountScope: scopeAtStart,
        expectedSubject: ownerSubject!,
        builderOrigin: config.httpOrigin as string,
        token,
        scanLocal: () => cloudHome.scanLocal(scopeAtStart),
        readImportOwnership: cloudHome.getImportOwnership,
        readSkillHeads: async () =>
          await convex.query(cloudHomeApi.listMySkillHeads, {
            clientScope: scopeAtStart,
          }),
        deleteSkillMirror: async ({ slug, expectedRevision }) =>
          await convex.mutation(cloudHomeApi.deleteMyMirroredSkill, {
            clientScope: scopeAtStart,
            slug,
            expectedRevision,
          }),
        cursorStore: uiState,
        signal: controller.signal,
        onStatus: (status) => {
          if (
            !controller.signal.aborted &&
            activeIdentityRef.current === identityAtStart
          ) {
            cloudHomeSyncStatusStore.set(status);
          }
        },
      });
    })().catch(() => {
      if (
        !controller.signal.aborted &&
        activeIdentityRef.current === identityAtStart
      ) {
        unavailable(
          scopeAtStart,
          "Cloud Home could not be synchronized. Try again.",
        );
      }
    });
    return () => controller.abort();
  }, [
    accountScope,
    cloudMode,
    convex,
    identityKey,
    ownerSubject,
    results.realtime,
    retry,
  ]);

  return null;
}
