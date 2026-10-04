import { app } from "electron";
import { loadModelRegistry } from "@stella/contracts/model-registry";
import "@stella/runtime/ai/utils/http-proxy.js";
import { registerBuiltInApiProviders } from "@stella/runtime/ai/providers/register-builtins.js";
import { configureLinuxGraphics } from "./linux-graphics.js";
import { configureLinuxProtectedStorage } from "./linux-protected-storage.js";
import { configureDevHarnessProtectedStorage } from "./bootstrap/dev-harness-protected-storage.js";
import { registerRendererScheme } from "./source/renderer-protocol.js";
import { configureBrowserBridgeNamespace } from "./services/stella-browser-bridge-namespace.js";

// Before anything resolves the browser bridge socket directory (the bridge
// config, the in-app browser endpoint) and before the runtime is spawned with
// this environment: a dev checkout gets its own bridge instead of fighting the
// installed app for the shared one.
configureBrowserBridgeNamespace({ isPackaged: app.isPackaged });

registerRendererScheme();
configureLinuxGraphics({
  commandLine: app.commandLine,
});
const devHarnessProtectedStorage = configureDevHarnessProtectedStorage({
  isPackaged: app.isPackaged,
});
if (!devHarnessProtectedStorage) {
  configureLinuxProtectedStorage({ commandLine: app.commandLine });
}

const main = async () => {
  await loadModelRegistry();
  registerBuiltInApiProviders();
  const { bootstrapMainProcess } = await import("./bootstrap.js");
  bootstrapMainProcess();
};

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
