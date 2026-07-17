import { app } from "electron";
import { runLocalUpdateVerificationFromArgs } from "./updates/local-update-verification.js";

void runLocalUpdateVerificationFromArgs(process.argv).catch((error) => {
  console.error(error);
  app.exit(1);
});
