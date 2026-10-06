import { useEffect } from "react";
import { AppBootstrap } from "./bootstrap/AppBootstrap";
import { ChatStoreProvider } from "@/context/chat-store";
import { CredentialRequestLayer } from "./global/auth/CredentialRequestLayer";
import { RemoteExecutionConsentLayer } from "./global/execution/RemoteExecutionConsentLayer";
import { FullShell } from "./shell/FullShell";
import { CloudHomeSyncBridge } from "./features/cloud/CloudHomeSyncBridge";
import { CloudMemoryPreferenceBridge } from "./features/cloud/CloudMemoryPreferenceBridge";
import { CloudModelSelectionBridge } from "./features/cloud/CloudModelSelectionBridge";
import { platformCapabilities } from "./platform/capabilities";

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

// Every passive IPC listener below mounts eagerly because main fires the
// matching channels fire-and-forget — if the renderer isn't subscribed at the
// moment of `webContents.send(...)`, the event is silently dropped:
//   * CredentialRequestLayer  → `credential:request` (agent stalls 5 min on
//     timeout, see `desktop/electron/services/credential-service.ts`)
//     (stella-connect CLI hangs on the bridge until the user submits)
//   * RemoteExecutionConsentLayer → `execution:remoteExecutionRequest` (the
//     owner gate asked this computer whether work may run here; a dropped
//     question looks like a machine that was never asked)
// Bundle savings from lazy-loading these were negligible (every dep is in the
// eager chunk anyway), and the cost of missing the event is high.
function App() {
  useEffect(() => {
    if (!platformCapabilities.nativeBridges) return;
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      <div className="app window-full">
        <ChatStoreProvider>
          <AppBootstrap />
          <CloudMemoryPreferenceBridge />
          {platformCapabilities.nativeBridges ? (
            <CloudModelSelectionBridge />
          ) : null}
          <CloudHomeSyncBridge />
          {platformCapabilities.nativeBridges ? (
            <CredentialRequestLayer />
          ) : null}
          {platformCapabilities.nativeBridges ? (
            <RemoteExecutionConsentLayer />
          ) : null}
          <FullShell />
        </ChatStoreProvider>
      </div>
    </>
  );
}

export { App };
