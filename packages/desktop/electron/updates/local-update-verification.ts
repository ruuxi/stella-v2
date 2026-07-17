import { app } from "electron";
import electronUpdater from "electron-updater";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertLocalUpdateVerificationRequest,
  configureLocalUpdateVerificationUpdater,
  type LocalUpdateVerificationIdentity,
} from "./local-update-verification-identity.js";

const { autoUpdater } = electronUpdater;

type VerificationResult = {
  phase: "downloaded" | "failed";
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

const readPackagedIdentity =
  async (): Promise<LocalUpdateVerificationIdentity> => {
    if (process.platform !== "darwin") {
      throw new Error("Local updater verification currently requires macOS.");
    }
    const packageJson = JSON.parse(
      await readFile(path.join(app.getAppPath(), "package.json"), "utf8"),
    ) as {
      stellaUpdateVerification?: boolean | string;
      stellaUpdateVerificationBundleId?: string;
    };
    const infoPlistPath = path.resolve(
      process.resourcesPath,
      "..",
      "Info.plist",
    );
    const bundleId = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", infoPlistPath],
      { encoding: "utf8" },
    ).trim();
    return {
      isPackaged: app.isPackaged,
      appName: app.getName(),
      bundleId,
      packageMarker:
        packageJson.stellaUpdateVerification === true ||
        packageJson.stellaUpdateVerification === "true",
      packageBundleId: String(
        packageJson.stellaUpdateVerificationBundleId ?? "",
      ),
    };
  };

const updaterEvents = autoUpdater as unknown as {
  once: (eventName: string, listener: (value: unknown) => void) => void;
  removeListener: (
    eventName: string,
    listener: (value: unknown) => void,
  ) => void;
};

const waitForUpdaterEvent = <T>(eventName: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const onValue = (value: unknown) => {
      updaterEvents.removeListener("error", onError);
      resolve(value as T);
    };
    const onError = (error: unknown) => {
      updaterEvents.removeListener(eventName, onValue);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    updaterEvents.once(eventName, onValue);
    updaterEvents.once("error", onError);
  });

export const runLocalUpdateVerificationFromArgs = async (
  args: readonly string[],
): Promise<boolean> => {
  if (!args.includes("--stella-verify-local-update")) {
    throw new Error(
      "The verifier-only application requires its explicit flag.",
    );
  }
  const token = process.env.STELLA_V2_LOCAL_UPDATE_VERIFY_TOKEN?.trim();
  const expectedVersion = process.env.STELLA_V2_LOCAL_UPDATE_EXPECTED?.trim();
  const isolatedUserData = process.env.STELLA_V2_LOCAL_UPDATE_USER_DATA?.trim();
  const feedValue = process.env.STELLA_V2_LOCAL_UPDATE_FEED_URL?.trim();
  if (!token || !expectedVersion || !isolatedUserData || !feedValue) {
    throw new Error(
      "Incomplete local desktop update verification environment.",
    );
  }

  app.commandLine.appendSwitch("use-mock-keychain");
  const feedUrl = assertLocalUpdateVerificationRequest(
    await readPackagedIdentity(),
    feedValue,
  );

  // Chromium's macOS os_crypt initialization can otherwise ask the login
  // Keychain for an ad-hoc build's Safe Storage item. This verifier never
  // exercises credential storage, so it uses Electron's in-memory test keychain
  // and dedicated state paths before Electron becomes ready.
  app.setPath("userData", isolatedUserData);
  app.setPath("sessionData", path.join(isolatedUserData, "session-data"));
  app.setPath("logs", path.join(isolatedUserData, "logs"));
  app.setPath("crashDumps", path.join(isolatedUserData, "crash-dumps"));
  await app.whenReady();
  const currentVersion = app.getVersion();

  configureLocalUpdateVerificationUpdater(autoUpdater, feedUrl);

  try {
    const availableEvent = waitForUpdaterEvent<{ version: string }>(
      "update-available",
    );
    await autoUpdater.checkForUpdates();
    const available = await availableEvent;
    if (available.version !== expectedVersion) {
      throw new Error(
        `Expected update ${expectedVersion}; updater reported ${available.version}.`,
      );
    }

    const downloadedEvent = waitForUpdaterEvent<{ version: string }>(
      "update-downloaded",
    );
    await autoUpdater.downloadUpdate();
    const downloaded = await downloadedEvent;
    if (downloaded.version !== expectedVersion) {
      throw new Error(
        `Expected downloaded update ${expectedVersion}; got ${downloaded.version}.`,
      );
    }

    await writeResult({
      phase: "downloaded",
      currentVersion,
      expectedVersion,
      availableVersion: available.version,
      downloadedVersion: downloaded.version,
    });
    app.quit();
    return true;
  } catch (error) {
    await writeResult({
      phase: "failed",
      currentVersion,
      expectedVersion,
      error: error instanceof Error ? error.message : String(error),
    });
    app.quit();
    return true;
  }
};
