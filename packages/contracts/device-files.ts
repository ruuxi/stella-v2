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

/**
 * Where a file a viewer asked for can be read from: this computer, the copy
 * the device that has it put in the user's Drive, or nowhere this computer
 * can reach. `missing` is a file that was on this computer and is gone;
 * `unshared` is one this computer never had that no device has shared.
 */
export type DeviceFileSource =
  | { kind: "local" }
  | { kind: "drive"; deviceName: string }
  | { kind: "elsewhere"; deviceName: string; oversized: boolean }
  | { kind: "missing" }
  | { kind: "unshared" }
  | { kind: "unreachable"; message: string };

export type DeviceFileMissingReason = "deleted" | "unshared";

export type DeviceFileNoun = "file" | "video" | "audio file";

const fileNameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() || filePath;

const COPY_LIMIT_MB = Math.round(DEVICE_FILE_COPY_LIMITS.maxFileBytes / (1024 * 1024));

export const deviceFileElsewhereMessage = (
  deviceName: string,
  options: { noun?: DeviceFileNoun; oversized?: boolean } = {},
): string => {
  const device = friendlyDeviceName(deviceName);
  const noun = options.noun ?? "file";
  return options.oversized
    ? `This ${noun} is on ${device}. It's over ${COPY_LIMIT_MB} MB, too large to share with your other devices, so open it there.`
    : `This ${noun} is on ${device}. Open it on that computer.`;
};

export const deviceFileMissingMessage = (
  reason: DeviceFileMissingReason | undefined,
  filePath: string,
  noun: DeviceFileNoun = "file",
): string =>
  reason === "unshared"
    ? `This ${noun} isn't on this computer, and no copy of it was shared to your Drive.`
    : `File no longer available — ${fileNameOf(filePath)} was moved or deleted.`;

/** What a viewer says when it can't show `filePath` from `source`. */
export const deviceFileUnavailableMessage = (
  source: DeviceFileSource | null,
  filePath: string,
  noun: DeviceFileNoun = "file",
): string => {
  switch (source?.kind) {
    case "missing":
      return deviceFileMissingMessage("deleted", filePath, noun);
    case "unshared":
      return deviceFileMissingMessage("unshared", filePath, noun);
    case "elsewhere":
      return deviceFileElsewhereMessage(source.deviceName, {
        noun,
        oversized: source.oversized,
      });
    case "unreachable":
      return source.message;
    default:
      return `Couldn't open ${fileNameOf(filePath)}.`;
  }
};
