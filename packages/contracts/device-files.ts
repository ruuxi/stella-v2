export const DEVICE_FILE_COPY_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFilesPerMessage: 20,
  maxLocatePaths: 50,
} as const;

export const DEVICE_FILES_DRIVE_FOLDER = "Devices";

const MAX_SEGMENT_CHARS = 120;

export const friendlyDeviceName = (name: string | null | undefined): string => {
  const trimmed = (name ?? "").trim().replace(/\.(local|localdomain|lan|home)$/i, "");
  return trimmed || "another computer";
};

const driveSegment = (value: string, fallback: string): string => {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f/\\]/g, "-")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, MAX_SEGMENT_CHARS);
  return cleaned || fallback;
};

export const deviceFileCopyDrivePath = (args: {
  deviceName: string;
  sourceDigest: string;
  fileName: string;
}): string =>
  [
    DEVICE_FILES_DRIVE_FOLDER,
    driveSegment(friendlyDeviceName(args.deviceName), "computer"),
    driveSegment(args.sourceDigest.slice(0, 12), "file"),
    driveSegment(args.fileName, "file"),
  ].join("/");

export type DeviceFileCandidate = {
  sourcePath: string;
  deviceId: string;
  drivePath: string | null;
  updatedAt: number;
};

export const pickDeviceFileLocation = <T extends DeviceFileCandidate>(
  candidates: readonly T[],
  sourcePath: string,
  readerDeviceId?: string | null,
): T | null => {
  const matching = candidates
    .filter((candidate) => candidate.sourcePath === sourcePath)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const elsewhere = matching.filter(
    (candidate) => candidate.deviceId !== readerDeviceId,
  );
  return elsewhere[0] ?? matching[0] ?? null;
};

export const deviceFileElsewhereMessage = (deviceName: string): string =>
  `This file is on ${friendlyDeviceName(deviceName)}. Open it on that computer.`;
