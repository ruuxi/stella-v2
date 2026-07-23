import { Directory, File, Paths } from "expo-file-system";
import { unzipSync } from "fflate";
import { mobileConfig } from "./config";

type InteriorManifest = {
  version: string;
  bundleUrl: string;
  remoteUrl: string;
};

const root = new Directory(Paths.document, "stella-interior");
const activeMarker = new File(root, "active-version.txt");

const ensureRoot = () => {
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
};

const activeIndex = (version: string) =>
  new File(root, version.replace(/[^a-zA-Z0-9._-]/g, "_"), "index.html");

const writeBundle = async (manifest: InteriorManifest): Promise<File> => {
  ensureRoot();
  const archive = new File(Paths.cache, `stella-interior-${Date.now()}.zip`);
  await File.downloadFileAsync(manifest.bundleUrl, archive, {
    idempotent: true,
  });
  const bytes = await archive.bytes();
  const files = unzipSync(bytes);
  const versionDir = new Directory(
    root,
    manifest.version.replace(/[^a-zA-Z0-9._-]/g, "_"),
  );
  if (!versionDir.exists) {
    versionDir.create({ intermediates: true, idempotent: true });
  }
  for (const [relative, body] of Object.entries(files)) {
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0 || relative.endsWith("/")) continue;
    let directory = versionDir;
    for (const segment of parts.slice(0, -1)) {
      directory = new Directory(directory, segment);
      if (!directory.exists) {
        directory.create({ intermediates: true, idempotent: true });
      }
    }
    new File(directory, parts.at(-1)!).write(body);
  }
  activeMarker.create({ intermediates: true, overwrite: true });
  activeMarker.write(manifest.version);
  archive.delete();
  return activeIndex(manifest.version);
};

export type InteriorBundle = {
  uri: string;
  directoryPath?: string;
  version: string;
  updateAvailable: boolean;
};

const localBundle = (
  index: File,
  version: string,
  updateAvailable: boolean,
): InteriorBundle => ({
  uri: index.uri,
  directoryPath: index.parentDirectory.uri.replace(/^file:\/\//, ""),
  version,
  updateAvailable,
});

export const loadInteriorBundle = async (): Promise<InteriorBundle> => {
  ensureRoot();
  let activeVersion = "";
  if (activeMarker.exists) activeVersion = (await activeMarker.text()).trim();
  const cached = activeVersion ? activeIndex(activeVersion) : null;

  let manifest: InteriorManifest;
  try {
    const response = await fetch(mobileConfig.manifestUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Manifest returned ${response.status}.`);
    manifest = (await response.json()) as InteriorManifest;
  } catch {
    if (cached?.exists) {
      return localBundle(cached, activeVersion, false);
    }
    return {
      uri: `${mobileConfig.fallbackUrl}/`,
      version: "network-fallback",
      updateAvailable: false,
    };
  }

  if (cached?.exists && manifest.version === activeVersion) {
    return localBundle(cached, activeVersion, false);
  }
  if (cached?.exists) {
    void writeBundle(manifest);
    return localBundle(cached, activeVersion, true);
  }
  const index = await writeBundle(manifest);
  return localBundle(index, manifest.version, false);
};
