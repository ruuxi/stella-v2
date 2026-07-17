import path from "node:path";
import { notarize } from "@electron/notarize";

const requiredCredential = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required notarization environment variable: ${name}`,
    );
  }
  return value;
};

export default async function notarizeAfterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.STELLA_SKIP_NOTARIZE === "1") {
    console.log(
      "[notarize] Explicitly skipped for local updater verification.",
    );
    return;
  }

  const requireNotarization = process.env.STELLA_REQUIRE_NOTARIZE === "1";
  const hasCredentials = Boolean(
    process.env.APPLE_ID?.trim() &&
      process.env.APPLE_PASSWORD?.trim() &&
      process.env.APPLE_TEAM_ID?.trim(),
  );
  if (!requireNotarization && !hasCredentials) {
    console.log(
      "[notarize] Apple credentials are absent; skipping notarization for this local build.",
    );
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  console.log(`[notarize] Submitting ${appPath} with notarytool.`);
  await notarize({
    appPath,
    appleId: requiredCredential("APPLE_ID"),
    appleIdPassword: requiredCredential("APPLE_PASSWORD"),
    teamId: requiredCredential("APPLE_TEAM_ID"),
  });
  console.log(`[notarize] Notarized and stapled ${appPath}.`);
}
