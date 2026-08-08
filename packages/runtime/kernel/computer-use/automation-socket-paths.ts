import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Where desktop-automation daemon Unix sockets live on disk.
 *
 * macOS caps `sockaddr_un` paths at 104 bytes including the trailing NUL
 * (the daemon's makeListeningSocket rejects anything longer), so the socket
 * cannot live under the Stella state dir: the desktop app points
 * STELLA_DATA_DIR at Electron userData (`~/Library/Application
 * Support/Stella Development`), which pushed the old
 * `<stateDir>/stella-computer/daemon-sockets/<hash>.sock` layout past the
 * cap. Mirroring `runtime/worker/runtime-paths.ts`, sockets are anchored at
 * a short home-relative directory instead.
 *
 * Because that directory is shared by every Stella install on the machine
 * (dev tree + packaged app), the socket filename hashes BOTH the install's
 * state dir and the session id so two installs using the same session id
 * never collide on one socket.
 */
export const automationSocketsRootDir = (homeDir: string = os.homedir()) =>
  path.join(homeDir, ".stella", "computer-sockets");

export const automationSocketFileName = (stateDir: string, sessionId: string) =>
  `${createHash("sha1")
    .update(`${path.resolve(stateDir)}\n${sessionId}`)
    .digest("hex")
    .slice(0, 16)}.sock`;

export const resolveAutomationSocketPath = (
  stateDir: string,
  sessionId: string,
  options?: { homeDir?: string },
) =>
  path.join(
    automationSocketsRootDir(options?.homeDir),
    automationSocketFileName(stateDir, sessionId),
  );

/**
 * Defensive ceiling kept below the 104-byte BSD `sun_path` limit (UTF-8
 * bytes + NUL, so 103 usable). Exceeding it means the home directory itself
 * is extraordinarily long; callers should fail with a readable error naming
 * the path instead of letting the daemon die with its opaque
 * "Daemon socket path is too long".
 */
export const maxAutomationSocketPathBytes = 100;
