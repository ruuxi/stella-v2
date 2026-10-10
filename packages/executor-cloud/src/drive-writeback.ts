/**
 * Save what a turn changed under `/workspace/world/drive` back to the drive.
 *
 * The drive (owner-store rows + R2 bytes) is the only durable home of the
 * user's files: the world never stores its `drive/` subtree, so a sandbox's
 * copy lives on this disk only and is gone when the sandbox is. Hydration
 * (`drive-sync.ts`) is the read half; this is the write half, and it runs
 * once the agent has finished:
 *
 *  - a file the turn created or changed is saved — inline below the inline
 *    limit, through a staged presigned PUT above it, so a file of any size
 *    the plan allows reaches the drive with its bytes;
 *  - a file the turn deleted is deleted from the drive, but only while the
 *    drive still holds the exact version this disk had;
 *  - a file the reply links is saved too when the drive does not have it yet
 *    (an earlier turn's unsaved work), and becomes the turn's files card.
 *
 * "Changed during this turn" is measured against a snapshot taken right after
 * hydration, before any agent process existed, by inode identity — so a copy
 * that diverged in an earlier turn (a conflict, or a file the user deleted
 * from the drive) is left alone unless this turn touches or links it. Every
 * byte read goes through the descriptor boundary, the same as delivery always
 * has: a path is an agent-chosen string, and only singly-linked files owned
 * by the tool account are read, from the opened descriptor.
 */

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { withWorkspaceFileNoFollow } from "@stella/runtime/kernel/tools/workspace-file-boundary.js";
import { renderEvidenceThumbnail } from "@stella/runtime/kernel/shared/evidence-thumbnail.js";
import {
  EVIDENCE_THUMBNAIL_CONTENT_TYPE,
  evidenceThumbnailDrivePath,
  isEvidenceThumbnailDrivePath,
} from "@stella/contracts/chat-evidence-thumbnails";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import {
  readDriveLedgerFiles,
  recordDriveWriteBack,
  type DriveLedgerEntry,
  type DriveSyncResult,
} from "./drive-sync.js";
import {
  collectProducedFiles,
  contentTypeFor,
  PRODUCED_FILE_AUTHORIZED_BYTES,
  reportProducedFiles,
  type ProducedFileReport,
} from "./produced-files.js";


type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

/** Drive path → the identity of the file standing there. */
export type DriveTreeSnapshot = ReadonlyMap<string, FileIdentity>;

/** Entries one walk visits; a larger tree is saved over several turns. */
const WALK_MAX_ENTRIES = 20_000;
/** Files one turn saves; the rest are named in the report. */
const SAVE_MAX_FILES = 200;
/** Inline bytes held in memory before they are sent. */
const INLINE_FLUSH_BYTES = 32 * 1024 * 1024;
/** Files read per collection, so a flush is never far past that bound. */
const COLLECT_BATCH = 8;
/** Deletions one turn applies. */
const DELETE_MAX_FILES = 500;
const DELETE_BATCH = 100;
const STAGE_BATCH = 25;
/** The largest file any plan accepts; anything larger is not even staged. */
const FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PUT_TIMEOUT_MS = 10 * 60_000;
const PUT_CHUNK_BYTES = 1024 * 1024;
/** Reply-linked files the card shows, as produced files always have. */
const CARD_MAX_FILES = 25;
const NOTICE_MAX_REASONS = 12;
const THUMBNAIL_MAX_FILES = 12;
/** Mirrors the drive's own path rules (`normalizeDrivePath`). */
const DRIVE_PATH_MAX = 400;
const DRIVE_SEGMENT_MAX = 255;

/** Never part of the drive: hydration's own state, and dependency installs. */
const UNSAVED_DIRECTORIES = new Set([".stella", "node_modules"]);

const identityOf = (stat: FileIdentity): FileIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  size: Number(stat.size),
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const walkDriveTree = async (
  root: string,
): Promise<{ files: Map<string, FileIdentity>; truncated: boolean }> => {
  const files = new Map<string, FileIdentity>();
  let visited = 0;
  let truncated = false;
  const walk = async (relative: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(relative ? path.join(root, relative) : root);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (visited >= WALK_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      visited += 1;
      if (UNSAVED_DIRECTORIES.has(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      // Names only: every byte is read later through the descriptor
      // boundary, which refuses whatever a link here could point at.
      const stat = await lstat(path.join(root, child)).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(child);
        continue;
      }
      if (stat.isFile()) files.set(child, identityOf(stat));
    }
  };
  await walk("");
  return { files, truncated };
};

/**
 * The drive tree as it stands once hydration finished, before any agent
 * process exists: the baseline "changed during this turn" is measured from.
 */
export const snapshotDriveTree = async (
  driveRoot: string,
): Promise<DriveTreeSnapshot> => (await walkDriveTree(path.resolve(driveRoot))).files;

const validDrivePath = (relative: string): boolean =>
  relative.length > 0 &&
  relative.length <= DRIVE_PATH_MAX &&
  relative
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= DRIVE_SEGMENT_MAX &&
        segment !== "." &&
        segment !== ".." &&
        !/[\u0000-\u001f\u007f\\]/u.test(segment),
    );

