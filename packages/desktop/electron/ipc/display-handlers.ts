import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  IPC_DISPLAY_LIST_CANVAS_HTML,
  IPC_DISPLAY_OPEN_SHARED_CANVAS,
  IPC_DISPLAY_READ_FILE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
} from "@stella/contracts/desktop/ipc-channels";
import {
  readConfiguredCanvasShareBaseUrl,
  resolveSharedCanvasPayload,
} from "../services/canvas-share-service.js";
import {
  listDeferredDeletes,
  purgeAllDeferredDeletes,
  purgeDeferredDelete,
} from "@stella/runtime/kernel/tools/deferred-delete";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { isCloudWorkspacePath } from "@stella/contracts/cloud-world-paths";
import type { LocalChatEventRecord } from "@stella/runtime/kernel/storage/shared";
import { planDisplayFileRead } from "./display-read-limit.js";
import { resolveJwtOwnerScope } from "@stella/runtime/kernel/runner/computer-agent-cloud-records";
import { resolveCanonicalConversationFilePaths } from "../services/canonical-conversation-file-paths.js";
import type { CloudConversationFileGrants } from "../services/cloud-conversation-file-grants.js";
import type { DeviceFileLocator } from "../services/device-file-locator.js";
import { deviceFileElsewhereMessage } from "@stella/contracts/device-files";

