import { app } from "electron";
import electronUpdater from "electron-updater";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DesktopUpdater,
  type DesktopUpdaterClient,
  resolveDesktopUpdateFeedUrl,
} from "./desktop-updater.js";

const { autoUpdater } = electronUpdater;

type VerificationResult = {
  phase: "downloaded" | "install-requested" | "applied" | "failed";
  currentVersion: string;
  expectedVersion: string;
  availableVersion?: string | null;
  downloadedVersion?: string | null;
  error?: string;
};

const writeResult = async (result: VerificationResult) => {
  const outputPath = process.env.STELLA_V2_LOCAL_UPDATE_RESULT?.trim();
  if (!outputPath) {
    throw new Error("STELLA_V2_LOCAL_UPDATE_RESULT is required.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
};

export const runLocalUpdateVerificationFromArgs = async (
  args: readonly string[],
): Promise<boolean> => {
  const requested = args.includes("--stella-verify-local-update");
  const token = process.env.STELLA_V2_LOCAL_UPDATE_VERIFY_TOKEN?.trim();
  const expectedVersion = process.env.STELLA_V2_LOCAL_UPDATE_EXPECTED?.trim();
  const isolatedUserData = process.env.STELLA_V2_LOCAL_UPDATE_USER_DATA?.trim();
  if (!requested && !(token && expectedVersion && isolatedUserData)) {
    return false;
  }
  if (!token || !expectedVersion || !isolatedUserData) {
    throw new Error(
      "Incomplete local desktop update verification environment.",
    );
  }
  if (!app.isPackaged) {
    throw new Error("Local updater verification requires a packaged app.");
  }

  // Chromium's macOS os_crypt initialization can otherwise ask the login
  // Keychain for an ad-hoc build's Safe Storage item before the updater runs.
  // This verifier never exercises credential storage, so use Electron's
  // in-memory test keychain and a dedicated visible app name.
  app.commandLine.appendSwitch("use-mock-keychain");
  app.setName("Stella v2 Update Verification");
  app.setPath("userData", isolatedUserData);
  app.setPath("sessionData", path.join(isolatedUserData, "session-data"));
  app.setPath("logs", path.join(isolatedUserData, "logs"));
  app.setPath("crashDumps", path.join(isolatedUserData, "crash-dumps"));
  await app.whenReady();
  const currentVersion = app.getVersion();

  // A future signed verification can opt into the apply handoff. The default
  // local build is ad-hoc signed, so it deliberately stops after download;
  // Squirrel.Mac correctly refuses to install a payload that cannot satisfy a
  // real Developer ID code requirement.
  if (!requested) {
    const phase = currentVersion === expectedVersion ? "applied" : "failed";
    await writeResult({
      phase,
      currentVersion,
      expectedVersion,
      ...(phase === "failed"
        ? {
            error:
              "Updater relaunched a version other than the expected build.",
          }
        : {}),
    });
    app.quit();
    return true;
  }

  const updater = new DesktopUpdater({
    client: autoUpdater as unknown as DesktopUpdaterClient,
    currentVersion,
    enabled: true,
    feedUrl: resolveDesktopUpdateFeedUrl(args),
    startupDelayMs: 60 * 60 * 1_000,
    checkIntervalMs: 60 * 60 * 1_000,
    log: console,
  });
  updater.start();
  try {
    const available = await updater.checkNow();
    if (
      available.status !== "available" ||
      available.availableVersion !== expectedVersion
    ) {
      throw new Error(
        `Expected update ${expectedVersion}; updater reported ${available.status} (${available.availableVersion ?? "none"}).`,
      );
    }
    const downloaded = await updater.download();
    if (
      downloaded.status !== "downloaded" ||
      downloaded.downloadedVersion !== expectedVersion
    ) {
      throw new Error(
        `Expected downloaded update ${expectedVersion}; got ${downloaded.status} (${downloaded.downloadedVersion ?? "none"}).`,
      );
    }
    await writeResult({
      phase: "downloaded",
      currentVersion,
      expectedVersion,
      availableVersion: downloaded.availableVersion,
      downloadedVersion: downloaded.downloadedVersion,
    });
    if (process.env.STELLA_V2_LOCAL_UPDATE_APPLY !== "1") {
      updater.dispose();
      app.quit();
      return true;
    }
    await writeResult({
      phase: "install-requested",
      currentVersion,
      expectedVersion,
      availableVersion: downloaded.availableVersion,
      downloadedVersion: downloaded.downloadedVersion,
    });
    updater.restartAndInstall();
    return true;
  } catch (error) {
    await writeResult({
      phase: "failed",
      currentVersion,
      expectedVersion,
      error: error instanceof Error ? error.message : String(error),
    });
    updater.dispose();
    app.quit();
    return true;
  }
};
