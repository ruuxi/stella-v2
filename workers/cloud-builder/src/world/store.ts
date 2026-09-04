import { sha256BytesHex, sha256Hex } from "../hash.js";
import {
  baseName,
  normalizeWorldPath,
  parentPath,
  pathWithin,
} from "./path.js";
import { executeWorldTool, type WorldToolFileApi } from "./tools.js";
import { IncrementalSha256 } from "./sha256.js";
import {
  WORLD_CHUNK_BYTES,
  WORLD_CHANGE_LOG_MAX_ROWS,
  WORLD_FILE_LIMIT_BYTES,
  WORLD_QUOTA_BYTES,
  WORLD_R2_THRESHOLD_BYTES,
  WORLD_READ_LIMIT_BYTES,
  type WorldEntry,
  type WorldChanges,
  type WorldListingEntry,
  type WorldToolCall,
  type WorldToolResult,
} from "./types.js";

type NodeRow = {
  node_id: number;
  kind: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  blob_sha256: string | null;
  target: string | null;
};

type EntryRow = NodeRow & { path: string };
type BlobRow = { sha256: string; size: number; storage: "sqlite" | "r2" };
type ChunkRow = { bytes: ArrayBuffer };
type UploadPartRow = { ordinal: number; bytes: ArrayBuffer };
type HeadRow = { value: string };
type ManifestRow = { manifest_id: string; parent_manifest_id: string | null };
type ContainerSize = "small" | "large";
type ChangeKind = "upsert" | "delete";
type ChangeRow = { revision: number; path: string; kind: ChangeKind };

const encoder = new TextEncoder();

export const WORLD_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS world_chunks(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL)",
  "CREATE TABLE IF NOT EXISTS world_blobs(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, storage TEXT NOT NULL CHECK(storage IN ('sqlite','r2')))",
  "CREATE TABLE IF NOT EXISTS world_blob_chunks(blob_sha256 TEXT NOT NULL, ordinal INTEGER NOT NULL, chunk_sha256 TEXT NOT NULL, PRIMARY KEY(blob_sha256, ordinal))",
  "CREATE TABLE IF NOT EXISTS world_nodes(node_id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('file','dir','symlink')), mode INTEGER NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, blob_sha256 TEXT, target TEXT)",
  "CREATE TABLE IF NOT EXISTS world_dirents(manifest_id TEXT NOT NULL, parent_path TEXT NOT NULL, name TEXT NOT NULL, node_id INTEGER NOT NULL, PRIMARY KEY(manifest_id, parent_path, name))",
  "CREATE TABLE IF NOT EXISTS world_manifests(manifest_id TEXT PRIMARY KEY, parent_manifest_id TEXT, history_cursor TEXT, created_at INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS world_tombstones(manifest_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(manifest_id, path))",
  "CREATE TABLE IF NOT EXISTS world_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS world_changes(revision INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('upsert','delete')), PRIMARY KEY(revision, path))",
  "CREATE TABLE IF NOT EXISTS world_uploads(upload_id TEXT PRIMARY KEY, size INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS world_upload_parts(upload_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(upload_id, ordinal))",
  "CREATE TABLE IF NOT EXISTS world_blob_pins(sha256 TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS world_dirents_manifest ON world_dirents(manifest_id)",
  "CREATE INDEX IF NOT EXISTS world_nodes_blob ON world_nodes(blob_sha256)",
  "CREATE INDEX IF NOT EXISTS world_blob_chunks_chunk ON world_blob_chunks(chunk_sha256)",
  "CREATE INDEX IF NOT EXISTS world_changes_revision ON world_changes(revision)",
] as const;

