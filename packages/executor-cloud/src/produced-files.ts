/**
 * Produced-file reporting for a cloud agent turn.
 *
 * The agent's own reply names what a turn delivered: the file list is derived
 * from the markdown links in the turn's final assistant message(s), the same
 * contract the local lane uses. A linked path is deliberate by construction —
 * the model wrote it into the reply — which is what a filesystem diff could
 * never tell apart from a dependency install.
 *
 * Reported files are registered in Convex and, when small enough, uploaded to
 * R2 so the chat surface can hand them back to the user. Anything larger stays
 * in the checkpointed workspace and is reported as metadata only.
 *
 * A linked path is a string the agent chose, so every candidate is opened
 * component-by-component beneath the workspace descriptor and required to be
 * a singly-linked, workspace-owned regular file. Small-file bytes are retained
 * from that authorization; delivery never reopens the linked pathname.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import {
  readWorkspaceFileNoFollow,
  statWorkspaceFileNoFollow,
} from "@stella/runtime/kernel/tools/workspace-file-boundary.js";

/**
 * Stable bytes authorized through the workspace descriptor boundary.
 *
 * A non-enumerable symbol keeps these bytes out of object spreading and JSON
 * while the trusted executor carries a report from collection to delivery.
 * Delivery is deliberately unable to fall back to a path if this field is
 * absent.
 */
export const PRODUCED_FILE_AUTHORIZED_BYTES = Symbol(
  "stella.produced-file.authorized-bytes",
);

export type ProducedFileReport = {
  /**
   * Drive-relative POSIX path, no leading slash (contract C3). Non-drive
   * workspaces are namespaced here rather than in the Convex route, because
   * the chat surface resolves the path it sees in the `output_files` event
   * straight against the drive — the two have to be the same string.
   */
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  /** Trusted-host-only bytes; omitted from JSON and never reconstructed. */
  [PRODUCED_FILE_AUTHORIZED_BYTES]?: Buffer;
};

/** What a turn produced, and what did not fit the report. */
export type ProducedFileCollection = {
  files: ProducedFileReport[];
  /** Deliverables the cap left behind, as drive paths, for the agent's report. */
  omitted: string[];
};

/** The wire shape of one file in the C4 report and the `output_files` event. */
export const toDriveFile = (file: ProducedFileReport) => ({
  path: file.path,
  name: file.name,
  sizeBytes: file.sizeBytes,
  contentType: file.contentType,
});

/** Files at or above this size are registered but not uploaded inline. */
const INLINE_LIMIT_BYTES = 8 * 1024 * 1024;
/** A turn that "produced" more than this is reporting churn, not deliverables. */
const MAX_REPORTED_FILES = 25;

// The tool host's private state directory: in a cloud workspace it holds
// shell state, not deliverables, so a link into it is never delivered.
const STATE_DIR_SEGMENT = ".stella";

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

const contentTypeFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return (
    CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ??
    "application/octet-stream"
  );
};

const safeFileSize = (size: number | bigint): number | null => {
  if (typeof size === "bigint") {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(size);
  }
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
};

const toWorkspaceRelative = (
  absolutePath: string,
  workspaceRoot: string,
): string | null => {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
};

const assertStrictProcessIdentity = (identity: ToolProcessIdentity): void => {
  if (identity.requireNoNewPrivileges !== true) {
    throw new Error(
      "Cloud produced-file processes require the strict tool identity.",
    );
  }
};

/** Pure launch builder retained as focused evidence for the privilege fence. */
export const buildProducedFilesGitCheckIgnoreLaunch = (
  identity: ToolProcessIdentity,
  platform: NodeJS.Platform = process.platform,
) => {
  assertStrictProcessIdentity(identity);
  return isolateToolProcessLaunch({
    command: "/usr/bin/git",
    commandArgs: ["check-ignore", "--stdin", "-z"],
    identity,
    platform,
  });
};

/**
 * A project workspace is a git checkout: build output, caches and local
 * env files are exactly the paths its `.gitignore` already names.
 */
