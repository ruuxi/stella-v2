/**
 * Delivery of a resident turn's reply-linked files straight from the world.
 *
 * A turn that never attached a sandbox has no quiesce step, so the files it
 * wrote through the Durable Object's own Write/Edit tools would stay in the
 * world and never reach the owner's drive or the conversation's files card.
 * The bytes are already durable here, so this delivers them the same way the
 * sandbox does: register (and inline-upload) each reply-linked drive file
 * through `/api/cloud/drive/files` under the turn's own authority, then
 * announce the delivered set with an `output_files` event, which the outbox
 * turns into the files card both clients render on the completion.
 *
 * The file list is the reply's own — markdown links in the final assistant
 * text, the same contract as everywhere else — and every linked path is an
 * agent-chosen string: only regular files under the drive root are read, by
 * their world-relative path, never by following anything.
 */
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import {
  forwardTurnBrokerRequest,
  type TurnBrokerTarget,
} from "../turn-credential-broker.js";
import { worldRelativeToolPath } from "../world/path.js";
import { driveRootForWorld, worldName, worldRootForFork } from "../workspace.js";
import type { TurnRequest } from "./shared/types.js";
import type { BuildSessionInternals } from "./host.js";

/** Files at or above this size are registered but not uploaded inline. */
const INLINE_LIMIT_BYTES = 8 * 1024 * 1024;
/** A reply that "produced" more than this is reporting churn, not deliverables. */
const MAX_REPORTED_FILES = 25;
const MAX_CALLBACK_BODY_BYTES = 16 * 1024 * 1024;
/** The tool host's private state directory is never a deliverable. */
const STATE_DIR_SEGMENT = ".stella";

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const contentTypeForName = (name: string): string => {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (name.includes(".") && CONTENT_TYPES[extension]) || "application/octet-stream";
};

export type WorldLinkedTarget = {
  /** World-relative path (`drive/reports/a.md`). */
  worldPath: string;
  /** Drive-relative path (`reports/a.md`), what the drive and cards use. */
  drivePath: string;
  name: string;
};

/**
 * The drive files a reply links, as world-relative and drive-relative paths.
 * Links outside the drive, into the tool state directory, or that do not
 * resolve inside the world are ignored; duplicates collapse to one.
 */
export const worldLinkedDriveTargets = (
  finalText: string,
  worldRoot: string,
): WorldLinkedTarget[] => {
  const driveRoot = driveRootForWorld(worldRoot);
  const targets: WorldLinkedTarget[] = [];
  const seen = new Set<string>();
  for (const linked of extractLocalFileLinkPaths(finalText)) {
    let worldPath: string;
    try {
      worldPath = worldRelativeToolPath(linked, worldRoot);
    } catch {
      continue;
    }
    const drivePrefix = `${worldRelativeToolPath(driveRoot, worldRoot)}/`;
    if (!worldPath.startsWith(drivePrefix)) continue;
    const drivePath = worldPath.slice(drivePrefix.length);
    if (!drivePath || drivePath.split("/").includes(STATE_DIR_SEGMENT)) continue;
    if (seen.has(drivePath)) continue;
    seen.add(drivePath);
    targets.push({
      worldPath,
      drivePath,
      name: drivePath.slice(drivePath.lastIndexOf("/") + 1),
    });
    if (targets.length >= MAX_REPORTED_FILES) break;
  }
  return targets;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

export type DeliveredWorldFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  stored: boolean;
};

type WorldFileReader = {
  stat(
    path: string,
    options?: { fork?: string },
  ): Promise<{ kind: string; size: number } | null>;
  readFile(
    path: string,
    options?: { fork?: string },
  ): Promise<Uint8Array | null>;
};

export type WorldLinkedFilesHost = Pick<
  BuildSessionInternals,
  "env" | "emitTurnEvent" | "controlPlaneCapability"
>;

/**
 * Deliver the reply-linked drive files of a turn that never attached a
 * sandbox. Best-effort: a failure costs visibility, not the turn, and is
 * logged rather than thrown. Returns the drive paths that were delivered.
 */
