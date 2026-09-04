import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { LocalI18nProvider } from "./shared/i18n/I18nProvider";
import { ToastProvider } from "./ui/toast";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";
import { CompanionMarkRoot } from "./shell/companion/CompanionMarkRoot";
import { CompanionPanelRoot } from "./shell/companion/CompanionPanelRoot";

/**
 * Companion window entry — the floating desktop Stella.
 *
 * One entry serves both companion windows: `?window=companion` is the small
 * mark window, `?window=companion-panel` the fixed-size panel behind it.
 * Deliberately tiny: no router, no chat runtime, no auth provider. The full
 * shell renderer owns the conversation and publishes a small snapshot over
 * IPC; these windows only draw the mark, a mini composer, and the last reply.
 */
applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "companion";

const kind =
  new URLSearchParams(window.location.search).get("window") ===
  "companion-panel"
    ? "panel"
    : "mark";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LocalI18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <UiStateProvider>
            {kind === "panel" ? <CompanionPanelRoot /> : <CompanionMarkRoot />}
          </UiStateProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocalI18nProvider>
  </ErrorBoundary>,
);
