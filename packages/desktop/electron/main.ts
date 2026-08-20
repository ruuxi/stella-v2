import { app } from "electron";
import { runLifecycleVerificationFromArgs } from "./lifecycle-verification.js";
import { configureLinuxGraphics } from "./linux-graphics.js";
import { configureLinuxProtectedStorage } from "./linux-protected-storage.js";

configureLinuxGraphics({
  disableHardwareAcceleration: () => app.disableHardwareAcceleration(),
});
configureLinuxProtectedStorage({ commandLine: app.commandLine });

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
