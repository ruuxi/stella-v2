/** Bounded drive hydration for resident file tools, before any agent writes.
 * Bytes and the container-compatible ledger commit together against the world
 * revision. Unsupported sizes or divergent copies attach the sandbox instead.
 */
import { sha256BytesHex } from "./hash.js";
import { normalizeWorldPath } from "./world/path.js";
import type { WorldEntry, WorldListingEntry } from "./world/types.js";

const LEDGER = "drive/.stella/drive-sync.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
type Row = { updatedAt: number; sizeBytes: number; sha256: string };
type Entry = Omit<Row, "sha256"> & {
  path: string;
  relativePath: string;
  url: string;
  sha256?: string;
};
export type ResidentDriveWorld = {
  head(): Promise<{ revision: number }>;
  stat(path: string): Promise<WorldEntry | null>;
  list(
    prefix: string,
    options: { limit: number },
  ): Promise<{ entries: WorldEntry[]; cursor?: string }>;
  readFile(path: string): Promise<Uint8Array | null>;
  putBlob(
    stream: ReadableStream<Uint8Array>,
    input: { sha256: string; size: number },
  ): Promise<unknown>;
  commitShell(input: {
    baseRevision: number;
    reads: { paths: string[]; children: string[] };
    entries: WorldListingEntry[];
    deleted: string[];
  }): Promise<{ status: string }>;
};

