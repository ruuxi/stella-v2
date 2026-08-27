import { useEffect } from "react";
import { shouldEmitBrowserBridgeGlobalToast } from "@stella/contracts/browser-bridge-status";

export const useStellaBrowserBridgeToast = () => {
  useEffect(() => {
    const browserApi = window.electronAPI?.browser;
    if (!browserApi?.onBridgeStatus) {
      return;
    }

    return browserApi.onBridgeStatus((status) => {

      if (!shouldEmitBrowserBridgeGlobalToast(status)) {
        return;
      }
    });
  }, []);
};
