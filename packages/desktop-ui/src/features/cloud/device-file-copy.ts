import { backendClient } from "@/platform/backend/backend-client";
import { deviceFileElsewhereMessage } from "@stella/contracts/device-files";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export type DeviceFileCopyRead = {
  bytes: Uint8Array;
  mimeType: string;
  truncated: boolean;
  missing: false;
};

export const readDeviceFileCopy = async (
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<DeviceFileCopyRead | null> => {
  const { files } = await backendClient.call("drive.locateDeviceFiles", {
    paths: [filePath],
  });
  const location = files.find((file) => file.sourcePath === filePath);
  if (!location) return null;
  if (!location.drivePath) {
    throw new Error(deviceFileElsewhereMessage(location.deviceName));
  }
  const { url, contentType } = await backendClient.call("drive.fileUrl", {
    path: location.drivePath,
  });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error("Couldn't load the copy of this file in your Drive.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.length, remaining);
      if (value.length > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    bytes,
    truncated,
    mimeType: contentType || "application/octet-stream",
    missing: false,
  };
};
