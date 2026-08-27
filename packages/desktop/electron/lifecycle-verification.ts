import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
  deleteLocalLlmCredential,
  getLocalLlmCredential,
  saveLocalLlmCredential,
} from "@stella/runtime/kernel/storage/llm-credentials";
import {
  downloadLocalParakeet,
  stopLocalParakeet,
  warmLocalParakeet,
} from "./dictation/local-parakeet.js";

const OUTPUT_ARG = "--verify-lifecycle=";
const PARAKEET_ARG = "--verify-parakeet";
const VERIFICATION_PROVIDER_PREFIX = "lifecycle-verification";

const listFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        files.push(path.relative(root, absolute));
      }
    }
  };
  await walk(root);
  return files.sort();
};

export const runLifecycleVerificationFromArgs = async (
  argv: string[],
): Promise<boolean> => {
  const outputArg = argv.find((value) => value.startsWith(OUTPUT_ARG));
  if (!outputArg) return false;

  const outputPath = outputArg.slice(OUTPUT_ARG.length).trim();
  if (!path.isAbsolute(outputPath)) {
    throw new Error("Lifecycle verification output path must be absolute.");
  }

  app.setName("Stella Lifecycle Verification");
  await app.whenReady();
  const stellaDataDir =
    process.env.STELLA_DATA_DIR?.trim() || app.getPath("userData");
  const modelRoot = path.join(app.getPath("userData"), "models", "parakeet");
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
    const parakeet = argv.includes(PARAKEET_ARG)
      ? await (async () => {
          const installed = await downloadLocalParakeet();
          return installed.available
            ? await warmLocalParakeet()
            : installed;
        })()
      : null;
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
      parakeet,
      parakeetCacheFiles: await listFiles(modelRoot),
    };
    if (result.ok !== true || (parakeet && parakeet.available !== true)) {
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
    stopLocalParakeet();
    deleteLocalLlmCredential(stellaDataDir, verificationProvider);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  app.exit(exitCode);
  return true;
};
