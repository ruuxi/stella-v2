import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
  deleteLocalLlmCredential,
  getLocalLlmCredential,
  saveLocalLlmCredential,
} from "@stella/runtime/kernel/storage/llm-credentials";

const OUTPUT_ARG = "--verify-lifecycle=";
const VERIFICATION_PROVIDER_PREFIX = "lifecycle-verification";

export const runLifecycleVerificationFromArgs = async (
  argv: string[],
): Promise<boolean> => {
  const outputArg = argv.find((value) => value.startsWith(OUTPUT_ARG));
  if (!outputArg) return false;

  const outputPath = outputArg.slice(OUTPUT_ARG.length).trim();
  if (!path.isAbsolute(outputPath)) {
    throw new Error("Lifecycle verification output path must be absolute.");
  }

  // Keep ad-hoc verification builds from sharing a Keychain item with the
  // normally installed app. Production uses the ordinary application name.
  app.setName("Stella Lifecycle Verification");
  await app.whenReady();
  const stellaDataDir =
    process.env.STELLA_DATA_DIR?.trim() || app.getPath("userData");
  const secret = randomBytes(32).toString("base64url");
  const verificationProvider = `${VERIFICATION_PROVIDER_PREFIX}-${randomBytes(8).toString("hex")}`;
  let exitCode = 0;
  let result: Record<string, unknown>;

  try {
    saveLocalLlmCredential(stellaDataDir, {
      provider: verificationProvider,
      label: "Lifecycle verification",
      plaintext: secret,
    });
    const retrieved = getLocalLlmCredential(
      stellaDataDir,
      verificationProvider,
    );
    const removed = deleteLocalLlmCredential(
      stellaDataDir,
      verificationProvider,
    );
    result = {
      ok: retrieved === secret && removed.removed,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath("userData"),
      stellaDataDir,
      protectedStorage: {
        stored: true,
        retrieved: retrieved === secret,
        deleted: removed.removed,
      },
    };
    if (result.ok !== true) {
      exitCode = 1;
    }
  } catch (error) {
    exitCode = 1;
    result = {
      ok: false,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath("userData"),
      stellaDataDir,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deleteLocalLlmCredential(stellaDataDir, verificationProvider);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  app.exit(exitCode);
  return true;
};
