import { stat } from "node:fs/promises";

export const statSignature = async (path: string): Promise<string | null> => {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
};
