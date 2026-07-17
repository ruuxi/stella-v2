import { app } from "electron";
import { runLifecycleVerificationFromArgs } from "./lifecycle-verification.js";
import { runLocalUpdateVerificationFromArgs } from "./updates/local-update-verification.js";

const main = async () => {
  if (await runLifecycleVerificationFromArgs(process.argv)) {
    return;
  }
  if (await runLocalUpdateVerificationFromArgs(process.argv)) {
    return;
  }
  const { bootstrapMainProcess } = await import("./bootstrap.js");
  bootstrapMainProcess();
};

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
