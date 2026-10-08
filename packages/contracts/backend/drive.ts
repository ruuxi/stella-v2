/**
 * The owner's drive: files agents produce and attachments clients upload,
 * stored in R2 and indexed in the owner's object.
 *
 * Bytes never pass through these calls. An upload is three steps: prepare
 * (a presigned PUT, checked against the plan's quota), the client's own PUT,
 * then finalize, which records the file from the size storage reports. A
 * download is a short-lived presigned GET from `drive.fileUrl`.
 */

/** One drive file as the drive lists it. */
export type DriveFile = {
  /** Drive-relative POSIX path, no leading slash (`uploads/2026/a.png`). */
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  /** Who wrote the bytes there now: `upload`, `agent`, `html`, `image_gen`, ... */
  source: string;
  createdAt: number;
  updatedAt: number;
};

/** One drive file as a write answers with it. */
export type DriveFileRecord = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: number;
};

export type DriveFileUrl = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  url: string;
  expiresAt: number;
};

export type DeviceFileLocation = {
  sourcePath: string;
  deviceId: string;
  deviceName: string;
  drivePath: string | null;
  name: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: number;
};

export type DeviceFileRecordInput = {
  sourcePath: string;
  drivePath?: string;
  sizeBytes: number;
  contentType?: string;
};

export type DriveCalls = {
  /**
   * Claim an upload: a presigned PUT for `uploadUrl`, valid for an hour.
   * Refused (`FORBIDDEN`, reason `quota_exceeded`) when the file would not
   * fit the plan.
   */
  "drive.prepareUpload": {
    args: { path: string; sizeBytes: number; contentType?: string };
    result: { path: string; uploadId: string; uploadUrl: string; contentType: string };
  };
  /**
   * Record a prepared upload once its PUT finished. Retrying with the same
   * `uploadId` after a lost response answers with the same file.
   */
  "drive.finalizeUpload": {
    args: { path: string; uploadId: string; contentType?: string; source?: string };
    result: DriveFileRecord;
  };
  /** A presigned GET for one of the owner's files, valid for 15 minutes. */
  "drive.fileUrl": {
    args: { path: string };
    result: DriveFileUrl;
  };
  "drive.delete": {
    args: { path: string };
    result: { deleted: boolean };
  };
  /**
   * One-shot form of the `drive.files` view, for a caller that wants an answer
   * rather than a subscription. An agent tool is the case: it asks once, inside
   * one tool call, and a device has no reason to hold a socket open for it.
   * Same rows, same order.
   */
  "drive.list": {
    args: { prefix?: string; limit?: number };
    result: { files: DriveFile[] };
  };
  "drive.recordDeviceFiles": {
    args: { deviceId: string; deviceName?: string; files: DeviceFileRecordInput[] };
    result: { recorded: number };
  };
  "drive.locateDeviceFiles": {
    args: { paths: string[] };
    result: { files: DeviceFileLocation[] };
  };
};

export type DriveViews = {
  /** Newest first, or in path order under `prefix`. */
  "drive.files": {
    args: { prefix?: string; limit?: number };
    result: DriveFile[];
  };
};
