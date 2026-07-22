import { app, dialog, globalShortcut } from "electron";
import path from "node:path";
import { applyDockIcon } from "../app-icon.js";
import type { BootstrapContext } from "./context.js";
import { shutdownBootstrapRuntime } from "./resets.js";
import { initializeBootstrapApplication } from "./runtime.js";

export const initializeBootstrapSingleInstance = (
  context: BootstrapContext,
) => {
  context.services.authService.bindSingleInstanceHandler();
  context.services.authService.bindOpenUrlHandler();
};

export const registerBootstrapLifecycle = (context: BootstrapContext) => {
  let quitAfterCleanup = false;

  const handleFatalStartupFailure = async (error: unknown) => {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
        : String(error);

    console.error("Fatal startup failure:", error);
    try {
      const result = await dialog.showMessageBox({
        type: "error",
        buttons: ["Relaunch", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Stella",
        message: "Stella could not finish starting.",
        detail:
          `Startup failed before the app UI could load.\n\n${detail}`.slice(
            0,
            12_000,
          ),
      });

      if (result.response === 0) {
        app.relaunch();
        app.quit();
        return;
      }

      app.quit();
    } catch (dialogError) {
      console.error("Failed to show startup failure dialog:", dialogError);
      app.quit();
    }
  };

  context.state.processRuntime.registerCleanup(
    "will-quit",
    "global-shortcuts",
    () => {
      globalShortcut.unregisterAll();
    },
  );
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "radial-gesture-service",
    () => {
      context.services.radialGestureService.stop();
    },
  );
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "local-chat-history-service",
    () => {
      context.services.localChatHistoryService.close();
    },
  );
  context.state.processRuntime.registerCleanup(
    "will-quit",
    "bootstrap-runtime",
    async () => {
      await shutdownBootstrapRuntime(context, { stopScheduler: true });
    },
  );

  app.on("activate", () => {
    context.state.windowManager?.onActivate();
  });

  app
    .whenReady()
    .then(async () => {
      if (app.isPackaged) {
        process.env.STELLA_APP_RESOURCES_PATH = process.resourcesPath;
        process.env.STELLA_BUN_PATH = path.join(
          process.resourcesPath,
          "bin",
          process.platform === "win32" ? "bun.exe" : "bun",
        );
      }
      if (process.platform === "darwin") {
        app.dock?.show();
      }
      applyDockIcon(context.config.electronDir);
      await initializeBootstrapApplication(context);
    })
    .catch((error) => {
      void handleFatalStartupFailure(error);
    });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitAfterCleanup) {
      return;
    }

    event.preventDefault();
    context.state.isQuitting = true;

    void (async () => {
      await context.state.processRuntime.runPhase("before-quit");
      await context.state.processRuntime.runPhase("will-quit");
      quitAfterCleanup = true;
      // Electron patches process.exit through its app lifecycle; native
      // modules can therefore keep it alive after the quit event. Every
      // managed service and child has completed cleanup above, so call Node's
      // final exit primitive and preserve a clean status code.
      (
        process as NodeJS.Process & { reallyExit: (code?: number) => never }
      ).reallyExit(0);
    })();
  });
};
