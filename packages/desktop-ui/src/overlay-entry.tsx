import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { OverlayRoot } from "./shell/overlay/OverlayRoot";
import { DeferredVoiceRuntime } from "./features/voice/runtime/DeferredVoiceRuntime";
import { LocalI18nProvider } from "./shared/i18n/I18nProvider";
import { ToastProvider } from "./ui/toast";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";

applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "overlay";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LocalI18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <UiStateProvider>
            <DeferredVoiceRuntime />
            <OverlayRoot />
          </UiStateProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocalI18nProvider>
  </ErrorBoundary>,
);
