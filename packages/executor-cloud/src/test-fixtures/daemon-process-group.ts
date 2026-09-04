import { writeFile } from "node:fs/promises";
import type { AttachedToolPaths } from "../attached-tool-protocol.js";
import { writeAttachedToolDaemonIdentity } from "../attached-tool-host.js";

const directory = process.argv[2];
if (!directory)
  throw new Error("daemon process-group fixture requires a directory");
const paths = {
  directory,
  socket: `${directory}/tool-host.sock`,
  hostInput: `${directory}/host-input.json`,
  request: `${directory}/request.json`,
  result: `${directory}/result.json`,
  daemonStderr: `${directory}/daemon.stderr`,
  daemonPid: `${directory}/daemon.pid`,
} satisfies AttachedToolPaths;
await writeAttachedToolDaemonIdentity(paths);
const child = Bun.spawn(["sleep", "30"]);
await writeFile(`${directory}/child.pid`, `${child.pid}\n`, { mode: 0o600 });
await child.exited;
