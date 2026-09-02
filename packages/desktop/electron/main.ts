import { app } from "electron";
import "@stella/runtime/ai/utils/http-proxy.js";
import { registerBuiltInApiProviders } from "@stella/runtime/ai/providers/register-builtins.js";
import { runLifecycleVerificationFromArgs } from "./lifecycle-verification.js";
import { configureLinuxGraphics } from "./linux-graphics.js";
import { configureLinuxProtectedStorage } from "./linux-protected-storage.js";
import { configureDevHarnessProtectedStorage } from "./bootstrap/dev-harness-protected-storage.js";

registerBuiltInApiProviders();

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
  if (await runLifecycleVerificationFromArgs(process.argv)) {
    return;
  }
  const { bootstrapMainProcess } = await import("./bootstrap.js");
  bootstrapMainProcess();
};

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