const filterGitIgnored = async (
  workspaceRoot: string,
  relativePaths: string[],
  identity: ToolProcessIdentity,
): Promise<string[]> =>
  new Promise((resolve) => {
    const launch = buildProducedFilesGitCheckIgnoreLaunch(identity);
    const child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: identity.home,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LOGNAME: identity.user,
        PATH: "/usr/bin:/bin",
        USER: identity.user,
      },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15_000,
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.on("error", () => resolve(relativePaths));
    child.on("close", () => {
      const ignored = new Set(
        Buffer.concat(stdout).toString("utf8").split("\0").filter(Boolean),
      );
      resolve(relativePaths.filter((value) => !ignored.has(value)));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${relativePaths.join("\0")}\0`);
  });

/**
 * Turn the reply's linked paths into the deliverables worth reporting.
 *
 * `linked` paths come from markdown links in the turn's final assistant
 * message(s): each is deliberate — the model wrote it into the reply — so no
 * churn heuristics apply. They are still agent-chosen strings, so each one is
 * resolved against the workspace root and refused if it escapes it or names
 * the tool host's state directory, before the descriptor-boundary
 * authorization below ever sees it.
 *
 * The 25-file report is spent in link order, and whatever it cannot fit comes
 * back as `omitted` so the turn can say so.
 *
 * `gitAware` runs the surviving paths past `.gitignore`, which is only
 * meaningful for a project checkout.
 */
export const collectProducedFiles = async (options: {
  workspaceRoot: string;
  /** Fixed Cloud identity used for both subprocesses and workspace ownership. */
  processIdentity: ToolProcessIdentity;
  /** Untrusted paths linked in the turn's final assistant message(s). */
  linked: readonly string[];
  gitAware: boolean;
  /** Drive folder this workspace's files land under; "" for the drive itself. */
  drivePrefix: string;
}): Promise<ProducedFileCollection> => {
  assertStrictProcessIdentity(options.processIdentity);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const linked of options.linked) {
    const trimmed = linked.trim();
    if (!trimmed) continue;
    const relative = toWorkspaceRelative(
      path.resolve(options.workspaceRoot, trimmed),
      options.workspaceRoot,
    );
    if (!relative || seen.has(relative)) continue;
    if (relative.split("/").includes(STATE_DIR_SEGMENT)) continue;
    seen.add(relative);
    candidates.push(relative);
  }
  if (candidates.length === 0) return { files: [], omitted: [] };

  const tracked = options.gitAware
    ? await filterGitIgnored(
        options.workspaceRoot,
        candidates,
        options.processIdentity,
      )
    : candidates;

  const workspaceRoot = path.resolve(options.workspaceRoot);
  const owner = {
    uid: options.processIdentity.uid,
    gid: options.processIdentity.gid,
  };
  const files: ProducedFileReport[] = [];
  const omitted: string[] = [];
  for (const relative of tracked) {
    const candidatePath = path.join(workspaceRoot, relative);
    const metadata = await statWorkspaceFileNoFollow(
      candidatePath,
      workspaceRoot,
      { owner },
    ).catch(() => null);
    if (!metadata) continue;
    const metadataSize = safeFileSize(metadata.size);
    if (metadataSize === null) continue;
    const drivePath = `${options.drivePrefix}${relative}`;
    if (files.length >= MAX_REPORTED_FILES) {
      omitted.push(drivePath);
      continue;
    }

    // Only bytes opened and held by the descriptor-safe boundary may leave the
    // workspace. A later rename/symlink swap is harmless because delivery has
    // no pathname to reopen. Large files remain metadata-only by contract.
    let authorizedBytes: Buffer | undefined;
    let sizeBytes = metadataSize;
    if (metadataSize < INLINE_LIMIT_BYTES) {
      const authorized = await readWorkspaceFileNoFollow(
        candidatePath,
        workspaceRoot,
        INLINE_LIMIT_BYTES - 1,
        { owner },
      ).catch(() => null);
      if (!authorized) continue;
      authorizedBytes = authorized.bytes;
      const authorizedSize = safeFileSize(authorized.stat.size);
      if (authorizedSize === null) {
        authorizedBytes.fill(0);
        continue;
      }
      sizeBytes = authorizedSize;
      if (authorizedBytes.byteLength !== sizeBytes) {
        authorizedBytes.fill(0);
        continue;
      }
    }
    const name = relative.split("/").pop() ?? relative;
    const report: ProducedFileReport = {
      path: drivePath,
      name,
      sizeBytes,
      contentType: contentTypeFor(name),
    };
    if (authorizedBytes) {
      Object.defineProperty(report, PRODUCED_FILE_AUTHORIZED_BYTES, {
        configurable: false,
        enumerable: false,
        value: authorizedBytes,
        writable: false,
      });
    }
    files.push(report);
  }
  return { files, omitted };
};

/** What the drive did with a turn's report, per path. */
export type ProducedFileDelivery = {
  /** Paths whose bytes actually reached the drive. */
  stored: Set<string>;
  /** Paths the drive refused, with the reason to put in front of the user. */
  skipped: Array<{ path: string; reason: string }>;
  /** Paths saved under a different name to protect a file the user uploaded. */
  renamed: Array<{ from: string; to: string; reason: string }>;
  /**
   * Paths that landed on a drive row this turn never read. Not a refusal —
   * these are delivered — but the turn hydrates a bounded window of the drive,
   * so this is the only place a user learns that the file their agent "wrote"
   * had a previous version it never opened.
   */
  replaced: Array<{ path: string; reason: string }>;
};

/**
 * Register the reported files with Convex, uploading bytes for everything
 * under the inline limit. Batched so one request never carries more than the
 * inline limit's worth of content.
 *
 * `known` carries, per drive path, the row version this turn hydrated. The
 * route only lets an agent write replace a file the user uploaded when that
 * version still matches, so a path missing from this map is a path the turn
 * never read — and its write is diverted rather than allowed to destroy the
 * upload.
 *
 * No batch failure is ever thrown, for the same reason a 413 is not: the
 * batches before it are already in the owner's drive, charged against their
 * quota, and losing their result means the user gets no card for files that
 * were delivered and a report telling them nothing was. A batch that cannot be
 * delivered becomes a per-file `skipped` verdict for its own files only.
 */
export const reportProducedFiles = async (options: {
  turnId: string;
  files: ProducedFileReport[];
  known?: ReadonlyMap<string, number>;
  /**
   * Of `known`, the paths whose rows the drive protects from a write that did
   * not read them. Re-sending one of these after a lost response is the one
   * case where a retry is not a repeat but a second writer, so these are the
   * paths this checks before it retries.
   */
  uploads?: ReadonlySet<string>;
  post: (route: string, body: unknown) => Promise<Response>;
}): Promise<ProducedFileDelivery> => {
  type Payload = ReturnType<typeof toDriveFile> & {
    contentBase64?: string;
    knownUpdatedAt?: number;
  };
  const batches: Payload[][] = [];
  let batch: Payload[] = [];
  let batchBytes = 0;
  for (const file of options.files) {
    const knownUpdatedAt = options.known?.get(file.path);
    let payload: Payload = {
      ...toDriveFile(file),
      ...(knownUpdatedAt === undefined ? {} : { knownUpdatedAt }),
    };
    if (file.sizeBytes < INLINE_LIMIT_BYTES) {
      const bytes = file[PRODUCED_FILE_AUTHORIZED_BYTES];
      if (bytes && bytes.byteLength === file.sizeBytes) {
        payload = {
          ...payload,
          contentBase64: Buffer.from(bytes).toString("base64"),
        };
      }
    }
    const cost = payload.contentBase64 ? file.sizeBytes : 0;
    if (batch.length > 0 && batchBytes + cost > INLINE_LIMIT_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(payload);
    batchBytes += cost;
  }
  if (batch.length > 0) batches.push(batch);

  // A file too large to send inline is registered as metadata only, so
  // offering the user a download for it would hand them a URL with nothing
  // behind it.
  const delivery: ProducedFileDelivery = {
    stored: new Set<string>(),
    skipped: [],
    renamed: [],
    replaced: [],
  };
  // 413 is "nothing in this batch landed", which the per-file reasons in its
  // body already explain; any other failure has no body worth reading and is
  // answered with a null, so a single transient 5xx costs one retry rather
  // than the batch.
  //
  // `batchKey` names the batch, not the attempt: every delivery of one batch
  // carries the same key, and the route records it on the rows it writes. That
  // is what lets a redelivery be recognised as the same writer rather than a
  // second one, whose stale version token would otherwise divert it to an
  // "(agent copy)" sibling. The turn id is what makes it unique — the index
  // only has to separate the batches of one turn — and it deliberately does
  // not depend on the entries, so a retry that carries fewer of them (below,
  // once the settled ones are dropped) is still the same batch.
  const send = async (
    entries: Payload[],
    batchKey: string,
  ): Promise<Response | null> => {
    const response = await options
      .post("/api/cloud/drive/files", {
        turnId: options.turnId,
        batchKey,
        files: entries,
      })
      .catch(() => null);
    return response && (response.ok || response.status === 413)
      ? response
      : null;
  };

  /**
   * Which of these entries the drive already holds — the answer a lost
   * response did not carry. The route commits before it replies, so a batch
   * whose reply never arrived may be applied, half-applied or untouched, and
   * the manifest is the only thing that knows which.
   *
   * `since` at the current clock asks for no tombstones: this is a version
   * read, and deletions are the hydration half's business. Null means the
   * question could not be answered at all.
   */
  const applied = async (entries: Payload[]): Promise<Set<string> | null> => {
    const response = await options
      .post("/api/cloud/drive/sync", {
        turnId: options.turnId,
        include: entries.map((entry) => entry.path),
        since: Date.now(),
      })
      .catch(() => null);
    if (!response?.ok) return null;
    const manifest = (await response.json().catch(() => null)) as {
      files?: Array<{ path?: string; sizeBytes?: number; updatedAt?: number }>;
      skipped?: Array<{ path?: string; sizeBytes?: number }>;
    } | null;
    if (!manifest) return null;
    const rows = new Map<string, { sizeBytes?: number; updatedAt?: number }>();
    // A file too large to send inline registers as a metadata-only row, which
    // the manifest reports as skipped rather than as something to hydrate.
    for (const row of [
      ...(manifest.files ?? []),
      ...(manifest.skipped ?? []),
    ]) {
      if (typeof row.path === "string" && !rows.has(row.path)) {
        rows.set(row.path, row);
      }
    }
    const landed = new Set<string>();
    for (const entry of entries) {
      const row = rows.get(entry.path);
      // The row carries this attempt's bytes at a version that is no longer
      // the one the batch echoed: the lost response was a committed write.
      if (
        row &&
        row.sizeBytes === entry.sizeBytes &&
        row.updatedAt !== entry.knownUpdatedAt
      ) {
        landed.add(entry.path);
      }
    }
    return landed;
  };

  for (const [index, entries] of batches.entries()) {
    const batchKey = String(index);
    let attempt = entries;
    let response = await send(attempt, batchKey);
    if (!response) {
      // A blind re-send is a repeat write for every path the agent owns, and
      // those the route simply overwrites with the same bytes. For a file the
      // user uploaded it is not: if the first attempt committed, it moved the
      // row version this payload echoes, so the identical retry reads as a
      // writer that never opened the file and is diverted to an "(agent copy)"
      // sibling of the file it just correctly updated. Those paths are settled
      // against the drive before anything is sent again.
      const uploads = attempt.filter((entry) =>
        options.uploads?.has(entry.path),
      );
      if (uploads.length > 0) {
        const landed = await applied(uploads);
        const settled = new Set<string>();
        for (const entry of uploads) {
          if (landed === null) {
            // Unanswerable, so not re-sent: duplicating the user's file is a
            // worse answer than saying the delivery could not be confirmed.
            settled.add(entry.path);
            delivery.skipped.push({
              path: entry.path,
              reason: `${entry.path} could not be confirmed as delivered to the drive, so it is still in the workspace.`,
            });
            continue;
          }
          if (!landed.has(entry.path)) continue;
          settled.add(entry.path);
          // Metadata-only rows have no bytes in the drive to offer.
          if (entry.contentBase64) delivery.stored.add(entry.path);
        }
        attempt = attempt.filter((entry) => !settled.has(entry.path));
      }
      if (attempt.length === 0) continue;
      response = await send(attempt, batchKey);
    }
    if (!response) {
      // This attempt's files only: the ones already accepted stay delivered.
      for (const entry of attempt) {
        delivery.skipped.push({
          path: entry.path,
          reason: `${entry.path} could not be delivered to the drive, so it is still in the workspace.`,
        });
      }
      continue;
    }
    const payload = (await response.json().catch(() => ({}))) as {
      files?: Array<{ path?: string; stored?: boolean }>;
      skipped?: Array<{ path?: string; reason?: string }>;
      renamed?: Array<{ from?: string; to?: string; reason?: string }>;
      replaced?: Array<{ path?: string; reason?: string }>;
    };
    for (const file of payload.files ?? []) {
      if (file.stored && file.path) delivery.stored.add(file.path);
    }
    for (const entry of payload.skipped ?? []) {
      if (entry.path) {
        delivery.skipped.push({
          path: entry.path,
          reason: entry.reason ?? "it was not delivered",
        });
      }
    }
    for (const entry of payload.renamed ?? []) {
      if (entry.from && entry.to) {
        delivery.renamed.push({
          from: entry.from,
          to: entry.to,
          reason: entry.reason ?? `saved as ${entry.to}`,
        });
      }
    }
    for (const entry of payload.replaced ?? []) {
      if (entry.path && entry.reason) {
        delivery.replaced.push({ path: entry.path, reason: entry.reason });
      }
    }
  }
  return delivery;
};
