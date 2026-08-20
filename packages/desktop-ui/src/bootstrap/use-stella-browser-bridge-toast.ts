import { useEffect } from "react";
import { shouldEmitBrowserBridgeGlobalToast } from "@stella/contracts/browser-bridge-status";

export const useStellaBrowserBridgeToast = () => {
  useEffect(() => {
    const browserApi = window.electronAPI?.browser;
    if (!browserApi?.onBridgeStatus) {
      return;
    }

    return browserApi.onBridgeStatus((status) => {
      // Optional bridge absence, disconnect, and retry are never a global
      // toast. Keep this listener so a stale notifyUser flag from older
      // hosts cannot resurrect the old error toast.
      if (!shouldEmitBrowserBridgeGlobalToast(status)) {
        return;
      }
    });
  }, []);
};
