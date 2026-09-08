/**
 * Paths inside a cloud owner's world, as the cloud tools see them. A cloud
 * turn's reply links its files by these absolute paths (`/workspace/world/
 * drive/reports/a.md`, or the forked `/workspace/forks/<id>/world/drive/...`);
 * every client maps such a link onto the owner's drive rather than treating it
 * as a file on the local machine, which it never is.
 */
const WORLD_DRIVE_LINK_RE =
  /^\/workspace\/(?:forks\/[^/]+\/)?world\/drive\/(.+)$/;

/**
 * The drive-relative path (`reports/a.md`) a world-absolute link names, or
 * null when the path is not inside the world's drive. Traversal segments and
 * the tool host's private `.stella` state directory never resolve.
 */
export const cloudWorldDrivePath = (filePath: string): string | null => {
  const match = WORLD_DRIVE_LINK_RE.exec(filePath.trim());
  const relative = match?.[1]?.replace(/\/+$/, "");
  if (!relative) return null;
  const segments = relative.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    segments.includes(".stella")
  ) {
    return null;
  }
  return relative;
};

export const cloudWorldDriveName = (drivePath: string): string =>
  drivePath.slice(drivePath.lastIndexOf("/") + 1);
