import { useEffect, useRef } from "react";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { publishCloudExecutionSelection } from "./cloud-execution-store";
import {
  cloudExecutionFromLocal,
  localPatchForCloudExecution,
  sameCloudExecution,
  type MirroredModelPreferences,
} from "./cloud-model-selection-mirror";

const LOCAL_PREFERENCES_CHANGED_EVENT = "stella:local-model-preferences-changed";

const readLocal = async (): Promise<MirroredModelPreferences | null> =>
  (await window.electronAPI?.system?.getLocalModelPreferences?.()) ?? null;

/**
 * Keeps the desktop's local model preferences in step with the account's
 * server selection, which phone and web pickers write. A server change is
 * applied locally; a local pick is saved to the server. Before the account has
 * ever saved one, the desktop's current choice seeds it.
 */
export function CloudModelSelectionBridge() {
  const { isAuthenticated } = useAuthState();
  const hasLocalRuntime = Boolean(
    window.electronAPI?.system?.setLocalModelPreferences,
  );
  const connections = useCloudEngines(isAuthenticated && hasLocalRuntime);
  const serverRef = useRef<CloudExecutionSelection | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const execution = connections?.execution;
  const selectedAt = connections?.selectedAt;
  const loaded = connections !== undefined;

  // Serialize every mirror step so a slow IPC can't apply an older selection
  // after a newer one.
  const enqueue = (step: () => Promise<void>) => {
    queue.current = queue.current.then(step).catch(() => undefined);
  };

  const pushLocal = (local: MirroredModelPreferences) => {
    const derived = cloudExecutionFromLocal(local);
    const server = serverRef.current;
    if (!derived || (server && sameCloudExecution(derived, server))) return;
    serverRef.current = derived;
    publishCloudExecutionSelection(derived);
    return cloudEnginesApi.setExecution(derived);
  };

  useEffect(() => {
    if (!loaded || !execution) return;
    enqueue(async () => {
      const local = await readLocal();
      if (!local) return;
      if (selectedAt === null) {
        // Nothing saved on the account yet: the desktop's choice seeds it.
        await pushLocal(local);
        return;
      }
      serverRef.current = execution;
      const current = cloudExecutionFromLocal(local);
      if (current && sameCloudExecution(current, execution)) return;
      await window.electronAPI?.system?.setLocalModelPreferences?.(
        localPatchForCloudExecution(local, execution),
      );
      window.dispatchEvent(new CustomEvent(LOCAL_PREFERENCES_CHANGED_EVENT));
    });
    // The selection's identity is the trigger; helpers read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loaded,
    selectedAt,
    execution?.engine,
    execution?.model,
    execution?.reasoningEffort,
  ]);

  useEffect(() => {
    if (!loaded) return;
    const onLocalChange = () => {
      enqueue(async () => {
        const local = await readLocal();
        if (local) await pushLocal(local);
      });
    };
    window.addEventListener(LOCAL_PREFERENCES_CHANGED_EVENT, onLocalChange);
    return () =>
      window.removeEventListener(LOCAL_PREFERENCES_CHANGED_EVENT, onLocalChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return null;
}
