import { execFileSync } from "node:child_process";

export const stopOwnedCrashReporterHandler = (crashDumpsPath: string): void => {
  if (process.platform !== "darwin") return;

  let rows = "";
  try {
    rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }

  for (const row of rows.split("\n")) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3] ?? "";
    if (
      !command.includes("chrome_crashpad_handler") ||
      !command.includes(`--database=${crashDumpsPath}`)
    ) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {

    }
  }
};
