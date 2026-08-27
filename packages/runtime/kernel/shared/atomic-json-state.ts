import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const updateQueues = new Map<string, Promise<unknown>>();

const readRaw = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  } catch {

    return undefined;
  }
};

const writeAtomic = async (filePath: string, contents: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tempPath, contents, "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readJsonStateFile = async <T>(
  filePath: string,
  parse: (raw: unknown) => T,
): Promise<T> => parse(await readRaw(filePath));

export const updateJsonStateFile = async <T>(args: {
  filePath: string;
  parse: (raw: unknown) => T;
  update: (state: T) => T | void | Promise<T | void>;
}): Promise<T> => {
  const key = path.resolve(args.filePath);
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const state = args.parse(await readRaw(args.filePath));
      const next = (await args.update(state)) ?? state;
      await writeAtomic(args.filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  updateQueues.set(key, run);
  void run
    .finally(() => {
      if (updateQueues.get(key) === run) updateQueues.delete(key);
    })
    .catch(() => undefined);
  return await run;
};