export const deliverWorldLinkedFiles = async (
  host: WorldLinkedFilesHost,
  args: {
    turn: TurnRequest;
    finalText: string;
    signal: AbortSignal;
    /** Test seam: the world to read from and the fetch to forward with. */
    world?: WorldFileReader;
    fetchImpl?: typeof fetch;
    log?: (event: string, fields: Record<string, unknown>) => void;
  },
): Promise<string[]> => {
  const { turn } = args;
  const log = args.log ?? (() => undefined);
  const targets = worldLinkedDriveTargets(
    args.finalText,
    worldRootForFork(turn.workspaceForkId),
  );
  if (targets.length === 0) return [];
  const convexOrigin = host.env.STELLA_CONVEX_SITE_URL?.trim();
  if (!convexOrigin) return [];
  const world: WorldFileReader =
    args.world ?? host.env.WORLDS.getByName(await worldName(turn.ownerId));
  const fork = turn.workspaceForkId ? { fork: turn.workspaceForkId } : {};

  const files: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    contentType: string;
    contentBase64?: string;
  }> = [];
  for (const target of targets) {
    const entry = await world.stat(target.worldPath, fork).catch(() => null);
    if (!entry || entry.kind !== "file") continue;
    const file = {
      path: target.drivePath,
      name: target.name,
      sizeBytes: entry.size,
      contentType: contentTypeForName(target.name),
    };
    if (entry.size < INLINE_LIMIT_BYTES) {
      const bytes = await world.readFile(target.worldPath, fork).catch(() => null);
      if (bytes && bytes.byteLength === entry.size) {
        files.push({ ...file, contentBase64: toBase64(bytes) });
        continue;
      }
    }
    files.push(file);
  }
  if (files.length === 0) return [];

  const target: TurnBrokerTarget = {
    kind: "callback",
    method: "POST",
    path: "/api/cloud/drive/files",
    maxBodyBytes: MAX_CALLBACK_BODY_BYTES,
  };
  let response: Response;
  try {
    response = await forwardTurnBrokerRequest({
      target,
      body: new TextEncoder().encode(
        JSON.stringify({
          turnId: turn.turnId,
          // The batch is the turn's, and a redelivery is the same writer.
          batchKey: `${turn.turnId}:world:0`,
          files,
        }),
      ),
      incomingHeaders: new Headers({ "content-type": "application/json" }),
      convexOrigin,
      controlPlaneCapability: await host.controlPlaneCapability(turn),
      signal: args.signal,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  } catch (error) {
    log("world_linked_files_failed", {
      turnId: turn.turnId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  // 413 is "nothing in this batch landed" with per-file reasons; anything
  // else that is not ok delivered nothing.
  if (!response.ok && response.status !== 413) {
    log("world_linked_files_refused", {
      turnId: turn.turnId,
      status: response.status,
    });
    return [];
  }
  const outcome = (await response.json().catch(() => null)) as {
    skipped?: Array<{ path?: string }>;
    renamed?: Array<{ from?: string; to?: string }>;
  } | null;
  const refused = new Set(
    (outcome?.skipped ?? [])
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === "string"),
  );
  const renamedBy = new Map(
    (outcome?.renamed ?? [])
      .filter(
        (entry): entry is { from: string; to: string } =>
          typeof entry.from === "string" && typeof entry.to === "string",
      )
      .map((entry) => [entry.from, entry.to]),
  );
  const delivered: DeliveredWorldFile[] = files
    .filter((file) => !refused.has(file.path) && response.status !== 413)
    .map((file) => {
      const to = renamedBy.get(file.path);
      const path = to ?? file.path;
      return {
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        stored: file.contentBase64 !== undefined,
      };
    });
  if (delivered.length === 0) return [];
  await host.emitTurnEvent(
    turn,
    "output_files",
    { files: delivered },
    { signal: args.signal },
  );
  return delivered.map((file) => file.path);
};
