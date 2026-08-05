import { rm } from "node:fs/promises";
import { join } from "node:path";

export default async function prunePackagedInstallAssets(context) {
  const resourcesDirectory =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");

  // These archives are installer inputs for older Electron versions. The
  // current native module already lives in build/Release, so shipping the
  // archives only adds dead weight and makes Apple inspect unsigned binaries
  // nested inside them during notarization.
  await rm(
    join(
      resourcesDirectory,
      "app.asar.unpacked",
      "node_modules",
      "mac-screen-capture-permissions",
      "prebuilds",
    ),
    { recursive: true, force: true },
  );
}
