import { app, type BrowserWindow } from "electron";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { fstatSync } from "node:fs";
import net from "node:net";
import { restoreDevHarnessStorageKeyForRelaunch } from "./bootstrap/dev-harness-protected-storage.js";
import { git, gitRaw } from "./services/app-source/git.js";

/**
 * Electron's side of the native launcher (launcher/{macos,windows,linux}).
 *
 * The launcher passes `STELLA_LAUNCHER=1` and an inherited channel: fd 3 (a
 * socketpair end) on macOS and Linux, the named pipe in `STELLA_LAUNCHER_PIPE`
 * on Windows. Messages are newline-delimited JSON:
 *
 * - to the launcher: `{"op":"ready"}` when the main window is ready to show,
 *   `{"op":"sign","id":n,"commit":sha}` after the checkout's HEAD changed,
 *   `{"op":"failed","reason":"..."}` when Stella can't keep running;
 * - from the launcher: `{"op":"sign-result","id":n,"ok":true,"commit":sha}`
 *   or `{"op":"sign-result","id":n,"ok":false,"error":"..."}`, and
 *   `{"op":"quit"}` (self-test).
 *
 * Exit code 75 asks the launcher to relaunch (after preparing and verifying
 * the tree again); 0 means the user quit. Without a launcher (`electron:dev`)
 * every function here is a no-op and relaunching uses `app.relaunch()`.
 */

export const LAUNCHER_RELAUNCH_EXIT_CODE = 75;
const SIGNED_NOTES_REF = "stella-signed";
const SIGN_TIMEOUT_MS = 30_000;

type PendingSign = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let present: boolean | null = null;
let channel: net.Socket | null = null;
let buffered = "";
let readySent = false;
let relaunchRequested = false;
let nextSignId = 1;
const pendingSigns = new Map<number, PendingSign>();

const detectLauncher = (): boolean => {
  if (process.env.STELLA_LAUNCHER !== "1") return false;
  if (process.platform === "win32") {
    return Boolean(process.env.STELLA_LAUNCHER_PIPE?.trim());
  }
  try {
    return fstatSync(3).isSocket();
  } catch {
    return false;
  }
};

export const isLauncherPresent = (): boolean => (present ??= detectLauncher());

const send = (message: Record<string, unknown>): boolean => {
  if (!channel || channel.destroyed) return false;
  channel.write(`${JSON.stringify(message)}\n`);
  return true;
};

const handleMessage = (message: Record<string, unknown>) => {
  if (message.op === "sign-result") {
    const pending = pendingSigns.get(Number(message.id));
    if (!pending) return;
    pendingSigns.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve();
    else pending.reject(new Error(String(message.error ?? "The launcher refused to sign.")));
    return;
  }
  if (message.op === "quit") {
    app.quit();
  }
};

const rejectAllPending = (reason: string) => {
  for (const [id, pending] of pendingSigns) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingSigns.delete(id);
  }
};

/** Open the channel and send `ready` once the main window can be shown. */
export const connectLauncher = () => {
  if (channel || !isLauncherPresent()) return;
  const socket =
    process.platform === "win32"
      ? net.connect(process.env.STELLA_LAUNCHER_PIPE!.trim())
      : new net.Socket({ fd: 3, readable: true, writable: true });
  channel = socket;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        console.warn("[launcher] ignored a malformed message");
      }
    }
  });
  socket.on("error", (error) => {
    console.warn(`[launcher] channel error: ${error.message}`);
  });
  socket.on("close", () => {
    channel = null;
    rejectAllPending("The launcher channel closed.");
  });
  // The channel must never keep Electron alive on its own.
  socket.unref();

  app.on("browser-window-created", (_event, window: BrowserWindow) => {
    if (readySent) return;
    window.once("ready-to-show", () => {
      // Hidden helper windows (overlay, a companion's hidden shell) don't count.
      if (readySent || window.isDestroyed() || !window.isVisible()) return;
      readySent = true;
      send({ op: "ready" });
    });
  });
};

/** Tell the launcher Stella can't keep running; it shows the recovery screen. */
export const reportFailed = (reason: string) => {
  send({ op: "failed", reason: reason.slice(0, 4_000) });
};

/**
 * Ask the launcher to sign the checkout's HEAD (after an apply, undo, remote
 * or upstream update). The launcher checks HEAD is still `commit` and the tree
 * is clean, then stores the note. No-op without a launcher.
 */
export const signHead = async (cwd: string): Promise<void> => {
  if (!isLauncherPresent()) return;
  const commit = await git(cwd, ["rev-parse", "HEAD"]);
  const id = nextSignId++;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSigns.delete(id);
      reject(new Error("The launcher did not answer the signing request."));
    }, SIGN_TIMEOUT_MS);
    timer.unref?.();
    pendingSigns.set(id, { resolve, reject, timer });
    if (!send({ op: "sign", id, commit })) {
      clearTimeout(timer);
      pendingSigns.delete(id);
      reject(new Error("The launcher channel is closed."));
    }
  });
};

/**
 * Refuse to act on a HEAD the launcher didn't sign: an agent that committed
 * directly in the checkout must not get its commit signed by riding on the
 * next apply. Verifies `refs/notes/stella-signed` against the launcher's
 * public key (`STELLA_LAUNCHER_PUBKEY`, base64 SPKI DER). No-op without a
 * launcher.
 */
export const assertHeadSigned = async (cwd: string): Promise<void> => {
  if (!isLauncherPresent()) return;
  const encodedKey = process.env.STELLA_LAUNCHER_PUBKEY?.trim();
  if (!encodedKey) {
    throw new Error("The launcher did not provide its signing key.");
  }
  const [tree, note] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD^{tree}"]),
    gitRaw(cwd, ["notes", "--ref", SIGNED_NOTES_REF, "show", "HEAD"]),
  ]);
  const unsigned = new Error(
    "This version of Stella was changed outside of Stella's updates, so Stella won't build on it.",
  );
  if (note.code !== 0) throw unsigned;
  const key = createPublicKey({
    key: Buffer.from(encodedKey, "base64"),
    format: "der",
    type: "spki",
  });
  const valid = verifySignature(
    "sha256",
    Buffer.from(`stella-tree-v1\n${tree}\n`),
    key,
    Buffer.from(note.stdout.trim(), "base64"),
  );
  if (!valid) throw unsigned;
};

/**
 * Relaunch Electron. Under a launcher, quit with exit code 75 so the launcher
 * prepares, verifies and respawns; otherwise `app.relaunch()`.
 */
export const relaunchApp = () => {
  if (isLauncherPresent()) {
    relaunchRequested = true;
    app.quit();
    return;
  }
  restoreDevHarnessStorageKeyForRelaunch();
  app.relaunch();
  app.quit();
};

/** The exit code for a clean quit: 75 when a relaunch was requested. */
export const launcherExitCode = () =>
  relaunchRequested && isLauncherPresent() ? LAUNCHER_RELAUNCH_EXIT_CODE : 0;
