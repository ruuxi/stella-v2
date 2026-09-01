import path from "node:path";
import { app } from "electron";
import { RemoteTelemetryClient } from "@stella/runtime/observability/remote-telemetry";
import {
  telemetryHttpEndpoint,
  telemetryHttpEnvironment,
} from "@stella/runtime/observability/telemetry-endpoints";

type MainTelemetryOptions = {
  stellaDataDirPath: string;
  isDev: boolean;
  getAuthToken: () => Promise<string | null>;
};

/**
 * Initialize metadata-only remote telemetry in Electron main. Network and
 * spool work deliberately stay outside the renderer's 16ms frame budget.
 */
export const initMainProcessTelemetry = (options: MainTelemetryOptions) => {
  const environment = telemetryHttpEnvironment(options.isDev);
  const endpoint = telemetryHttpEndpoint(environment);
  const client = new RemoteTelemetryClient({
    spoolPath: path.join(
      options.stellaDataDirPath,
      "telemetry",
      "desktop-main-v1.jsonl",
    ),
    getContext: () => ({
      environment,
      source: "desktop-main",
      release: app.getVersion(),
    }),
    getTransportConfig: async () => {
      const authToken = (await options.getAuthToken())?.trim();
      return authToken ? { endpoint, authToken } : null;
    },
  });

  void client.record({
    type: "app.lifecycle",
    component: "desktop-main",
    phase: "starting",
  });
  app.on("ready", () => {
    const startupMs = Math.max(0, Math.round(process.uptime() * 1_000));
    void client.record({
      type: "app.lifecycle",
      component: "desktop-main",
      phase: "ready",
      durationMs: startupMs,
    });
    void client.record({
      type: "app.performance",
      component: "desktop-main",
      metric: "startup",
      durationMs: startupMs,
      outcome: "success",
    });
  });
  app.on("child-process-gone", (_event, details) => {
    void client.record({
      type: "app.error",
      component: "desktop-main",
      severity: "error",
      errorClass: "ElectronChildProcessGone",
      errorCode: details.reason,
      recovered: false,
    });
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    void client.record({
      type: "app.error",
      component: "desktop-renderer",
      severity: "error",
      errorClass: "ElectronRenderProcessGone",
      errorCode: details.reason,
      recovered: false,
    });
  });

  return client;
};
