/**
 * The files card of a resident turn: the drive files its reply links.
 *
 * A turn that never attached a sandbox wrote the drive through its own file
 * tools (`world-drive-files.ts`), which put every write in the user's drive
 * the moment it returned. So there is nothing left to upload here — only to
 * announce, with an `output_files` event, which of those files the reply
 * hands the user; the owner turns that into the files card both clients
 * render on the completion.
 *
 * The file list is the reply's own — markdown links in the final assistant
 * text, the same contract as everywhere else — and every linked path is an
 * agent-chosen string: only drive files the drive actually holds are named,
 * by their drive-relative path.
 */
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { worldRelativeToolPath } from "../world/path.js";
import { contentTypeForName } from "../world-drive-files.js";
import { driveRootForWorld, WORLD_ROOT } from "../workspace.js";
import type { TurnRequest } from "./shared/types.js";
import type { BuildSessionInternals } from "./host.js";

export { contentTypeForName };

/** A reply that "produced" more than this is reporting churn, not deliverables. */
const MAX_REPORTED_FILES = 25;
/** The tool host's private state directory is never a deliverable. */
const STATE_DIR_SEGMENT = ".stella";

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
    if (!drivePath || drivePath.split("/").includes(STATE_DIR_SEGMENT))
      continue;
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

export type DeliveredWorldFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  stored: boolean;
};

/** The drive, as world-relative `drive/...` paths (`createDriveFileSession`). */
type DriveFileReader = {
  stat(path: string): Promise<{ kind: string; size: number } | null>;
};

export type WorldLinkedFilesHost = Pick<BuildSessionInternals, "emitTurnEvent">;

/**
 * Announce the reply-linked drive files of a turn that never attached a
 * sandbox. Best-effort: a failure costs visibility, not the turn, and is
 * logged rather than thrown. Returns the drive paths that were announced.
 */
export const deliverWorldLinkedFiles = async (
  host: WorldLinkedFilesHost,
  args: {
    turn: TurnRequest;
    finalText: string;
    signal: AbortSignal;
    /** The drive this turn's file tools read and wrote. */
    drive?: DriveFileReader;
    log?: (event: string, fields: Record<string, unknown>) => void;
  },
): Promise<string[]> => {
  const { turn } = args;
  const log = args.log ?? (() => undefined);
  const targets = worldLinkedDriveTargets(args.finalText, WORLD_ROOT);
  if (targets.length === 0 || !args.drive) return [];
  const delivered: DeliveredWorldFile[] = [];
  for (const target of targets) {
    args.signal.throwIfAborted();
    const entry = await args.drive.stat(target.worldPath).catch((error) => {
      log("world_linked_file_unreadable", {
        turnId: turn.turnId,
        path: target.drivePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!entry || entry.kind !== "file") continue;
    delivered.push({
      path: target.drivePath,
      name: target.name,
      sizeBytes: entry.size,
      contentType: contentTypeForName(target.name),
      stored: true,
    });
  }
  if (delivered.length === 0) return [];
  await host.emitTurnEvent(
    turn,
    "output_files",
    { files: delivered },
    { signal: args.signal },
  );
  return delivered.map((file) => file.path);
};