const byteView = (value: ArrayBuffer | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const rowEntry = (row: EntryRow): WorldEntry => ({
  path: row.path,
  kind: row.kind,
  mode: row.mode,
  mtime: row.mtime,
  size: row.size,
  ...(row.blob_sha256 ? { sha256: row.blob_sha256 } : {}),
  ...(row.target !== null ? { target: row.target } : {}),
});

const direntParts = (path: string): { parent: string; name: string } => ({
  parent: parentPath(path),
  name: baseName(path),
});

const tarOctal = (value: number, length: number): Uint8Array =>
  encoder.encode(value.toString(8).padStart(length - 1, "0") + "\0");

const tarString = (value: string, length: number): Uint8Array => {
  const output = new Uint8Array(length);
  output.set(encoder.encode(value).subarray(0, length));
  return output;
};

const tarHeader = (entry: WorldEntry): Uint8Array => {
  const header = new Uint8Array(512);
  let name = entry.kind === "dir" ? `${entry.path}/` : entry.path;
  let prefix = "";
  if (encoder.encode(name).byteLength > 100) {
    const split = [...name.matchAll(/\//gu)]
      .map((match) => match.index)
      .filter(
        (index): index is number =>
          index > 0 &&
          encoder.encode(name.slice(0, index)).byteLength <= 155 &&
          encoder.encode(name.slice(index + 1)).byteLength <= 100,
      )
      .at(-1);
    if (split === undefined) {
      throw new Error(`Path is too long for ustar export: ${entry.path}`);
    }
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }
  if (
    entry.kind === "symlink" &&
    encoder.encode(entry.target ?? "").byteLength > 100
  ) {
    throw new Error(
      `Symlink target is too long for ustar export: ${entry.path}`,
    );
  }
  header.set(tarString(name, 100), 0);
  header.set(tarOctal(entry.mode & 0o7777, 8), 100);
  header.set(tarOctal(0, 8), 108);
  header.set(tarOctal(0, 8), 116);
  header.set(tarOctal(entry.kind === "file" ? entry.size : 0, 12), 124);
  header.set(tarOctal(Math.floor(entry.mtime / 1000), 12), 136);
  header.fill(0x20, 148, 156);
  header[156] =
    entry.kind === "file" ? 0x30 : entry.kind === "dir" ? 0x35 : 0x32;
  if (entry.target) header.set(tarString(entry.target, 100), 157);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  header.set(tarString(prefix, 155), 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(
    encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "),
    148,
  );
  return header;
};

export class WorldSqlStore implements WorldToolFileApi {
  private pendingChanges: Map<string, ChangeKind> | null = null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: Pick<R2Bucket, "get" | "put" | "delete">,
    private readonly now: () => number = Date.now,
  ) {}

  initialize(): void {
    for (const statement of WORLD_SCHEMA) this.sql.exec(statement);
    const head = this.sql
      .exec<HeadRow>("SELECT value FROM world_meta WHERE key = 'head'")
      .toArray()[0];
    if (head) return;
    const live = `live:${crypto.randomUUID()}`;
    this.sql.exec(
      "INSERT INTO world_manifests(manifest_id, parent_manifest_id, history_cursor, created_at, sealed) VALUES (?, NULL, NULL, ?, 0)",
      live,
      this.now(),
    );
    this.sql.exec(
      "INSERT INTO world_meta(key, value) VALUES ('head', ?)",
      live,
    );
    this.sql.exec(
      "INSERT INTO world_meta(key, value) VALUES ('revision', '0'), ('change_floor', '0')",
    );
  }

  private metaInteger(key: "revision" | "change_floor"): number {
    const value = Number(
      this.sql
        .exec<HeadRow>("SELECT value FROM world_meta WHERE key = ?", key)
        .one().value,
    );
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid world ${key}.`);
    }
    return value;
  }

  private revision(): number {
    return this.metaInteger("revision");
  }

  private noteChange(path: string, kind: ChangeKind): void {
    if (!this.pendingChanges) {
      throw new Error("World change was recorded outside a mutation.");
    }
    this.pendingChanges.set(path, kind);
  }

  /**
   * One live-manifest operation owns one revision. Later operations win for
   * the same path; there are deliberately no file locks or merge checks.
   */
  private async mutate<T>(operation: () => Promise<T> | T): Promise<{
    value: T;
    revision: number;
  }> {
    const outer = this.pendingChanges === null;
    if (outer) this.pendingChanges = new Map();
    try {
      const value = await operation();
      if (!outer) return { value, revision: this.revision() };
      const changes = this.pendingChanges!;
      if (changes.size === 0) return { value, revision: this.revision() };
      const revision = this.revision() + 1;
      this.sql.exec(
        "UPDATE world_meta SET value = ? WHERE key = 'revision'",
        String(revision),
      );
      for (const [path, kind] of changes) {
        this.sql.exec(
          "INSERT INTO world_changes(revision, path, kind) VALUES (?, ?, ?)",
          revision,
          path,
          kind,
        );
      }
      const count = this.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM world_changes")
        .one().count;
      if (count > WORLD_CHANGE_LOG_MAX_ROWS) {
        this.sql.exec("DELETE FROM world_changes");
        this.sql.exec(
          "UPDATE world_meta SET value = ? WHERE key = 'change_floor'",
          String(revision),
        );
      }
      return { value, revision };
    } finally {
      if (outer) this.pendingChanges = null;
    }
  }

  private liveManifest(): string {
    return this.sql
      .exec<HeadRow>("SELECT value FROM world_meta WHERE key = 'head'")
      .one().value;
  }

  selectContainerSize(initial: ContainerSize): ContainerSize {
    if (initial !== "small" && initial !== "large") {
      throw new TypeError("Invalid world container size.");
    }
    const existing = this.sql
      .exec<HeadRow>("SELECT value FROM world_meta WHERE key = 'containerSize'")
      .toArray()[0]?.value;
    if (existing === "small" || existing === "large") return existing;
    this.sql.exec(
      "INSERT INTO world_meta(key, value) VALUES ('containerSize', ?)",
      initial,
    );
    return initial;
  }

  rememberContainerSize(size: ContainerSize): void {
    if (size !== "small" && size !== "large") {
      throw new TypeError("Invalid world container size.");
    }
    this.sql.exec(
      "INSERT INTO world_meta(key, value) VALUES ('containerSize', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      size,
    );
  }

  private entryRow(
    path: string,
    manifestId = this.liveManifest(),
  ): EntryRow | null {
    const parts = direntParts(path);
    return (
      this.sql
        .exec<EntryRow>(
          `SELECT (? || CASE WHEN parent_path = '' THEN '' ELSE '/' END || name) AS path,
              n.node_id, n.kind, n.mode, n.mtime, n.size, n.blob_sha256, n.target
         FROM world_dirents d JOIN world_nodes n ON n.node_id = d.node_id
        WHERE d.manifest_id = ? AND d.parent_path = ? AND d.name = ?`,
          parts.parent,
          manifestId,
          parts.parent,
          parts.name,
        )
        .toArray()[0] ?? null
    );
  }

  async stat(input: string): Promise<WorldEntry | null> {
    const path = normalizeWorldPath(input, { allowRoot: true });
    if (path === "")
      return { path: "", kind: "dir", mode: 0o755, mtime: 0, size: 0 };
    const row = this.entryRow(path);
    return row ? rowEntry(row) : null;
  }

  async list(
    input: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ entries: WorldEntry[]; cursor?: string }> {
    const prefix = normalizeWorldPath(input, { allowRoot: true });
    const cursor = options.cursor ? normalizeWorldPath(options.cursor) : "";
    const limit = Math.max(
      1,
      Math.min(10_000, Math.floor(options.limit ?? 1_000)),
    );
    const manifest = this.liveManifest();
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END AS path,
              n.node_id, n.kind, n.mode, n.mtime, n.size, n.blob_sha256, n.target
         FROM world_dirents d JOIN world_nodes n ON n.node_id = d.node_id
        WHERE d.manifest_id = ?
          AND (? = '' OR (CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END) = ?
            OR (CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END) LIKE ?)
          AND (CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END) > ?
        ORDER BY path LIMIT ?`,
        manifest,
        prefix,
        prefix,
        `${prefix}/%`,
        cursor,
        limit + 1,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map(rowEntry);
    const next = hasMore ? entries.at(-1)?.path : undefined;
    return { entries, ...(next ? { cursor: next } : {}) };
  }

  private async allEntries(prefix: string): Promise<WorldEntry[]> {
    const entries: WorldEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(prefix, {
        ...(cursor ? { cursor } : {}),
        limit: 10_000,
      });
      entries.push(...page.entries);
      if (!page.cursor) return entries;
      cursor = page.cursor;
    }
  }

  private blobRow(sha256: string): BlobRow | null {
    return (
      this.sql
        .exec<BlobRow>(
          "SELECT sha256, size, storage FROM world_blobs WHERE sha256 = ?",
          sha256,
        )
        .toArray()[0] ?? null
    );
  }

  private async storeBlob(
    bytes: Uint8Array,
    expectedSha?: string,
  ): Promise<string> {
    if (bytes.byteLength > WORLD_FILE_LIMIT_BYTES)
      throw new Error("File exceeds the 256 MiB world file limit.");
    const sha256 = await sha256BytesHex(bytes);
    if (expectedSha && expectedSha !== sha256)
      throw new Error(
        `Blob sha256 mismatch: expected ${expectedSha}, received ${sha256}.`,
      );
    if (this.blobRow(sha256)) return sha256;
    if (bytes.byteLength > WORLD_R2_THRESHOLD_BYTES) {
      await this.bucket.put(`blobs/${sha256}`, bytes);
      this.sql.exec(
        "INSERT OR IGNORE INTO world_blobs(sha256, size, storage) VALUES (?, ?, 'r2')",
        sha256,
        bytes.byteLength,
      );
      return sha256;
    }
    for (
      let offset = 0, ordinal = 0;
      offset < bytes.byteLength || (bytes.byteLength === 0 && ordinal === 0);
      offset += WORLD_CHUNK_BYTES, ordinal += 1
    ) {
      const chunk = bytes.slice(
        offset,
        Math.min(bytes.byteLength, offset + WORLD_CHUNK_BYTES),
      );
      const chunkSha = await sha256BytesHex(chunk);
      this.sql.exec(
        "INSERT OR IGNORE INTO world_chunks(sha256, size, bytes) VALUES (?, ?, ?)",
        chunkSha,
        chunk.byteLength,
        chunk,
      );
      this.sql.exec(
        "INSERT INTO world_blob_chunks(blob_sha256, ordinal, chunk_sha256) VALUES (?, ?, ?)",
        sha256,
        ordinal,
        chunkSha,
      );
    }
    this.sql.exec(
      "INSERT INTO world_blobs(sha256, size, storage) VALUES (?, ?, 'sqlite')",
      sha256,
      bytes.byteLength,
    );
    return sha256;
  }

  private async blobBytes(
    sha256: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const blob = this.blobRow(sha256);
    if (!blob) throw new Error(`Missing world blob ${sha256}.`);
    if (length === 0) return new Uint8Array();
    if (blob.storage === "r2") {
      const object = await this.bucket.get(`blobs/${sha256}`, {
        range: { offset, length },
      });
      if (!object) throw new Error(`Missing world R2 blob ${sha256}.`);
      return new Uint8Array(await object.arrayBuffer());
    }
    const first = Math.floor(offset / WORLD_CHUNK_BYTES);
    const last = Math.floor(
      Math.max(offset, offset + length - 1) / WORLD_CHUNK_BYTES,
    );
    const rows = this.sql
      .exec<ChunkRow>(
        `SELECT c.bytes FROM world_blob_chunks bc JOIN world_chunks c ON c.sha256 = bc.chunk_sha256
        WHERE bc.blob_sha256 = ? AND bc.ordinal BETWEEN ? AND ? ORDER BY bc.ordinal`,
        sha256,
        first,
        last,
      )
      .toArray();
    const joined = new Uint8Array(
      rows.reduce((total, row) => total + byteView(row.bytes).byteLength, 0),
    );
    let cursor = 0;
    for (const row of rows) {
      const bytes = byteView(row.bytes);
      joined.set(bytes, cursor);
      cursor += bytes.byteLength;
    }
    const inside = offset - first * WORLD_CHUNK_BYTES;
    return joined.slice(inside, inside + length);
  }

  async readFile(
    input: string,
    options: { offset?: number; length?: number } = {},
  ): Promise<Uint8Array | null> {
    const path = normalizeWorldPath(input);
    const row = this.entryRow(path);
    if (!row) return null;
    if (row.kind !== "file" || !row.blob_sha256)
      throw new Error(`Path is not a file: ${path}`);
    if (
      options.offset !== undefined &&
      (!Number.isSafeInteger(options.offset) || options.offset < 0)
    ) {
      throw new Error("readFile offset must be a non-negative integer.");
    }
    if (
      options.length !== undefined &&
      (!Number.isSafeInteger(options.length) || options.length < 0)
    ) {
      throw new Error("readFile length must be a non-negative integer.");
    }
    const offset = options.offset ?? 0;
    const available = Math.max(0, row.size - offset);
    const requested =
      options.length ?? Math.min(available, WORLD_READ_LIMIT_BYTES);
    if (requested > WORLD_READ_LIMIT_BYTES)
      throw new Error("readFile length exceeds 8 MiB.");
    return this.blobBytes(
      row.blob_sha256,
      offset,
      Math.min(available, requested),
    );
  }

  private ensureParents(path: string, manifest = this.liveManifest()): void {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.entryRow(current, manifest);
      if (existing) {
        if (existing.kind !== "dir")
          throw new Error(`Parent path is not a directory: ${current}`);
        continue;
      }
      const node = this.sql
        .exec<{
          node_id: number;
        }>(
          "INSERT INTO world_nodes(kind, mode, mtime, size, blob_sha256, target) VALUES ('dir', 493, ?, 0, NULL, NULL) RETURNING node_id",
          this.now(),
        )
        .one();
      const parts = direntParts(current);
      this.sql.exec(
        "INSERT INTO world_dirents(manifest_id, parent_path, name, node_id) VALUES (?, ?, ?, ?)",
        manifest,
        parts.parent,
        parts.name,
        node.node_id,
      );
      this.noteChange(current, "upsert");
    }
  }

  private putNode(
    entry: WorldListingEntry,
    manifest = this.liveManifest(),
  ): WorldEntry {
    const path = normalizeWorldPath(entry.path);
    this.ensureParents(path, manifest);
    const mtime = entry.mtime ?? this.now();
    const node = this.sql
      .exec<{
        node_id: number;
      }>(
        "INSERT INTO world_nodes(kind, mode, mtime, size, blob_sha256, target) VALUES (?, ?, ?, ?, ?, ?) RETURNING node_id",
        entry.kind,
        entry.mode,
        mtime,
        entry.size,
        entry.sha256 ?? null,
        entry.target ?? null,
      )
      .one();
    const parts = direntParts(path);
    this.sql.exec(
      "INSERT INTO world_dirents(manifest_id, parent_path, name, node_id) VALUES (?, ?, ?, ?) ON CONFLICT(manifest_id, parent_path, name) DO UPDATE SET node_id = excluded.node_id",
      manifest,
      parts.parent,
      parts.name,
      node.node_id,
    );
    this.sql.exec(
      "DELETE FROM world_tombstones WHERE manifest_id = ? AND path = ?",
      manifest,
      path,
    );
    this.noteChange(path, "upsert");
    return {
      path,
      kind: entry.kind,
      mode: entry.mode,
      mtime,
      size: entry.size,
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(entry.target !== undefined ? { target: entry.target } : {}),
    };
  }

  async writeFile(
    input: string,
    bytes: Uint8Array,
    options: { mode?: number; mtime?: number } = {},
  ): Promise<WorldEntry & { revision: number }> {
    const mutation = await this.mutate(async () => {
      const path = normalizeWorldPath(input);
      if (bytes.byteLength > WORLD_READ_LIMIT_BYTES)
        throw new Error(
          "writeFile bytes exceed 8 MiB; use beginBlob/appendBlob/finishBlob.",
        );
      const manifest = this.liveManifest();
      const prior = this.entryRow(path, manifest);
      if (prior && prior.kind !== "file")
        throw new Error(`Path is not a file: ${path}`);
      const projectedSize = (await this.allEntries(""))
        .filter((entry) => entry.kind === "file" && entry.path !== path)
        .reduce((total, entry) => total + entry.size, bytes.byteLength);
      if (projectedSize > WORLD_QUOTA_BYTES)
        throw new Error("world_quota_exceeded");
      const sha256 = await this.storeBlob(bytes);
      return this.putNode(
        {
          path,
          kind: "file",
          mode: options.mode ?? prior?.mode ?? 0o644,
          mtime: options.mtime ?? this.now(),
          size: bytes.byteLength,
          sha256,
        },
        manifest,
      );
    });
    return { ...mutation.value, revision: mutation.revision };
  }

  async mkdir(
    input: string,
    options: { mode?: number } = {},
  ): Promise<{ revision: number }> {
    const mutation = await this.mutate(async () => {
      const path = normalizeWorldPath(input);
      const existing = this.entryRow(path);
      if (existing) {
        if (existing.kind !== "dir")
          throw new Error(
            `Path already exists and is not a directory: ${path}`,
          );
        return;
      }
      this.putNode({
        path,
        kind: "dir",
        mode: options.mode ?? 0o755,
        mtime: this.now(),
        size: 0,
      });
    });
    return { revision: mutation.revision };
  }

  async remove(
    input: string,
    options: { recursive?: boolean } = {},
  ): Promise<{ revision: number }> {
    const mutation = await this.mutate(async () => {
      const path = normalizeWorldPath(input);
      const manifest = this.liveManifest();
      const parentManifest = this.sql
        .exec<ManifestRow>(
          "SELECT manifest_id, parent_manifest_id FROM world_manifests WHERE manifest_id = ?",
          manifest,
        )
        .one().parent_manifest_id;
      const entries = await this.allEntries(path);
      if (entries.length === 0) throw new Error(`Path not found: ${path}`);
      if (!options.recursive && entries.some((entry) => entry.path !== path))
        throw new Error(`Directory is not empty: ${path}`);
      for (const entry of entries.sort(
        (left, right) => right.path.length - left.path.length,
      )) {
        const parts = direntParts(entry.path);
        this.sql.exec(
          "DELETE FROM world_dirents WHERE manifest_id = ? AND parent_path = ? AND name = ?",
          manifest,
          parts.parent,
          parts.name,
        );
        if (parentManifest && this.entryRow(entry.path, parentManifest)) {
          this.sql.exec(
            "INSERT OR IGNORE INTO world_tombstones(manifest_id, path) VALUES (?, ?)",
            manifest,
            entry.path,
          );
        } else {
          this.sql.exec(
            "DELETE FROM world_tombstones WHERE manifest_id = ? AND path = ?",
            manifest,
            entry.path,
          );
        }
        this.noteChange(entry.path, "delete");
      }
    });
    return { revision: mutation.revision };
  }

  async rename(
    fromInput: string,
    toInput: string,
  ): Promise<{ revision: number }> {
    const mutation = await this.mutate(async () => {
      const from = normalizeWorldPath(fromInput);
      const to = normalizeWorldPath(toInput);
      if (pathWithin(to, from))
        throw new Error("Cannot rename a path into itself.");
      const entries = await this.allEntries(from);
      if (entries.length === 0) throw new Error(`Path not found: ${from}`);
      if (await this.stat(to)) throw new Error(`Path already exists: ${to}`);
      const manifest = this.liveManifest();
      this.ensureParents(to, manifest);
      for (const entry of entries) {
        const suffix = entry.path.slice(from.length);
        const nextPath = `${to}${suffix}`;
        const row = this.entryRow(entry.path, manifest);
        if (!row) continue;
        const parts = direntParts(nextPath);
        this.sql.exec(
          "INSERT INTO world_dirents(manifest_id, parent_path, name, node_id) VALUES (?, ?, ?, ?)",
          manifest,
          parts.parent,
          parts.name,
          row.node_id,
        );
        this.noteChange(nextPath, "upsert");
      }
      await this.remove(from, { recursive: true });
    });
    return { revision: mutation.revision };
  }

  async symlink(input: string, target: string): Promise<{ revision: number }> {
    const mutation = await this.mutate(async () => {
      const path = normalizeWorldPath(input);
      if (this.entryRow(path)) throw new Error(`Path already exists: ${path}`);
      this.putNode({
        path,
        kind: "symlink",
        mode: 0o777,
        mtime: this.now(),
        size: encoder.encode(target).byteLength,
        target,
      });
    });
    return { revision: mutation.revision };
  }

  async beginBlob(): Promise<{ uploadId: string }> {
    const uploadId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO world_uploads(upload_id, size) VALUES (?, 0)",
      uploadId,
    );
    return { uploadId };
  }

  async appendBlob(uploadId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > WORLD_READ_LIMIT_BYTES)
      throw new Error("appendBlob bytes exceed 8 MiB.");
    const upload = this.sql
      .exec<{
        size: number;
      }>("SELECT size FROM world_uploads WHERE upload_id = ?", uploadId)
      .toArray()[0];
    if (!upload) throw new Error("Unknown blob upload.");
    if (upload.size + bytes.byteLength > WORLD_FILE_LIMIT_BYTES)
      throw new Error("File exceeds the 256 MiB world file limit.");
    const ordinalStart = this.sql
      .exec<{
        next_ordinal: number;
      }>(
        "SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal FROM world_upload_parts WHERE upload_id = ?",
        uploadId,
      )
      .one().next_ordinal;
    let ordinal = ordinalStart;
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += WORLD_CHUNK_BYTES
    ) {
      this.sql.exec(
        "INSERT INTO world_upload_parts(upload_id, ordinal, bytes) VALUES (?, ?, ?)",
        uploadId,
        ordinal,
        bytes.slice(offset, offset + WORLD_CHUNK_BYTES),
      );
      ordinal += 1;
    }
    this.sql.exec(
      "UPDATE world_uploads SET size = size + ? WHERE upload_id = ?",
      bytes.byteLength,
      uploadId,
    );
  }

  async finishBlob(
    uploadId: string,
    options: { path?: string; sha256?: string; mode?: number; mtime?: number },
  ): Promise<WorldEntry & { revision: number }> {
    const upload = this.sql
      .exec<{
        size: number;
      }>("SELECT size FROM world_uploads WHERE upload_id = ?", uploadId)
      .toArray()[0];
    if (!upload) throw new Error("Unknown blob upload.");
    const parts = this.sql
      .exec<UploadPartRow>(
        "SELECT ordinal, bytes FROM world_upload_parts WHERE upload_id = ? ORDER BY ordinal",
        uploadId,
      )
      .toArray();
    const hasher = new IncrementalSha256();
    for (const part of parts) hasher.update(byteView(part.bytes));
    const sha256 = hasher.digestHex();
    if (options.sha256 && options.sha256 !== sha256) {
      this.sql.exec(
        "DELETE FROM world_upload_parts WHERE upload_id = ?",
        uploadId,
      );
      this.sql.exec("DELETE FROM world_uploads WHERE upload_id = ?", uploadId);
      throw new Error(
        `Blob sha256 mismatch: expected ${options.sha256}, received ${sha256}.`,
      );
    }
    const path = options.path ? normalizeWorldPath(options.path) : undefined;
    const manifest = this.liveManifest();
    const prior = path ? this.entryRow(path, manifest) : null;
    if (prior && prior.kind !== "file")
      throw new Error(`Path is not a file: ${path}`);
    if (path) {
      const projectedSize = (await this.allEntries(""))
        .filter((entry) => entry.kind === "file" && entry.path !== path)
        .reduce((total, entry) => total + entry.size, upload.size);
      if (projectedSize > WORLD_QUOTA_BYTES)
        throw new Error("world_quota_exceeded");
    }
    if (!this.blobRow(sha256)) {
      if (upload.size > WORLD_R2_THRESHOLD_BYTES) {
        const stream = new FixedLengthStream(upload.size);
        const writer = stream.writable.getWriter();
        const uploadPromise = this.bucket.put(
          `blobs/${sha256}`,
          stream.readable,
        );
        for (const part of parts) await writer.write(byteView(part.bytes));
        await writer.close();
        await uploadPromise;
        this.sql.exec(
          "INSERT OR IGNORE INTO world_blobs(sha256, size, storage) VALUES (?, ?, 'r2')",
          sha256,
          upload.size,
        );
      } else {
        for (const part of parts) {
          const chunk = byteView(part.bytes);
          const chunkSha = await sha256BytesHex(chunk);
          this.sql.exec(
            "INSERT OR IGNORE INTO world_chunks(sha256, size, bytes) VALUES (?, ?, ?)",
            chunkSha,
            chunk.byteLength,
            chunk,
          );
          this.sql.exec(
            "INSERT INTO world_blob_chunks(blob_sha256, ordinal, chunk_sha256) VALUES (?, ?, ?)",
            sha256,
            part.ordinal,
            chunkSha,
          );
        }
        if (parts.length === 0) {
          const empty = new Uint8Array();
          const chunkSha = await sha256BytesHex(empty);
          this.sql.exec(
            "INSERT OR IGNORE INTO world_chunks(sha256, size, bytes) VALUES (?, 0, ?)",
            chunkSha,
            empty,
          );
          this.sql.exec(
            "INSERT INTO world_blob_chunks(blob_sha256, ordinal, chunk_sha256) VALUES (?, 0, ?)",
            sha256,
            chunkSha,
          );
        }
        this.sql.exec(
          "INSERT INTO world_blobs(sha256, size, storage) VALUES (?, ?, 'sqlite')",
          sha256,
          upload.size,
        );
      }
    }
    this.sql.exec(
      "DELETE FROM world_upload_parts WHERE upload_id = ?",
      uploadId,
    );
    this.sql.exec("DELETE FROM world_uploads WHERE upload_id = ?", uploadId);
    if (!path) {
      this.sql.exec(
        "INSERT INTO world_blob_pins(sha256, expires_at) VALUES (?, ?) ON CONFLICT(sha256) DO UPDATE SET expires_at = excluded.expires_at",
        sha256,
        this.now() + 10 * 60_000,
      );
      return {
        path: "",
        kind: "file",
        mode: options.mode ?? 0o644,
        mtime: options.mtime ?? this.now(),
        size: upload.size,
        sha256,
        revision: this.revision(),
      };
    }
    const mutation = await this.mutate(() =>
      this.putNode({
        path,
        kind: "file",
        mode: options.mode ?? prior?.mode ?? 0o644,
        mtime: options.mtime ?? this.now(),
        size: upload.size,
        sha256,
      }),
    );
    return { ...mutation.value, revision: mutation.revision };
  }

  async tool(call: WorldToolCall): Promise<WorldToolResult> {
    const result = await executeWorldTool(this, call);
    return { ...result, revision: this.revision() };
  }

  private manifestEntries(
    manifestId: string,
    cursor: string,
    limit: number,
  ): EntryRow[] {
    return this.sql
      .exec<EntryRow>(
        `SELECT CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END AS path,
              n.node_id, n.kind, n.mode, n.mtime, n.size, n.blob_sha256, n.target
         FROM world_dirents d JOIN world_nodes n ON n.node_id = d.node_id
        WHERE d.manifest_id = ? AND (CASE WHEN d.parent_path = '' THEN d.name ELSE d.parent_path || '/' || d.name END) > ?
        ORDER BY path LIMIT ?`,
        manifestId,
        cursor,
        limit,
      )
      .toArray();
  }

  async checkpoint(options: {
    historyCursor: string;
  }): Promise<{ manifestId: string }> {
    const live = this.liveManifest();
    const entries: WorldEntry[] = [];
    let cursor = "";
    for (;;) {
      const page = this.manifestEntries(live, cursor, 10_000).map(rowEntry);
      entries.push(...page);
      if (page.length < 10_000) break;
      cursor = page.at(-1)?.path ?? cursor;
    }
    const tuples = entries.map((entry) => [
      entry.path,
      entry.kind,
      entry.mode,
      entry.size,
      entry.sha256 ?? null,
      entry.target ?? null,
    ]);
    const manifestId = await sha256Hex(JSON.stringify(tuples));
    const existing = this.sql
      .exec<{
        manifest_id: string;
      }>(
        "SELECT manifest_id FROM world_manifests WHERE manifest_id = ? AND sealed = 1",
        manifestId,
      )
      .toArray()[0];
    if (existing) {
      this.sql.exec("DELETE FROM world_dirents WHERE manifest_id = ?", live);
      this.sql.exec("DELETE FROM world_tombstones WHERE manifest_id = ?", live);
      this.sql.exec("DELETE FROM world_manifests WHERE manifest_id = ?", live);
      this.sql.exec(
        "UPDATE world_manifests SET history_cursor = ? WHERE manifest_id = ?",
        options.historyCursor,
        manifestId,
      );
    } else {
      this.sql.exec(
        "UPDATE world_manifests SET manifest_id = ?, history_cursor = ?, sealed = 1 WHERE manifest_id = ?",
        manifestId,
        options.historyCursor,
        live,
      );
      this.sql.exec(
        "UPDATE world_dirents SET manifest_id = ? WHERE manifest_id = ?",
        manifestId,
        live,
      );
      this.sql.exec(
        "UPDATE world_tombstones SET manifest_id = ? WHERE manifest_id = ?",
        manifestId,
        live,
      );
    }
    const next = `live:${crypto.randomUUID()}`;
    this.sql.exec(
      "INSERT INTO world_manifests(manifest_id, parent_manifest_id, history_cursor, created_at, sealed) VALUES (?, ?, NULL, ?, 0)",
      next,
      manifestId,
      this.now(),
    );
    this.sql.exec(
      "INSERT INTO world_dirents(manifest_id, parent_path, name, node_id) SELECT ?, parent_path, name, node_id FROM world_dirents WHERE manifest_id = ?",
      next,
      manifestId,
    );
    this.sql.exec("UPDATE world_meta SET value = ? WHERE key = 'head'", next);
    await this.collectGarbage(100);
    return { manifestId };
  }

  async manifest(
    manifestId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ entries: WorldEntry[]; cursor?: string } | null> {
    const exists = this.sql
      .exec<{
        manifest_id: string;
      }>(
        "SELECT manifest_id FROM world_manifests WHERE manifest_id = ?",
        manifestId,
      )
      .toArray()[0];
    if (!exists) return null;
    const limit = Math.max(
      1,
      Math.min(10_000, Math.floor(options.limit ?? 1_000)),
    );
    const rows = this.manifestEntries(
      manifestId,
      options.cursor ?? "",
      limit + 1,
    );
    const entries = rows.slice(0, limit).map(rowEntry);
    const cursor = rows.length > limit ? entries.at(-1)?.path : undefined;
    return { entries, ...(cursor ? { cursor } : {}) };
  }

  async head(): Promise<{ manifestId: string; parentManifestId?: string }> {
    const live = this.liveManifest();
    const row = this.sql
      .exec<ManifestRow>(
        "SELECT manifest_id, parent_manifest_id FROM world_manifests WHERE manifest_id = ?",
        live,
      )
      .one();
    return {
      manifestId: live,
      ...(row.parent_manifest_id
        ? { parentManifestId: row.parent_manifest_id }
        : {}),
    };
  }

  async diff(
    listing: WorldListingEntry[],
  ): Promise<{ changed: string[]; deleted: string[] }> {
    const current = new Map(
      (await this.allEntries("")).map((entry) => [entry.path, entry]),
    );
    const incoming = new Map(
      listing.map((entry) => [normalizeWorldPath(entry.path), entry]),
    );
    const changed: string[] = [];
    for (const [path, entry] of incoming) {
      const existing = current.get(path);
      if (
        !existing ||
        existing.kind !== entry.kind ||
        existing.mode !== entry.mode ||
        existing.mtime !== (entry.mtime ?? existing.mtime) ||
        existing.size !== entry.size ||
        existing.sha256 !== entry.sha256 ||
        existing.target !== entry.target
      )
        changed.push(path);
    }
    const deleted = [...current.keys()].filter((path) => !incoming.has(path));
    return { changed: changed.sort(), deleted: deleted.sort() };
  }

  async pushDiff(input: {
    entries: WorldListingEntry[];
    deleted: string[];
  }): Promise<{ missingBlobs: string[]; revision: number }> {
    const missing = new Set<string>();
    for (const entry of input.entries) {
      normalizeWorldPath(entry.path);
      if (
        !Number.isSafeInteger(entry.mode) ||
        entry.mode < 0 ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      ) {
        throw new Error(`Invalid world listing entry: ${entry.path}`);
      }
      if (entry.kind !== "file") continue;
      if (!entry.sha256)
        throw new Error(`File listing is missing sha256: ${entry.path}`);
      const blob = this.blobRow(entry.sha256);
      if (!blob) missing.add(entry.sha256);
      else if (blob.size !== entry.size)
        throw new Error(`Blob size mismatch for ${entry.path}.`);
    }
    if (missing.size > 0) {
      return { missingBlobs: [...missing].sort(), revision: this.revision() };
    }
    const projected = new Map(
      (await this.allEntries("")).map((entry) => [entry.path, entry]),
    );
    for (const deleted of input.deleted) {
      const path = normalizeWorldPath(deleted);
      for (const candidate of projected.keys())
        if (pathWithin(candidate, path)) projected.delete(candidate);
    }
    for (const entry of input.entries) {
      projected.set(entry.path, {
        ...entry,
        mtime: entry.mtime ?? this.now(),
      });
    }
    const projectedSize = [...projected.values()]
      .filter((entry) => entry.kind === "file")
      .reduce((total, entry) => total + entry.size, 0);
    if (projectedSize > WORLD_QUOTA_BYTES)
      throw new Error("world_quota_exceeded");
    const mutation = await this.mutate(async () => {
      for (const path of input.deleted.sort(
        (left, right) => right.length - left.length,
      )) {
        if (await this.stat(path)) await this.remove(path, { recursive: true });
      }
      for (const entry of [...input.entries].sort(
        (left, right) => left.path.length - right.path.length,
      )) {
        this.putNode(entry);
        if (entry.kind === "file" && entry.sha256) {
          this.sql.exec(
            "DELETE FROM world_blob_pins WHERE sha256 = ?",
            entry.sha256,
          );
        }
      }
    });
    return { missingBlobs: [], revision: mutation.revision };
  }

  async changesSince(revision: number): Promise<WorldChanges> {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("World revision must be a non-negative integer.");
    }
    const current = this.revision();
    const floor = this.metaInteger("change_floor");
    if (revision < floor) {
      return {
        revision: current,
        entries: [],
        deleted: [],
        resync: true,
      };
    }
    if (revision >= current) {
      return {
        revision: current,
        entries: [],
        deleted: [],
        resync: false,
      };
    }
    const next = this.sql
      .exec<{
        revision: number;
      }>("SELECT MIN(revision) AS revision FROM world_changes WHERE revision > ?", revision)
      .toArray()[0]?.revision;
    if (!Number.isSafeInteger(next)) {
      return {
        revision: current,
        entries: [],
        deleted: [],
        resync: false,
      };
    }
    const rows = this.sql
      .exec<ChangeRow>(
        "SELECT revision, path, kind FROM world_changes WHERE revision = ? ORDER BY path",
        next,
      )
      .toArray();
    const entries: WorldEntry[] = [];
    const deleted: string[] = [];
    for (const row of rows) {
      if (row.kind === "delete") {
        deleted.push(row.path);
        continue;
      }
      const entry = this.entryRow(row.path);
      if (entry) entries.push(rowEntry(entry));
      else deleted.push(row.path);
    }
    return {
      revision: next!,
      entries,
      deleted,
      resync: false,
    };
  }

  exportBlob(
    sha256: string,
  ): { size: number; body: ReadableStream<Uint8Array> } | null {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) return null;
    const blob = this.blobRow(sha256);
    if (!blob) return null;
    const store = this;
    let offset = 0;
    return {
      size: blob.size,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (offset >= blob.size) {
            controller.close();
            return;
          }
          const length = Math.min(WORLD_READ_LIMIT_BYTES, blob.size - offset);
          controller.enqueue(await store.blobBytes(sha256, offset, length));
          offset += length;
        },
      }),
    };
  }

  exportTar(manifestId = this.liveManifest()): {
    revision: number;
    body: ReadableStream<Uint8Array>;
  } {
    const store = this;
    async function* generate(): AsyncGenerator<Uint8Array> {
      let cursor = "";
      while (true) {
        const rows = store.manifestEntries(manifestId, cursor, 256);
        if (rows.length === 0) break;
        for (const row of rows) {
          const entry = rowEntry(row);
          yield tarHeader(entry);
          if (entry.kind === "file" && entry.sha256) {
            for (
              let offset = 0;
              offset < entry.size;
              offset += WORLD_READ_LIMIT_BYTES
            )
              yield await store.blobBytes(
                entry.sha256,
                offset,
                Math.min(WORLD_READ_LIMIT_BYTES, entry.size - offset),
              );
            const padding = (512 - (entry.size % 512)) % 512;
            if (padding) yield new Uint8Array(padding);
          }
        }
        cursor = rows.at(-1)?.path ?? cursor;
      }
      yield new Uint8Array(1024);
    }
    const iterator = generate();
    return {
      revision: this.revision(),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      }),
    };
  }

  async collectGarbage(limit: number): Promise<boolean> {
    this.sql.exec(
      "DELETE FROM world_blob_pins WHERE expires_at <= ?",
      this.now(),
    );
    const blobs = this.sql
      .exec<BlobRow>(
        `SELECT b.sha256, b.size, b.storage FROM world_blobs b
        WHERE NOT EXISTS (
          SELECT 1 FROM world_nodes n JOIN world_dirents d ON d.node_id = n.node_id
           WHERE n.blob_sha256 = b.sha256
        ) AND NOT EXISTS (
          SELECT 1 FROM world_blob_pins p WHERE p.sha256 = b.sha256
        ) LIMIT ?`,
        limit,
      )
      .toArray();
    for (const blob of blobs) {
      if (blob.storage === "r2")
        await this.bucket.delete(`blobs/${blob.sha256}`);
      this.sql.exec(
        "DELETE FROM world_blob_chunks WHERE blob_sha256 = ?",
        blob.sha256,
      );
      this.sql.exec("DELETE FROM world_blobs WHERE sha256 = ?", blob.sha256);
    }
    this.sql.exec(
      "DELETE FROM world_chunks WHERE NOT EXISTS (SELECT 1 FROM world_blob_chunks bc WHERE bc.chunk_sha256 = world_chunks.sha256)",
    );
    this.sql.exec(
      "DELETE FROM world_nodes WHERE NOT EXISTS (SELECT 1 FROM world_dirents d WHERE d.node_id = world_nodes.node_id)",
    );
    return blobs.length === limit;
  }
}
