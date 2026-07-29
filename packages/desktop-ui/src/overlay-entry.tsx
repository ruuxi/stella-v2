import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { OverlayRoot } from "./shell/overlay/OverlayRoot";
import { DeferredVoiceRuntime } from "./features/voice/runtime/DeferredVoiceRuntime";
import { ToastProvider } from "./ui/toast";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";

applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "overlay";

const OverlayMountedSignal = () => {
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get(
      "rendererReadiness",
    );
    if (token) window.electronAPI?.ui.setRendererMounted?.("overlay", token);
  }, []);
  return null;
};

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <ThemeProvider>
      <ToastProvider>
        <UiStateProvider>
          <DeferredVoiceRuntime />
          <OverlayMountedSignal />
          <OverlayRoot />
        </UiStateProvider>
      </ToastProvider>
    </ThemeProvider>
  </ErrorBoundary>,
);