const hash = sha256BytesHex;
const pathFor = (relative: string): string => {
  normalizeWorldPath(relative);
  if (relative.split("/").includes(".stella"))
    throw new Error("Private drive state cannot be hydrated.");
  return `drive/${relative}`;
};
const boundedBytes = async (
  response: Response,
  size: number,
): Promise<Uint8Array> => {
  if (!response.ok || !response.body) throw new Error("Drive download failed.");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > size)
        throw new Error("Drive download exceeded its declared size.");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new Error("Drive download was incomplete.");
    return bytes;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const hydrateResidentDrive = async (input: {
  world: ResidentDriveWorld;
  post(body: unknown, signal: AbortSignal): Promise<Response>;
  turnId: string;
  prompt: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, number>> => {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const { world } = input;
  const { revision } = await world.head();
  const reads = new Set<string>([LEDGER]);
  const children = new Set<string>();
  const ledgerStat = await world.stat(LEDGER);
  if (
    ledgerStat &&
    (ledgerStat.kind !== "file" || ledgerStat.size > 1024 * 1024)
  )
    throw new Error("Drive ledger needs sandbox hydration.");
  const raw = ledgerStat ? await world.readFile(LEDGER) : null;
  const prior = raw
    ? (JSON.parse(new TextDecoder().decode(raw)) as {
        files?: Record<string, Row>;
        syncedAt?: number;
        checkedThrough?: string;
      })
    : {};
  const files: Record<string, Row> = Object.create(null);
  const priorRows = Object.entries(prior.files ?? {});
  if (priorRows.length > 2000)
    throw new Error("Drive ledger exceeds resident limits.");
  for (const [path, row] of priorRows) {
    pathFor(path);
    if (
      !row ||
      !Number.isFinite(row.updatedAt) ||
      !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw new Error("Invalid drive ledger.");
    files[path] = row;
  }
  const paths = Object.keys(files).sort();
  const next = paths.findIndex((path) => path > (prior.checkedThrough ?? ""));
  const from = next < 0 ? 0 : next;
  const have = [...paths.slice(from), ...paths.slice(0, from)].slice(0, 500);
  const response = await input.post(
    {
      turnId: input.turnId,
      include: [
        ...input.prompt
          .slice(0, 20_000)
          .matchAll(/[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,8}/g),
      ]
        .slice(0, 25)
        .map((m) => m[0]),
      have,
      since: Math.min(
        Number.isFinite(prior.syncedAt) ? prior.syncedAt! : 0,
        Date.now(),
      ),
    },
    signal,
  );
  if (!response.ok) throw new Error("Drive manifest could not be read.");
  const manifest = (await response.json()) as {
    files: Entry[];
    skipped: unknown[];
    deleted: Array<{ path: string; relativePath: string }>;
    absent: string[];
    syncedAt: number;
    deletedComplete: boolean;
  };
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100 ||
    !Array.isArray(manifest.skipped) ||
    !Array.isArray(manifest.deleted) ||
    !Array.isArray(manifest.absent) ||
    !Number.isFinite(manifest.syncedAt) ||
    typeof manifest.deletedComplete !== "boolean"
  )
    throw new Error("Drive manifest needs sandbox hydration.");
  // A writable ledger cannot prove that the drive is fresh. An incomplete
  // replay is safe only when presence covers the entire ledger AND the
  // authoritative world has no unaccounted user files. Keep undelivered
  // outputs intact by attaching instead of guessing whether to delete them.
  if (!manifest.deletedComplete) {
    if (have.length !== paths.length)
      throw new Error(
        "Drive deletion history needs full sandbox reconciliation.",
      );
    const listing = await world.list("drive", { limit: 2500 });
    if (listing.cursor)
      throw new Error("Drive listing exceeds resident reconciliation limits.");
    // Protect the absence of new drive directories and every listed
    // directory's children while the downloads are in flight.
    children.add("");
    children.add("drive");
    for (const entry of listing.entries) {
      reads.add(entry.path);
      if (entry.kind === "dir") children.add(entry.path);
      if (
        entry.path === "drive" ||
        entry.path === "drive/.stella" ||
        entry.path.startsWith("drive/.stella/")
      )
        continue;
      if (entry.kind === "dir") continue;
      if (entry.kind !== "file" || !files[entry.path.slice("drive/".length)])
        throw new Error(
          "Drive has unaccounted workspace files; sandbox reconciliation required.",
        );
    }
  }
  // The container has the larger budget and the complete conflict notices.
  if (manifest.skipped.length)
    throw new Error("Drive manifest exceeds resident limits.");
  const entries = new Map<string, WorldListingEntry>();
  const deleted: string[] = [];
  const known = new Map<string, number>();
  let total = 0;
  const parents = async (path: string) => {
    const segments = path.split("/");
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join("/");
      reads.add(parent);
      const stat = await world.stat(parent);
      if (stat && stat.kind !== "dir")
        throw new Error("Drive path has a non-directory ancestor.");
      if (!stat)
        entries.set(parent, {
          path: parent,
          kind: "dir",
          mode: 0o755,
          size: 0,
        });
    }
  };
  const blob = async (path: string, bytes: Uint8Array) => {
    const sha256 = await hash(bytes);
    await world.putBlob(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { sha256, size: bytes.byteLength },
    );
    await parents(path);
    entries.set(path, {
      path,
      kind: "file",
      mode: 0o644,
      size: bytes.byteLength,
      sha256,
    });
    return sha256;
  };
  const live = new Set(manifest.files.map((entry) => entry.path));
  for (const row of [
    ...manifest.deleted,
    ...manifest.absent.map((path) => ({ path, relativePath: path })),
  ].slice(0, 1000)) {
    if (live.has(row.path) || !files[row.path]) continue;
    const path = pathFor(row.relativePath);
    if (row.path !== row.relativePath)
      throw new Error("Invalid drive deletion path.");
    reads.add(path);
    await parents(path);
    const stat = await world.stat(path);
    if (
      stat &&
      (stat.kind !== "file" || stat.sha256 !== files[row.path]!.sha256)
    )
      throw new Error("Deleted drive copy contains workspace edits.");
    if (stat) deleted.push(path);
    delete files[row.path];
  }
  for (const entry of manifest.files) {
    signal.throwIfAborted();
    if (
      entry.path !== entry.relativePath ||
      !Number.isFinite(entry.updatedAt) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > MAX_FILE_BYTES
    )
      throw new Error("Drive file needs sandbox hydration.");
    total += entry.sizeBytes;
    if (total > MAX_TOTAL_BYTES)
      throw new Error("Drive exceeds resident hydration budget.");
    const path = pathFor(entry.relativePath);
    reads.add(path);
    await parents(path);
    const stat = await world.stat(path);
    const old = files[entry.path];
    if (stat && stat.kind !== "file")
      throw new Error("Drive path is not a regular file.");
    if (stat && old?.updatedAt === entry.updatedAt) {
      // Local edits of a row we already read are deliberately preserved.
      known.set(entry.path, entry.updatedAt);
      continue;
    }
    if (stat && (!old || stat.sha256 !== old.sha256))
      throw new Error("Drive and workspace both changed.");
    const url = new URL(entry.url);
    if (url.protocol !== "https:")
      throw new Error("Invalid drive download URL.");
    const bytes = await boundedBytes(
      await (input.fetchImpl ?? fetch)(url, { signal, redirect: "manual" }),
      entry.sizeBytes,
    );
    const sha256 = await hash(bytes);
    if (entry.sha256 && sha256 !== entry.sha256)
      throw new Error("Drive download hash mismatch.");
    await blob(path, bytes);
    files[entry.path] = {
      updatedAt: entry.updatedAt,
      sizeBytes: bytes.byteLength,
      sha256,
    };
    known.set(entry.path, entry.updatedAt);
  }
  await blob(
    LEDGER,
    new TextEncoder().encode(
      JSON.stringify({
        files: Object.fromEntries(
          Object.entries(files)
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .slice(0, 2000),
        ),
        syncedAt: manifest.syncedAt,
        checkedThrough: have.at(-1) ?? "",
      }),
    ),
  );
  signal.throwIfAborted();
  const committed = await world.commitShell({
    baseRevision: revision,
    reads: { paths: [...reads], children: [...children] },
    entries: [...entries.values()],
    deleted,
  });
  if (committed.status !== "committed")
    throw new Error(
      "Drive changed during hydration; sandbox hydration required.",
    );
  return known;
};
