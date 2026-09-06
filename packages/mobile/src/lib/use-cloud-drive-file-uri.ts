import { makeFunctionReference } from "convex/server";
import { useEffect, useState } from "react";
import { getConvexClient } from "./convex";

/**
 * Signed URLs for the current owner's drive files, for images a cloud turn
 * produced (`image_gen` saves into the drive). The same action the attachment
 * previews use; cached here so a strip of tiles and the viewer that opens one
 * of them share a URL instead of each minting their own.
 */

type DriveFileUrl = {
  path: string;
  name: string;
  contentType: string;
  url: string;
  expiresAt: number;
};

const getDriveFileUrl = makeFunctionReference<
  "action",
  { path: string },
  DriveFileUrl
>("cloud_drive:getMyDriveFileUrl");

/** Refresh this long before a URL expires so an on-screen image never breaks. */
const REFRESH_MARGIN_MS = 30_000;

const cache = new Map<string, DriveFileUrl>();
const inflight = new Map<string, Promise<DriveFileUrl>>();

const fresh = (entry: DriveFileUrl | undefined): entry is DriveFileUrl =>
  entry !== undefined && entry.expiresAt > Date.now() + REFRESH_MARGIN_MS;

/** Resolve one drive path to a signed URL, sharing in-flight requests. */
export const resolveCloudDriveFileUri = async (
  path: string,
): Promise<string> => {
  const cached = cache.get(path);
  if (fresh(cached)) return cached.url;
  let pending = inflight.get(path);
  if (!pending) {
    pending = getConvexClient()
      .action(getDriveFileUrl, { path })
      .then((entry) => {
        cache.set(path, entry);
        return entry;
      })
      .finally(() => {
        inflight.delete(path);
      });
    inflight.set(path, pending);
  }
  return (await pending).url;
};

/** Drop cached URLs when the signed-in owner changes. */
export const clearCloudDriveFileUris = (): void => {
  cache.clear();
};

/**
 * The signed URL for a drive path, or null while it resolves. `path` null
 * means "not a drive file" and resolves nothing.
 */
export const useCloudDriveFileUri = (
  path: string | null,
): { uri: string | null; failed: boolean } => {
  const [state, setState] = useState<{
    path: string | null;
    uri: string | null;
    failed: boolean;
  }>(() => {
    const cached = path ? cache.get(path) : undefined;
    return { path, uri: fresh(cached) ? cached.url : null, failed: false };
  });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void resolveCloudDriveFileUri(path)
        .then((uri) => {
          if (cancelled) return;
          setState({ path, uri, failed: false });
          const expiresAt = cache.get(path)?.expiresAt ?? 0;
          const delay = Math.max(1_000, expiresAt - Date.now() - REFRESH_MARGIN_MS);
          timer = setTimeout(load, Math.min(delay, 2_147_483_647));
        })
        .catch(() => {
          if (!cancelled) setState({ path, uri: null, failed: true });
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path]);

  if (state.path !== path) {
    // A tile reused for another path: never show the previous file.
    const cached = path ? cache.get(path) : undefined;
    return { uri: fresh(cached) ? cached.url : null, failed: false };
  }
  return { uri: state.uri, failed: state.failed };
};