/** The reply's links that name files under the drive root, in link order. */
const linkedDrivePaths = (
  linked: readonly string[],
  root: string,
): string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of linked) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const relative = path.relative(root, path.resolve(root, trimmed));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const drivePath = relative.split(path.sep).join("/");
    if (drivePath.split("/").some((segment) => UNSAVED_DIRECTORIES.has(segment))) {
      continue;
    }
    if (seen.has(drivePath)) continue;
    seen.add(drivePath);
    paths.push(drivePath);
  }
  return paths;
};

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export type DriveWriteBack = {
  /** The reply-linked files the drive now holds: the turn's files card. */
  files: ProducedFileReport[];
  /** Sentences for the agent's report about what did not go as asked. */
  notice: string;
  /** Drive paths saved this turn, under the path each landed at. */
  saved: string[];
  /** Drive paths this turn deleted from the drive. */
  deleted: string[];
};

type LargeFile = {
  path: string;
  absolute: string;
  sizeBytes: number;
  sha256: string;
};

export const writeBackDrive = async (options: {
  turnId: string;
  driveRoot: string;
  /** Hydration's state directory, where the ledger lives. */
  stateDir: string;
  /** The fixed tool account that owns every file the agent wrote. */
  identity: ToolProcessIdentity;
  sync: DriveSyncResult;
  before: DriveTreeSnapshot;
  /** Paths linked in the turn's final reply; agent-chosen strings. */
  linked: readonly string[];
  post: (route: string, body: unknown) => Promise<Response>;
  fetchImpl?: typeof fetch;
}): Promise<DriveWriteBack> => {
  const root = path.resolve(options.driveRoot);
  const owner = { uid: options.identity.uid, gid: options.identity.gid };
  const ledger = options.sync.ledger.files;
  // Another turn sharing this sandbox may have saved a file since this one
  // hydrated: its ledger entry spares this turn from saving the same bytes
  // again under a version it never read.
  const current = await readDriveLedgerFiles({
    workspaceRoot: root,
    stateDir: options.stateDir,
    owner,
  });
  const savedEntries = new Map<string, DriveLedgerEntry>();
  const removedEntries = new Set<string>();
  const reasons: string[] = [];
  const after = await walkDriveTree(root);

  const linked = linkedDrivePaths(options.linked, root);
  const changed = [...after.files.entries()]
    .filter(([drivePath, identity]) => {
      const prior = options.before.get(drivePath);
      return !prior || !sameIdentity(prior, identity);
    })
    .map(([drivePath]) => drivePath)
    .sort();
  // Linked first, so the files the reply hands over are the ones a cap spares.
  const candidates = [
    ...new Set([
      ...linked.filter((drivePath) => after.files.has(drivePath)),
      ...changed,
    ]),
  ];
  const invalid = candidates.filter((drivePath) => !validDrivePath(drivePath));
  for (const drivePath of invalid.slice(0, 3)) {
    reasons.push(
      `${drivePath} is not a name the drive accepts, so it was not saved to the drive.`,
    );
  }
  const savable = candidates.filter(
    (drivePath) => validDrivePath(drivePath) && !isEvidenceThumbnailDrivePath(drivePath),
  );
  const overflow = savable.slice(SAVE_MAX_FILES);
  if (overflow.length > 0) {
    reasons.push(
      `${overflow.length} more changed ${overflow.length === 1 ? "file" : "files"} under drive/ (${overflow.slice(0, 5).join(", ")}${overflow.length > 5 ? ", …" : ""}) ${overflow.length === 1 ? "was" : "were"} not saved to the drive this turn.`,
    );
  }

  const matchesLedger = (drivePath: string, size: number, sha256: string) =>
    [ledger.get(drivePath), current.get(drivePath)].some(
      (held) => held?.sizeBytes === size && held.sha256 === sha256,
    );

  const inSync = new Map<string, number>();
  const savedPaths: string[] = [];
  const cardSaved = new Map<string, { path: string; sizeBytes: number }>();
  const shaOf = new Map<string, { sha256: string; sizeBytes: number }>();
  const unreadable: string[] = [];
  const inline: ProducedFileReport[] = [];
  let inlineBytes = 0;
  const large: LargeFile[] = [];
  let reports = 0;
  const linkedSet = new Set(linked);
  const landed = new Map<string, string>();
  const thumbnails = new Map<string, Uint8Array>();
  const keepThumbnail = async (drivePath: string, bytes: Uint8Array) => {
    if (thumbnails.size >= THUMBNAIL_MAX_FILES) return;
    if (!evidenceThumbnailDrivePath(drivePath)) return;
    const thumbnail = await renderEvidenceThumbnail(bytes);
    if (thumbnail) thumbnails.set(drivePath, thumbnail);
  };

  const report = async (files: ProducedFileReport[]): Promise<void> => {
    if (files.length === 0) return;
    const delivery = await reportProducedFiles({
      turnId: options.turnId,
      files,
      known: options.sync.known,
      uploads: options.sync.uploads,
      post: options.post,
      batchPrefix: `writeback-${reports}-`,
    });
    reports += 1;
    const renamedBy = new Map(delivery.renamed.map((entry) => [entry.from, entry.to]));
    for (const file of files) {
      file[PRODUCED_FILE_AUTHORIZED_BYTES]?.fill(0);
      const landedAt = renamedBy.get(file.path) ?? file.path;
      if (!delivery.stored.has(landedAt)) continue;
      landed.set(file.path, landedAt);
      savedPaths.push(landedAt);
      cardSaved.set(file.path, { path: landedAt, sizeBytes: file.sizeBytes });
      const version = delivery.versions.get(landedAt);
      const hashed = shaOf.get(file.path);
      // Saved where it stands: this disk now holds exactly that row version.
      // Saved beside it instead: the copy here is still not the drive's, and
      // the ledger keeps saying what this disk last held for that path.
      if (landedAt === file.path && version !== undefined && hashed) {
        savedEntries.set(file.path, {
          updatedAt: version,
          sizeBytes: hashed.sizeBytes,
          sha256: hashed.sha256,
        });
      }
    }
    reasons.push(
      ...delivery.renamed.map((entry) => entry.reason),
      ...delivery.skipped.map((entry) => entry.reason),
      ...delivery.replaced.map((entry) => entry.reason),
    );
  };

  // Read through the same boundary delivery always used, a few files at a
  // time so inline bytes waiting to be sent stay bounded.
  const toSave = savable.slice(0, SAVE_MAX_FILES);
  for (let index = 0; index < toSave.length; index += COLLECT_BATCH) {
    const chunk = toSave.slice(index, index + COLLECT_BATCH);
    const collected = await collectProducedFiles({
      workspaceRoot: root,
      processIdentity: options.identity,
      linked: chunk.map((drivePath) => path.join(root, drivePath)),
      gitAware: false,
      drivePrefix: "",
      limit: chunk.length,
    }).catch(() => ({ files: [] as ProducedFileReport[], omitted: [] }));
    const authorized = new Set(collected.files.map((file) => file.path));
    unreadable.push(...chunk.filter((drivePath) => !authorized.has(drivePath)));
    for (const file of collected.files) {
      if (file.sizeBytes >= FILE_MAX_BYTES) {
        reasons.push(`${file.path} is larger than any drive file can be, so it was not saved.`);
        continue;
      }
      const bytes = file[PRODUCED_FILE_AUTHORIZED_BYTES];
      if (bytes) {
        const sha256 = sha256Hex(bytes);
        if (matchesLedger(file.path, bytes.byteLength, sha256)) {
          if (linkedSet.has(file.path)) await keepThumbnail(file.path, bytes);
          bytes.fill(0);
          inSync.set(file.path, bytes.byteLength);
          continue;
        }
        shaOf.set(file.path, { sha256, sizeBytes: bytes.byteLength });
        await keepThumbnail(file.path, bytes);
        inline.push(file);
        inlineBytes += bytes.byteLength;
        continue;
      }
      // At or above the inline limit the collection carries no bytes; the
      // hash comes from the authorized descriptor, as the upload will.
      const absolute = path.join(root, file.path);
      const sha256 = await withWorkspaceFileNoFollow(
        absolute,
        root,
        async (handle, opened) => {
          const hash = createHash("sha256");
          const buffer = Buffer.alloc(PUT_CHUNK_BYTES);
          for (let offset = 0; offset < opened.size; ) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead === 0) throw new Error("The file shrank while it was read.");
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          return hash.digest("hex");
        },
        { owner },
      ).catch(() => null);
      if (!sha256) {
        unreadable.push(file.path);
        continue;
      }
      if (matchesLedger(file.path, file.sizeBytes, sha256)) {
        inSync.set(file.path, file.sizeBytes);
        continue;
      }
      shaOf.set(file.path, { sha256, sizeBytes: file.sizeBytes });
      large.push({ path: file.path, absolute, sizeBytes: file.sizeBytes, sha256 });
    }
    if (inlineBytes >= INLINE_FLUSH_BYTES) {
      await report(inline.splice(0));
      inlineBytes = 0;
    }
  }
  await report(inline.splice(0));

  // Files too large to carry inline go straight to the drive's storage under
  // a presigned PUT, streamed from the authorized descriptor, then land with
  // the same report — and the same write rules — as everything else.
  for (let index = 0; index < large.length; index += STAGE_BATCH) {
    const group = large.slice(index, index + STAGE_BATCH);
    const staged = await options
      .post("/api/cloud/drive/stage", {
        turnId: options.turnId,
        files: group.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes })),
      })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as {
              uploads?: Array<{ path?: string; uploadId?: string; url?: string }>;
              skipped?: Array<{ path?: string; reason?: string }>;
            })
          : null,
      )
      .catch(() => null);
    if (!staged) {
      for (const file of group) {
        reasons.push(`${file.path} could not be saved to the drive, so it is only in this sandbox.`);
      }
      continue;
    }
    for (const entry of staged.skipped ?? []) {
      if (entry.path && entry.reason) reasons.push(entry.reason);
    }
    const uploads = new Map(
      (staged.uploads ?? []).flatMap((entry) =>
        entry.path && entry.uploadId && entry.url
          ? [[entry.path, { uploadId: entry.uploadId, url: entry.url }] as const]
          : [],
      ),
    );
    const ready: ProducedFileReport[] = [];
    for (const file of group) {
      const upload = uploads.get(file.path);
      if (!upload) continue;
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const contentType = contentTypeFor(name);
      const put = await withWorkspaceFileNoFollow(
        file.absolute,
        root,
        async (handle, opened) => {
          if (opened.size !== file.sizeBytes) return false;
          const hash = createHash("sha256");
          const chunks = async function* (): AsyncGenerator<Buffer> {
            for (let offset = 0; offset < file.sizeBytes; ) {
              const chunk = Buffer.alloc(Math.min(PUT_CHUNK_BYTES, file.sizeBytes - offset));
              const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
              if (bytesRead === 0) throw new Error("The file shrank while it was saved.");
              const part = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
              hash.update(part);
              offset += bytesRead;
              yield part;
            }
          };
          const init: RequestInit & { duplex: "half" } = {
            method: "PUT",
            headers: {
              "content-length": String(file.sizeBytes),
              "content-type": contentType,
            },
            body: Readable.from(chunks()) as never,
            duplex: "half",
            signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
          };
          const response = await (options.fetchImpl ?? fetch)(upload.url, init);
          await response.body?.cancel().catch(() => undefined);
          const settled = await handle.stat();
          // The bytes sent are the bytes hashed, and the file did not move
          // under the descriptor while they were read.
          return (
            response.ok &&
            hash.digest("hex") === file.sha256 &&
            settled.size === opened.size &&
            settled.mtimeMs === opened.mtimeMs &&
            settled.ctimeMs === opened.ctimeMs
          );
        },
        { owner },
      ).catch(() => false);
      if (!put) {
        reasons.push(
          `${file.path} changed or failed while it was being saved, so the drive does not have this version.`,
        );
        continue;
      }
      ready.push({
        path: file.path,
        name,
        sizeBytes: file.sizeBytes,
        contentType,
        uploadId: upload.uploadId,
      });
    }
    await report(ready);
  }

  const thumbnailReports: ProducedFileReport[] = [];
  for (const [drivePath, thumbnail] of thumbnails) {
    const landedAt = landed.get(drivePath) ?? (inSync.has(drivePath) ? drivePath : null);
    const thumbnailPath = landedAt ? evidenceThumbnailDrivePath(landedAt) : null;
    if (!thumbnailPath) continue;
    thumbnailReports.push({
      path: thumbnailPath,
      name: thumbnailPath.slice(thumbnailPath.lastIndexOf("/") + 1),
      sizeBytes: thumbnail.byteLength,
      contentType: EVIDENCE_THUMBNAIL_CONTENT_TYPE,
      [PRODUCED_FILE_AUTHORIZED_BYTES]: Buffer.from(thumbnail),
    });
  }
  if (thumbnailReports.length > 0) {
    await reportProducedFiles({
      turnId: options.turnId,
      files: thumbnailReports,
      post: options.post,
      batchPrefix: "thumbnails-",
    }).catch(() => undefined);
  }

  for (const drivePath of unreadable.slice(0, 5)) {
    reasons.push(
      `${drivePath} is not a regular file this sandbox can read safely, so it was not saved to the drive.`,
    );
  }

  // Deletions: a file present when the turn began and gone now, removed from
  // the drive only while the drive still has the version this disk held.
  const deletions: Array<{ path: string; knownUpdatedAt: number }> = [];
  for (const drivePath of options.before.keys()) {
    if (after.files.has(drivePath) || deletions.length >= DELETE_MAX_FILES) continue;
    const knownUpdatedAt =
      options.sync.known.get(drivePath) ?? ledger.get(drivePath)?.updatedAt;
    if (knownUpdatedAt === undefined || !validDrivePath(drivePath)) continue;
    const gone = await lstat(path.join(root, drivePath)).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    if (gone) deletions.push({ path: drivePath, knownUpdatedAt });
  }
  const deleted: string[] = [];
  for (let index = 0; index < deletions.length; index += DELETE_BATCH) {
    const group = deletions.slice(index, index + DELETE_BATCH);
    const answer = await options
      .post("/api/cloud/drive/delete", { turnId: options.turnId, files: group })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as {
              deleted?: string[];
              kept?: Array<{ path?: string; reason?: string }>;
            })
          : null,
      )
      .catch(() => null);
    if (!answer) {
      reasons.push(
        `Deleting ${group.length === 1 ? group[0]!.path : `${group.length} files`} from the drive failed, so the drive still has ${group.length === 1 ? "it" : "them"}.`,
      );
      continue;
    }
    for (const drivePath of answer.deleted ?? []) {
      deleted.push(drivePath);
      removedEntries.add(drivePath);
    }
    for (const entry of answer.kept ?? []) {
      if (entry.reason) reasons.push(entry.reason);
    }
  }

  if (savedEntries.size > 0 || removedEntries.size > 0) {
    await recordDriveWriteBack({
      workspaceRoot: root,
      stateDir: options.stateDir,
      owner,
      saved: savedEntries,
      removed: removedEntries,
      fallback: options.sync.ledger,
    }).catch((error) => {
      // The next turn re-reads the drive and downloads what it cannot vouch
      // for; nothing saved here is lost by a stale ledger.
      console.error(
        `drive ledger write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // The card: what the reply links and the drive now holds.
  const files: ProducedFileReport[] = [];
  const cardOverflow: string[] = [];
  for (const drivePath of linked) {
    const saved = cardSaved.get(drivePath);
    const held = inSync.get(drivePath);
    if (!saved && held === undefined) continue;
    const landedAt = saved?.path ?? drivePath;
    if (files.length >= CARD_MAX_FILES) {
      cardOverflow.push(landedAt);
      continue;
    }
    const name = landedAt.slice(landedAt.lastIndexOf("/") + 1);
    files.push({
      path: landedAt,
      name,
      sizeBytes: saved?.sizeBytes ?? held!,
      contentType: contentTypeFor(name),
    });
  }
  if (cardOverflow.length > 0) {
    reasons.unshift(
      `Only ${files.length} of the files this reply links are shown here; the other ${cardOverflow.length} (${cardOverflow.slice(0, 5).join(", ")}${cardOverflow.length > 5 ? ", …" : ""}) are saved in the drive.`,
    );
  }
  if (after.truncated) {
    reasons.push(
      "The drive folder holds more entries than one turn checks, so some changes may be saved on a later turn.",
    );
  }
  const shown = reasons.slice(0, NOTICE_MAX_REASONS);
  const hidden = reasons.length - shown.length;
  const notice =
    shown.length > 0
      ? `\n\nHeads up: ${shown.join(" ")}${hidden > 0 ? ` (${hidden} more not listed.)` : ""}`
      : "";
  return { files, notice, saved: savedPaths, deleted };
};
