const MEDIA_ORIGIN = "stella-media://local";

export const isLocalMediaStreamable = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.electronAPI?.display?.readFile === "function";

export const localMediaUrl = (filePath: string): string =>
  `${MEDIA_ORIGIN}/${encodeURIComponent(filePath)}`;
