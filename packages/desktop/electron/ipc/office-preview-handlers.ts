import { randomUUID } from "node:crypto";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { arch, platform } from "node:os";
import { spawn } from "node:child_process";
import { app, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
} from "@stella/contracts/desktop/ipc-channels";
import type {
  OfficePreviewFormat,
  OfficePreviewRef,
  OfficePreviewSnapshot,
} from "@stella/contracts/office-preview";
import { listOfficePreviewSnapshots } from "../bootstrap/office-preview-bridge.js";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { isDisplayReadPathInLocalChatFiles } from "./display-handlers.js";
import type { LocalChatEventRecord } from "@stella/runtime/kernel/storage/shared";
import { resolveJwtOwnerScope } from "@stella/runtime/kernel/runner/computer-agent-cloud-records";
import { resolveCanonicalConversationFilePaths } from "../services/canonical-conversation-file-paths.js";
import type { CloudConversationFileGrants } from "../services/cloud-conversation-file-grants.js";
import { handleIpc } from "./typed-ipc.js";
import {
  resolveDeviceFileSource,
  type DeviceFileSourceDeps,
} from "../services/device-file-source.js";
import {
  deviceFileUnavailableMessage,
  friendlyDeviceName,
} from "@stella/contracts/device-files";

type OfficePreviewHandlersOptions = {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  localChatHistoryService?: LocalChatHistoryService;
  getAuthToken?: () => Promise<string | null>;
  /** Files Stella produced or displayed in a conversation, per its cloud journal. */
  cloudFileGrants?: CloudConversationFileGrants;
  /** On pi-durable: the local files Stella linked in a conversation's transcript. */
  piLinkedFiles?: (conversationId: string) => Promise<readonly string[]>;
  /** Says which device has a file that is not on this computer. */
  deviceFiles?: DeviceFileSourceDeps;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type MobileOfficePreviewPolicy = {
  fileEvents: readonly LocalChatEventRecord[];
  artifactPaths: ReadonlySet<string>;
};

const PREVIEW_ROOT_DIRNAME = "office-previews";
/** How long a phone's preview request waits for the render to finish. */
const REMOTE_PREVIEW_TIMEOUT_MS = 40_000;
const REMOTE_PREVIEW_POLL_MS = 500;
const SESSION_MANIFEST_NAME = "session.json";
const SESSION_HTML_NAME = "preview.html";

/**
 * The OfficeCLI binary ships in the source tree every install runs from; there
 * is no packaged `resourcesPath` copy to prefer.
 */
export const resolveOfficePreviewBinaryPath = (
  stellaAppDir: string,
  binaryName: string,
): string =>
  path.join(stellaAppDir, "packages", "stella-office", "bin", binaryName);

const formatForPath = (filePath: string): OfficePreviewFormat => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx" || extension === ".xlsm") return "xlsx";
  if (extension === ".pptx") return "pptx";
  return null;
};

const getOfficeBinaryName = () => {
  const os = platform();
  const cpu = arch();
  const osKey =
    os === "darwin"
      ? "darwin"
      : os === "linux"
        ? "linux"
        : os === "win32"
          ? "win32"
          : null;
  const archKey = cpu === "x64" ? "x64" : cpu === "arm64" ? "arm64" : null;
  if (!osKey || !archKey) {
    throw new Error(`Unsupported platform for Office preview: ${os}-${cpu}`);
  }
  return `stella-office-${osKey}-${archKey}${os === "win32" ? ".exe" : ""}`;
};

