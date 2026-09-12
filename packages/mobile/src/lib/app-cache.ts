import type { WorkspaceApp } from "@stella/contracts/workspace-apps";

export type AppFrame = Pick<WorkspaceApp, "slug" | "revision" | "title"> & {
  url: string;
  expiresAt: number;
};

// Persist only library metadata. Signed session URLs stay in memory.
export const appListCacheKey = (owner: string, origin: string) =>
  `stella.apps.v1:${encodeURIComponent(origin)}:${encodeURIComponent(owner)}`;

export function reusableAppFrame(
  frames: AppFrame[],
  app: WorkspaceApp,
  now: number,
) {
  return frames.find(
    (frame) =>
      frame.slug === app.slug &&
      frame.revision === app.revision &&
      frame.expiresAt > now + 60_000,
  );
}

/** Keep the two most recently used pages, bounding native WebView memory. */
export function retainAppFrame(
  frames: AppFrame[],
  frame: AppFrame,
): AppFrame[] {
  return [...frames.filter((entry) => entry.slug !== frame.slug), frame].slice(
    -2,
  );
}
