import { promises as fs } from "node:fs";

import {
  detectImageMediaType,
  isCompleteImage,
} from "../../ai/utils/image-payload.js";

const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 15;
const MAX_DELAY_MS = 240;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ReadImageFileSettledOptions = {

  maxAttempts?: number;

  sleep?: (ms: number) => Promise<void>;
};

export const readImageFileSettled = async (
  filePath: string,
  options?: ReadImageFileSettledOptions,
): Promise<Buffer> => {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = options?.sleep ?? delay;

  let buf = await fs.readFile(filePath);
  let previousLength = -1;

  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const detected = detectImageMediaType(buf);
    if (detected && isCompleteImage(buf, detected)) {
      return buf;
    }

    if (buf.length === previousLength) {
      return buf;
    }
    previousLength = buf.length;

    await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
    buf = await fs.readFile(filePath);
  }

  return buf;
};
