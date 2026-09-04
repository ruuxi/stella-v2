import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export type WorldSyncAccess = Readonly<{
  origin: string;
  name: string;
  capability: string;
}>;

type WorldListingEntry = {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  sha256?: string;
  target?: string;
};

const fileSha256 = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

export const listWorldProjection = async (
  root: string,
): Promise<WorldListingEntry[]> => {
  const entries: WorldListingEntry[] = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? path.join(root, relative) : root;
    const names = (await readdir(absolute)).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name;
      if (child === ".stella/world-manifest") continue;
      const childPath = path.join(root, child);
      const stat = await lstat(childPath);
      const common = {
        path: child,
        mode: stat.mode & 0o7777,
        mtime: Math.trunc(stat.mtimeMs),
        size: stat.size,
      };
      if (stat.isSymbolicLink()) {
        entries.push({
          ...common,
          kind: "symlink",
          target: await readlink(childPath),
        });
      } else if (stat.isDirectory()) {
        entries.push({ ...common, kind: "dir", size: 0 });
        await walk(child);
      } else if (stat.isFile()) {
        entries.push({
          ...common,
          kind: "file",
          sha256: await fileSha256(childPath),
        });
      }
    }
  };
  await walk("");
  return entries;
};

const syncUrl = (access: WorldSyncAccess): string =>
  `${access.origin.replace(/\/+$/u, "")}/internal/worlds/${access.name}/push`;

const headers = (access: WorldSyncAccess): Headers =>
  new Headers({ authorization: `Bearer ${access.capability}` });

const postListing = async (
  access: WorldSyncAccess,
  entries: WorldListingEntry[],
): Promise<string[]> => {
  const requestHeaders = headers(access);
  requestHeaders.set("content-type", "application/json");
  const response = await fetch(syncUrl(access), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ entries }),
  });
  const value = (await response.json().catch(() => null)) as {
    missingBlobs?: unknown;
  } | null;
  if (
    !response.ok ||
    !value ||
    !Array.isArray(value.missingBlobs) ||
    value.missingBlobs.some(
      (sha) => typeof sha !== "string" || !/^[0-9a-f]{64}$/u.test(sha),
    )
  ) {
    throw new Error(`World push failed with HTTP ${response.status}.`);
  }
  return value.missingBlobs;
};

const uploadBlob = async (
  access: WorldSyncAccess,
  sha256: string,
  filePath: string,
): Promise<void> => {
  const requestHeaders = headers(access);
  requestHeaders.set("content-type", "application/octet-stream");
  requestHeaders.set("x-stella-world-blob-sha256", sha256);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: requestHeaders,
    body: createReadStream(filePath) as never,
    duplex: "half",
  };
  const response = await fetch(syncUrl(access), init);
  if (!response.ok)
    throw new Error(`World blob upload failed with HTTP ${response.status}.`);
  await response.body?.cancel();
};

export const pushWorldProjection = async (args: {
  root: string;
  access: WorldSyncAccess;
}): Promise<void> => {
  const entries = await listWorldProjection(args.root);
  const files = new Map(
    entries
      .filter(
        (
          entry,
        ): entry is WorldListingEntry & { kind: "file"; sha256: string } =>
          entry.kind === "file" && Boolean(entry.sha256),
      )
      .map((entry) => [entry.sha256, path.join(args.root, entry.path)]),
  );
  let missing = await postListing(args.access, entries);
  while (missing.length > 0) {
    for (const sha256 of missing) {
      const filePath = files.get(sha256);
      if (!filePath)
        throw new Error(`World requested an unknown blob ${sha256}.`);
      await uploadBlob(args.access, sha256, filePath);
    }
    missing = await postListing(args.access, entries);
  }
};
