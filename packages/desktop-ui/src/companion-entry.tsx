import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { LocalI18nProvider } from "./shared/i18n/I18nProvider";
import { ToastProvider } from "./ui/toast";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";
import { CompanionRoot } from "./shell/companion/CompanionRoot";

/**
 * Companion window entry — the floating desktop Stella.
 *
 * Deliberately tiny: no router, no chat runtime, no auth provider. The full
 * shell renderer owns the conversation and publishes a small snapshot over
 * IPC; this window only draws the mark, a mini composer, and the last reply.
 */
applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "companion";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LocalI18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <UiStateProvider>
            <CompanionRoot />
          </UiStateProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocalI18nProvider>
  </ErrorBoundary>,
);