type DisplayHandlersOptions = {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  localChatHistoryService?: LocalChatHistoryService;
  getAuthToken?: () => Promise<string | null>;
  /** Files Stella produced or displayed in a conversation, per its cloud journal. */
  cloudFileGrants?: CloudConversationFileGrants;
  deviceFileLocator?: DeviceFileLocator;
  getDeviceId?: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".c": "text/plain",
  ".cc": "text/plain",
  ".cpp": "text/plain",
  ".cs": "text/plain",
  ".css": "text/css",
  ".go": "text/plain",
  ".h": "text/plain",
  ".hpp": "text/plain",
  ".html": "text/html",
  ".java": "text/plain",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".kt": "text/plain",
  ".mjs": "text/javascript",
  ".php": "text/plain",
  ".py": "text/x-python",
  ".rb": "text/plain",
  ".rs": "text/plain",
  ".scss": "text/x-scss",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svelte": "text/plain",
  ".swift": "text/plain",
  ".toml": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".vue": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  // 3D / generic
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain",
  ".stl": "application/sla",
  ".bin": "application/octet-stream",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

/** Head of a canvas document; the `<title>` is written near the top of it. */
const CANVAS_TITLE_SCAN_BYTES = 8192;
const CANVAS_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * The title the canvas itself declares, which is what the author named it —
 * the slug is a filename, and reads as one in a file list.
 */
const canvasDocumentTitle = async (
  filePath: string,
): Promise<string | null> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(CANVAS_TITLE_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const title = CANVAS_TITLE_RE.exec(buffer.subarray(0, bytesRead).toString("utf8"))?.[1];
    if (!title) return null;
    const decoded = title
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};


export const isDisplayReadPathInLocalChatFiles = (
  events: ReadonlyArray<LocalChatEventRecord>,
  requestedPath: string,
): boolean => {
  const resolvedRequestedPath = path.resolve(requestedPath);
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;

    const responseText =
      event.type === "assistant_message" && typeof payload.text === "string"
        ? payload.text
        : event.type === "agent-completed" && typeof payload.result === "string"
          ? payload.result
          : "";
    for (const filePath of extractLocalFileLinkPaths(responseText)) {
      if (path.resolve(filePath) === resolvedRequestedPath) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Subdirectories of `~/.stella` the phone may read from directly.
 *
 * These hold artifacts Stella itself produced and already renders in the UI
 * (generated media, `outputs/<app>/…` result files). The mirrored desktop UI
 * on the phone is the *same* bundle, so its media viewers — and user apps that
 * read their own output directory — need them to load at all.
 *
 * Everything else under `~/.stella` stays off-limits: credential stores like
 * `llm_credentials.json` and `connectors/.credentials.json` live at the root
 * and in sibling directories, and `.json` is an allowed display extension.
 */
const MOBILE_READABLE_DATA_SUBDIRS = ["outputs", "media"] as const;

/**
 * Marks an error as "this was refused because the caller is the phone, not
 * because anything is broken". The phone shows the message as is, so a
 * refusal reads as a policy answer rather than a broken file.
 */
export const REMOTE_VIEW_DENIAL_PREFIX = "Not available in phone view: ";

/** True when `candidate` is `base` itself or sits underneath it. */
const isPathInside = (candidate: string, base: string): boolean =>
  candidate === base || candidate.startsWith(base + path.sep);

/**
 * Resolves the deepest existing ancestor of `target` and re-appends the part
 * that does not exist yet.
 *
 * A plain `realpath` is not enough on its own: it throws for a file that has
 * not been written yet, and the caller still needs those to reach the handler's
 * soft "missing" result rather than being refused. Resolving the ancestor also
 * normalizes symlinked parents (on macOS the temp and home trees sit behind
 * `/var` -> `/private/var`), which a lexical comparison would get wrong.
 */
const resolveThroughSymlinks = async (target: string): Promise<string> => {
  let current = target;
  const trailing: string[] = [];
  // Bounded by the path depth; `path.dirname` is a fixed point at the root.
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
};

/**
 * True when the phone may read `resolvedPath` without a conversation.
 *
 * Symlinks are resolved before the containment check so a link planted inside
 * `outputs/` (e.g. by a prompt-injected agent) can't be used to read a
 * credential file that the extension allowlist would otherwise permit.
 */
export const isMobileReadableStellaPath = async (
  resolvedPath: string,
  stellaDataDir: string | null,
): Promise<boolean> => {
  if (!stellaDataDir) return false;
  const realPath = await resolveThroughSymlinks(resolvedPath);
  const realDataDir = await resolveThroughSymlinks(path.resolve(stellaDataDir));
  return MOBILE_READABLE_DATA_SUBDIRS.some((subdir) =>
    isPathInside(realPath, path.join(realDataDir, subdir)),
  );
};

/**
 * A cloud-world path reaching a local read is a routing mistake, not a missing
 * file. `/workspace/...` is the cloud sandbox; this machine has no such tree,
 * so `path.resolve` keeps it absolute, `fs.stat` raises ENOENT, and the handler
 * below reports `missing` — which every viewer renders as the file being gone.
 * That is false twice over: the file exists, and it was only ever asked of the
 * wrong machine.
 *
 * Refusing here rather than at a single call site is deliberate: this handler
 * is the one door onto the local filesystem for the whole display lane, so one
 * condition covers the tapped `stella://file` link, the activity hub, the
 * completion pills' `MediaPreviewCard`, the inline image tile, the canvas/PDF/
 * spreadsheet viewers and the canvas share bar's direct read. It also backs
 * a paired phone's `file.read` relayed through the cloud, so a phone whose
 * client-side guard is older still gets a true answer instead of a false one.
 *
 * Drive files never get here: the renderer maps `world/drive/...` onto an
 * owner-scoped drive URL through `cloudWorldDrivePath` first, and only a world
 * path the drive rule rejects falls through to this lane.
 */
const assertNotCloudWorkspacePath = (filePath: string): void => {
  if (!isCloudWorkspacePath(filePath)) return;
  throw new Error(
    "This file lives in Stella's cloud workspace, not on this computer, so it can't be opened here. Ask Stella to put it in your Drive.",
  );
};

export const registerDisplayHandlers = (options: DisplayHandlersOptions) => {
  const requireStellaDataDir = () => {
    const stellaDataDir = options.getStellaDataDir();
    if (!stellaDataDir) {
      throw new Error("Stella home is unavailable.");
    }
    return stellaDataDir;
  };

  /**
   * `display:readFile` for the desktop renderer (`remote: false`) and for a
   * paired phone's `file.read` relayed through the cloud (`remote: true`),
   * which is held to Stella's own outputs and the conversation's files.
   */
  const readFromOwningDevice = async (
    requestedPath: string,
    maxBytes: unknown,
    mimeType: string,
  ) => {
    const locator = options.deviceFileLocator;
    if (!locator) return null;
    const location = await locator.locate(
      requestedPath,
      options.getDeviceId?.() ?? null,
    );
    if (!location) return null;
    if (location.drivePath) {
      const plan = planDisplayFileRead(location.sizeBytes, maxBytes);
      if (!plan.ok) {
        throw new Error(plan.error);
      }
      const copy = await locator.readCopy(location.drivePath, plan.readBytes);
      return {
        bytes: copy.bytes,
        sizeBytes: copy.sizeBytes,
        mimeType,
        truncated: copy.bytes.byteLength < copy.sizeBytes,
        missing: false as const,
      };
    }
    if (location.deviceId === options.getDeviceId?.()) return null;
    throw new Error(deviceFileElsewhereMessage(location.deviceName));
  };

  const readDisplayFile = async (
    payload:
      | {
          filePath?: unknown;
          conversationId?: unknown;
          maxBytes?: unknown;
        }
      | undefined,
    access: { remote: boolean },
  ) => {
    const requestedPath =
      typeof payload?.filePath === "string" ? payload.filePath.trim() : "";
    if (!requestedPath) {
      throw new Error("display:readFile requires a filePath.");
    }
    assertNotCloudWorkspacePath(requestedPath);

    const resolved = path.resolve(requestedPath);
    if (access.remote) {
      // Stella's own artifact directories are readable without a
      // conversation: apps rendered in the phone's mirrored UI (and the
      // shell's media viewers) read their result files directly, and have
      // no conversation to attribute the read to.
      const isStellaArtifact = await isMobileReadableStellaPath(
        resolved,
        options.getStellaDataDir(),
      );
      if (!isStellaArtifact) {
        const conversationId =
          typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId) {
          throw new Error(
            `${REMOTE_VIEW_DENIAL_PREFIX}this file is outside Stella's own outputs and media, and no conversation was supplied to check it against.`,
          );
        }
        const allowedByLocalHistory = options.localChatHistoryService
          ? isDisplayReadPathInLocalChatFiles(
              options.localChatHistoryService.listFiles({
                conversationId,
                limit: 500,
              }).files,
              resolved,
            )
          : false;
        const canonicalPaths =
          allowedByLocalHistory || !options.localChatHistoryService
            ? new Set<string>()
            : await resolveCanonicalConversationFilePaths(
                options.localChatHistoryService.listCanonicalFilePaths(
                  conversationId,
                  resolveJwtOwnerScope(
                    await options.getAuthToken?.().catch(() => null),
                  ),
                ),
              );
        // Any conversation of this owner, not just the one this window
        // shows: a file Stella produced or displayed there, per the cloud
        // journal, is one the user has already been shown.
        const cloudPaths =
          allowedByLocalHistory ||
          canonicalPaths.has(resolved) ||
          !options.cloudFileGrants
            ? new Set<string>()
            : await resolveCanonicalConversationFilePaths(
                await options.cloudFileGrants.listPaths(conversationId),
              );
        if (
          !allowedByLocalHistory &&
          !canonicalPaths.has(resolved) &&
          !cloudPaths.has(resolved)
        ) {
          throw new Error(
            `${REMOTE_VIEW_DENIAL_PREFIX}reading this file needs your computer. Only Stella's own outputs and files from the current conversation can load here.`,
          );
        }
      }
    }
    const extension = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(
        `display:readFile only supports: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
      );
    }
    const mimeType =
      MIME_BY_EXTENSION[extension] ?? "application/octet-stream";

    // Paths can outlive the file they point at — e.g. an `image_gen` /
    // tool-result registered a path in `generatedMediaItems`, and the
    // underlying file was later moved or deleted (especially for paths
    // outside `~/.stella/`). Treat ENOENT as a soft "missing" result so the
    // renderer can render a placeholder instead of surfacing the raw
    // IPC error to the console / UI.
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(resolved);
    } catch (caught) {
      if (
        caught &&
        typeof caught === "object" &&
        (caught as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        const elsewhere = await readFromOwningDevice(
          requestedPath,
          payload?.maxBytes,
          mimeType,
        );
        if (elsewhere) return elsewhere;
        return { missing: true as const, mimeType, path: resolved };
      }
      throw caught;
    }
    if (!stats.isFile()) {
      throw new Error(`display:readFile target is not a file: ${resolved}`);
    }
    const plan = planDisplayFileRead(stats.size, payload?.maxBytes);
    if (!plan.ok) {
      throw new Error(plan.error);
    }

    let buffer: Buffer;
    if (plan.readBytes === stats.size) {
      buffer = await fs.readFile(resolved);
    } else {
      const handle = await fs.open(resolved, "r");
      try {
        buffer = Buffer.alloc(plan.readBytes);
        const { bytesRead } = await handle.read(buffer, 0, plan.readBytes, 0);
        if (bytesRead < plan.readBytes) {
          buffer = buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    }
    // Return the raw bytes; Electron's structured-clone IPC transport
    // ships `Uint8Array` directly without the +33% base64 overhead and
    // without forcing the renderer to spin a JS loop to decode it.
    const bytes = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    return {
      bytes,
      sizeBytes: stats.size,
      mimeType,
      truncated: buffer.byteLength < stats.size,
      missing: false as const,
    };
  };

  ipcMain.handle(
    IPC_DISPLAY_READ_FILE,
    async (
      event,
      payload?: {
        filePath?: unknown;
        conversationId?: unknown;
        maxBytes?: unknown;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, IPC_DISPLAY_READ_FILE)) {
        throw new Error(`Blocked untrusted ${IPC_DISPLAY_READ_FILE} request.`);
      }
      return await readDisplayFile(payload, { remote: false });
    },
  );

  ipcMain.handle(IPC_DISPLAY_LIST_CANVAS_HTML, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_DISPLAY_LIST_CANVAS_HTML)) {
      throw new Error(
        `Blocked untrusted ${IPC_DISPLAY_LIST_CANVAS_HTML} request.`,
      );
    }

    const htmlDir = path.join(requireStellaDataDir(), "outputs", "html");
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(htmlDir, { withFileTypes: true });
    } catch (caught) {
      if (
        caught &&
        typeof caught === "object" &&
        (caught as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw caught;
    }

    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
        .map(async (entry) => {
          const filePath = path.join(htmlDir, entry.name);
          const stats = await fs.stat(filePath);
          const slug = entry.name.slice(0, -".html".length);
          return {
            filePath,
            slug,
            title:
              (await canvasDocumentTitle(filePath)) ??
              slug
                .replace(/[-_]+/g, " ")
                .replace(/\b\w/g, (char: string) => char.toUpperCase()),
            createdAt: stats.mtimeMs,
          };
        }),
    );

    return items.sort((a, b) => a.createdAt - b.createdAt);
  });

  ipcMain.handle(
    IPC_DISPLAY_OPEN_SHARED_CANVAS,
    async (event, payload?: { url?: unknown }) => {
      if (
        !options.assertPrivilegedSender(event, IPC_DISPLAY_OPEN_SHARED_CANVAS)
      ) {
        throw new Error(
          `Blocked untrusted ${IPC_DISPLAY_OPEN_SHARED_CANVAS} request.`,
        );
      }
      const url = typeof payload?.url === "string" ? payload.url.trim() : "";
      if (!url) return null;
      return await resolveSharedCanvasPayload({
        url,
        baseUrl: readConfiguredCanvasShareBaseUrl(),
        stellaDataDir: requireStellaDataDir(),
      });
    },
  );

  ipcMain.handle(IPC_DISPLAY_TRASH_LIST, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_DISPLAY_TRASH_LIST)) {
      throw new Error(`Blocked untrusted ${IPC_DISPLAY_TRASH_LIST} request.`);
    }
    return await listDeferredDeletes({ stellaDataDir: requireStellaDataDir() });
  });

  ipcMain.handle(
    IPC_DISPLAY_TRASH_FORCE_DELETE,
    async (event, payload?: { id?: unknown; all?: unknown }) => {
      if (
        !options.assertPrivilegedSender(event, IPC_DISPLAY_TRASH_FORCE_DELETE)
      ) {
        throw new Error(
          `Blocked untrusted ${IPC_DISPLAY_TRASH_FORCE_DELETE} request.`,
        );
      }

      const stellaDataDir = requireStellaDataDir();
      if (payload?.all === true) {
        return await purgeAllDeferredDeletes({ stellaDataDir });
      }
      const id = typeof payload?.id === "string" ? payload.id : "";
      return await purgeDeferredDelete(id, { stellaDataDir });
    },
  );

  return {
    /** A paired phone's `file.read`, under the remote read policy. */
    readFileForRequest: (payload: {
      filePath?: unknown;
      conversationId?: unknown;
    }) => readDisplayFile(payload, { remote: true }),
  };
};