const writeManifest = async (
  sessionDir: string,
  ref: OfficePreviewRef,
  format: OfficePreviewFormat,
  status: "starting" | "ready" | "error",
  startedAt: number,
  error?: string,
) => {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, SESSION_MANIFEST_NAME),
    `${JSON.stringify(
      {
        sessionId: ref.sessionId,
        title: ref.title,
        sourcePath: ref.sourcePath,
        format,
        startedAt,
        updatedAt: Date.now(),
        status,
        ...(error ? { error } : {}),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
};

const renderOfficeHtml = async (
  binaryPath: string,
  sourcePath: string,
): Promise<string> => {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(binaryPath, ["view", sourcePath, "html"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || "Office preview failed.",
    );
  }
  return result.stdout;
};

export const filterOfficePreviewSnapshotsForMobile = (
  snapshots: readonly OfficePreviewSnapshot[],
  policy: MobileOfficePreviewPolicy,
): OfficePreviewSnapshot[] =>
  snapshots.filter((snapshot) =>
    isMobileOfficePreviewPathAllowed(policy, snapshot.sourcePath),
  );

const officePreviewRefArtifactSchema = z.looseObject({
  kind: z.literal("office"),
  previewRef: z.looseObject({ sourcePath: z.string() }),
});

const officeFileArtifactSchema = z.looseObject({
  kind: z.literal("file-artifact"),
  filePath: z.string(),
  artifactKind: z.enum([
    "office-document",
    "office-spreadsheet",
    "office-slides",
  ]),
});

const officePreviewArtifactPath = (payload: unknown): string | null => {
  const previewRef = officePreviewRefArtifactSchema.safeParse(payload);
  if (previewRef.success) return previewRef.data.previewRef.sourcePath;
  const fileArtifact = officeFileArtifactSchema.safeParse(payload);
  if (fileArtifact.success) return fileArtifact.data.filePath;
  return null;
};

const collectOfficePreviewArtifactPaths = (
  messages: ReturnType<LocalChatHistoryService["listSyncMessages"]>,
): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      const sourcePath = officePreviewArtifactPath(artifact);
      if (sourcePath) paths.add(path.resolve(sourcePath));
    }
  }
  return paths;
};

const isMobileOfficePreviewPathAllowed = (
  policy: MobileOfficePreviewPolicy,
  sourcePath: string,
): boolean =>
  isDisplayReadPathInLocalChatFiles(policy.fileEvents, sourcePath) ||
  policy.artifactPaths.has(path.resolve(sourcePath));

export const registerOfficePreviewHandlers = (
  options: OfficePreviewHandlersOptions,
) => {
  /**
   * The remote (paired phone) policy: previews are limited to files Stella
   * displayed or produced in the named conversation.
   */
  const requireRemoteConversationFileEvents = async (
    payload: { conversationId?: unknown } | undefined,
    channel: string,
  ): Promise<MobileOfficePreviewPolicy> => {
    const conversationId =
      typeof payload?.conversationId === "string"
        ? payload.conversationId.trim()
        : "";
    if (!conversationId) {
      throw new Error(`${channel} from mobile requires a conversationId.`);
    }
    const history = options.localChatHistoryService;
    const fileEvents = history
      ? history.listFiles({ conversationId, limit: 500 }).files
      : [];
    const artifactPaths = new Set(
      history
        ? collectOfficePreviewArtifactPaths(
            history.listSyncMessages({ conversationId, maxMessages: 500 }),
          )
        : [],
    );
    if (history) {
      for (const filePath of await resolveCanonicalConversationFilePaths(
        history.listCanonicalFilePaths(
          conversationId,
          resolveJwtOwnerScope(
            await options.getAuthToken?.().catch(() => null),
          ),
        ),
      ))
        artifactPaths.add(filePath);
    }
    // The conversation's cloud journal is the source of truth for what Stella
    // produced or displayed there, whichever conversation this window shows.
    if (options.cloudFileGrants) {
      for (const filePath of await resolveCanonicalConversationFilePaths(
        await options.cloudFileGrants.listPaths(conversationId),
      ))
        artifactPaths.add(filePath);
    }
    if (options.piLinkedFiles) {
      for (const filePath of await resolveCanonicalConversationFilePaths(
        await options.piLinkedFiles(conversationId).catch(() => []),
      ))
        artifactPaths.add(filePath);
    }
    return { fileEvents, artifactPaths };
  };

  const listPreviews = async (
    policy: MobileOfficePreviewPolicy | null,
  ): Promise<OfficePreviewSnapshot[]> => {
    const stellaDataDir = options.getStellaDataDir();
    if (!stellaDataDir?.trim()) {
      return [];
    }
    const snapshots = await listOfficePreviewSnapshots(stellaDataDir);
    return policy
      ? filterOfficePreviewSnapshotsForMobile(snapshots, policy)
      : snapshots;
  };

  const startPreview = async (
    payload: { filePath?: unknown } | undefined,
    policy: MobileOfficePreviewPolicy | null,
  ): Promise<OfficePreviewRef> => {
    const stellaAppDir = options.getStellaAppDir();
    const stellaDataDir = options.getStellaDataDir();
    if (!stellaAppDir?.trim() || !stellaDataDir?.trim()) {
      throw new Error("Office preview requires an initialized Stella root.");
    }
    const requestedPath =
      typeof payload?.filePath === "string" ? payload.filePath.trim() : "";
    if (!requestedPath) {
      throw new Error("officePreview:start requires a filePath.");
    }

    const sourcePath = path.resolve(requestedPath);
    if (policy && !isMobileOfficePreviewPathAllowed(policy, sourcePath)) {
      throw new Error(
        "officePreview:start from mobile is limited to recent files Stella displayed for the active conversation.",
      );
    }

    const stats = await fs.stat(sourcePath).catch(async (caught: unknown) => {
      if ((caught as NodeJS.ErrnoException | null)?.code !== "ENOENT")
        throw caught;
      const source = await resolveDeviceFileSource(
        requestedPath,
        options.deviceFiles ?? null,
      );
      throw new Error(
        source.kind === "drive"
          ? `This file is on ${friendlyDeviceName(source.deviceName)}. Office previews of files from your other devices aren't available yet, so open it there.`
          : deviceFileUnavailableMessage(source, requestedPath),
      );
    });
    if (!stats.isFile()) {
      throw new Error(`Office preview target is not a file: ${sourcePath}`);
    }

    const format = formatForPath(sourcePath);
    if (!format) {
      throw new Error(
        "Office preview supports .docx, .xlsx, .xlsm, and .pptx files.",
      );
    }

    const sessionId = randomUUID();
    const title = path.basename(sourcePath);
    const ref: OfficePreviewRef = { sessionId, title, sourcePath };
    const sessionDir = path.join(
      stellaDataDir,
      PREVIEW_ROOT_DIRNAME,
      sessionId,
    );
    const startedAt = Date.now();
    await writeManifest(sessionDir, ref, format, "starting", startedAt);

    const binaryPath = resolveOfficePreviewBinaryPath(
      stellaAppDir,
      getOfficeBinaryName(),
    );
    void (async () => {
      try {
        const html = await renderOfficeHtml(binaryPath, sourcePath);
        await fs.writeFile(
          path.join(sessionDir, SESSION_HTML_NAME),
          html,
          "utf-8",
        );
        await writeManifest(sessionDir, ref, format, "ready", startedAt);
      } catch (caught) {
        await writeManifest(
          sessionDir,
          ref,
          format,
          "error",
          startedAt,
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    })();

    return ref;
  };

  handleIpc(IPC_OFFICE_PREVIEW_LIST, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_OFFICE_PREVIEW_LIST)) {
      throw new Error("Blocked untrusted office preview request.");
    }
    return await listPreviews(null);
  });

  handleIpc(
    IPC_OFFICE_PREVIEW_START,
    async (
      event,
      payload?: { filePath?: unknown },
    ): Promise<OfficePreviewRef> => {
      if (!options.assertPrivilegedSender(event, IPC_OFFICE_PREVIEW_START)) {
        throw new Error("Blocked untrusted office preview request.");
      }
      return await startPreview(payload, null);
    },
  );

  return {
    /**
     * A paired phone's `officePreview.render`, relayed through the cloud:
     * start a preview of `filePath` (or follow an existing `sessionId`) under
     * the remote policy and resolve with its HTML once it is ready.
     */
    renderForRequest: async (payload: {
      filePath?: unknown;
      sessionId?: unknown;
      conversationId?: unknown;
    }): Promise<string> => {
      const policy = await requireRemoteConversationFileEvents(
        payload,
        IPC_OFFICE_PREVIEW_START,
      );
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : (await startPreview(payload, policy)).sessionId;
      const deadline = Date.now() + REMOTE_PREVIEW_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const snapshot = (await listPreviews(policy)).find(
          (entry) => entry.sessionId === sessionId,
        );
        if (snapshot?.status === "ready" && snapshot.html) return snapshot.html;
        if (snapshot?.status === "error") {
          throw new Error(snapshot.error || "Office preview failed.");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, REMOTE_PREVIEW_POLL_MS),
        );
      }
      throw new Error("Office preview timed out.");
    },
  };
};
