import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_ATTEMPTS = 5;

const fileSize = async (filePath: string): Promise<number> => {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
};

export const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
};

const verifyDownload = async (
  filePath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<boolean> =>
  (await fileSize(filePath)) === expectedSize &&
  (await sha256File(filePath)) === expectedSha256.toLowerCase();

const retryDelay = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, attempt * 250));

export const downloadModelWithResume = async ({
  url,
  targetPath,
  expectedSize,
  expectedSha256,
  attempts = DEFAULT_ATTEMPTS,
  fetchImpl = fetch,
}: {
  url: string;
  targetPath: string;
  expectedSize: number;
  expectedSha256: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (await verifyDownload(targetPath, expectedSize, expectedSha256)) {
    return targetPath;
  }
  await rm(targetPath, { force: true });

  const partialPath = `${targetPath}.part`;
  let lastError: unknown = new Error("Model download did not start.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let existingBytes = await fileSize(partialPath);
    if (existingBytes > expectedSize) {
      await rm(partialPath, { force: true });
      existingBytes = 0;
    }
    if (
      existingBytes === expectedSize &&
      (await verifyDownload(partialPath, expectedSize, expectedSha256))
    ) {
      await rename(partialPath, targetPath);
      return targetPath;
    }

    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "Stella",
          ...(existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {}),
        },
      });
      if (response.status === 416 && existingBytes === expectedSize) {
        if (await verifyDownload(partialPath, expectedSize, expectedSha256)) {
          await rename(partialPath, targetPath);
          return targetPath;
        }
        await rm(partialPath, { force: true });
        throw new Error("Completed model download failed integrity check.");
      }
      if (!response.ok || !response.body) {
        throw new Error(`Model download failed: HTTP ${response.status}`);
      }

      const resumed = existingBytes > 0 && response.status === 206;
      if (existingBytes > 0 && !resumed) {
        existingBytes = 0;
      }
      await pipeline(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
        createWriteStream(partialPath, { flags: resumed ? "a" : "w" }),
      );

      if (await verifyDownload(partialPath, expectedSize, expectedSha256)) {
        await rename(partialPath, targetPath);
        return targetPath;
      }
      const downloadedBytes = await fileSize(partialPath);
      if (downloadedBytes >= expectedSize) {
        await rm(partialPath, { force: true });
        throw new Error("Downloaded model failed integrity check.");
      }
      throw new Error(
        `Model download ended early at ${downloadedBytes} of ${expectedSize} bytes.`,
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await retryDelay(attempt);
    }
  }

  throw lastError;
};
