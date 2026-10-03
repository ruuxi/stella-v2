import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/styles/app-components.css";
import "./shared/i18n/rtl.css";

import "./platform/dev/vite-error-recovery";
import "./shared/lib/interface-preferences";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";
import "./shared/lib/native-font-smoothing";
import { installRendererErrorReporting } from "./platform/diagnostics/report-error";
import { App } from "./App.tsx";
import { AppProviders } from "./context/AppProviders";
import { BackendAuthProvider } from "./global/auth/BackendAuthProvider";
import { prefetchAuthSessionBeforeRender } from "./global/auth/services/auth-session";
import { ErrorBoundary } from "./shell/ErrorBoundary";

applyLowPowerDocumentFlag();
installRendererErrorReporting();
prefetchAuthSessionBeforeRender();
if (import.meta.env.VITE_STELLA_WEB_BUILD === "1") {
  void import("./platform/web-renderer-switch").then((module) =>
    module.startWebRendererSwitch(),
  );
}

document.documentElement.dataset.stellaWindow = "full";

const appTree = (
  <ErrorBoundary>
    <BackendAuthProvider enableRuntimeEffects>
      <AppProviders>
        <App />
      </AppProviders>
    </BackendAuthProvider>
  </ErrorBoundary>
);

createRoot(document.getElementById("root")!).render(appTree);
