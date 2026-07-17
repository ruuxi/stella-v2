/**
 * Electron Builder afterPack hook.
 *
 * Removes unused prebuilt archives that break macOS notarization.
 *
 * `mac-screen-capture-permissions` ships a `prebuilds/` directory containing
 * tar.gz archives for multiple Electron versions. Each tar contains a
 * `build/Release/screencapturepermissions.node` that is only adhoc-signed
 * upstream. Apple's notary service extracts tarballs and validates every
 * nested Mach-O, so these unused archives make the notarization fail with
 * "binary is not signed with a valid Developer ID certificate" even though
 * the actual binary Stella loads (`build/Release/screencapturepermissions.node`
 * at the package root) is correctly Developer ID-signed by electron-builder.
 *
 * The module's runtime entry (`index.js`) `require()`s the sibling
 * `build/Release/screencapturepermissions.node` directly and never uses the
 * tarballs. Deleting `prebuilds/` is safe and matches what the production
 * release intends to ship.
 *
 * This hook runs before afterSign / codesigning, so the final signature
 * covers the cleaned tree.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export default async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const productFilename = context.packager?.appInfo?.productFilename ?? "Stella";

  // Possible locations electron-builder uses for unpacked node_modules:
  const candidateRoots = [
    // Normal packaged layout: <out>/Stella.app/Contents/Resources/app.asar.unpacked/...
    path.join(
      appOutDir,
      `${productFilename}.app`,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "mac-screen-capture-permissions",
      "prebuilds"
    ),
    // Fallback: some intermediate packing paths keep app.asar.unpacked at appOutDir level
    path.join(
      appOutDir,
      "app.asar.unpacked",
      "node_modules",
      "mac-screen-capture-permissions",
      "prebuilds"
    ),
  ];

  for (const prebuildsPath of candidateRoots) {
    if (!existsSync(prebuildsPath)) continue;
    console.log(`[afterPack] Removing unused notarization-breaking payload: ${prebuildsPath}`);
    await fs.rm(prebuildsPath, { recursive: true, force: true });
  }

  // Defensive: also remove any stray tar.gz that might have been unpacked elsewhere
  // under mac-screen-capture-permissions, without touching the legitimate
  // build/Release/screencapturepermissions.node that we DO ship.
  const packageRoots = [
    path.join(
      appOutDir,
      `${productFilename}.app`,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "mac-screen-capture-permissions"
    ),
  ];

  for (const pkgRoot of packageRoots) {
    if (!existsSync(pkgRoot)) continue;
    const entries = await fs.readdir(pkgRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".tar.gz") || entry.name.endsWith(".tar"))
      ) {
        const full = path.join(pkgRoot, entry.name);
        console.log(`[afterPack] Removing stray archive: ${full}`);
        await fs.rm(full, { force: true });
      }
    }
  }
}
