export const STELLA_V2_UPDATE_CHANNEL = "latest-v2" as const;
export const STELLA_V2_UPDATE_FEED_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop-v2/stable" as const;

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "restarting"
  | "error";

export type DesktopUpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type DesktopUpdateSnapshot = {
  status: DesktopUpdateStatus;
  channel: typeof STELLA_V2_UPDATE_CHANNEL;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  progress: DesktopUpdateProgress | null;
  checkedAt: string | null;
  error: string | null;
};
