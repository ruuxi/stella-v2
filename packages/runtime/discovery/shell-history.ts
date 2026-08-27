import { promises as fs } from "fs";
import path from "path";
import os from "os";

import type { ShellAnalysis, CommandFrequency } from "./types.js";

const log = (...args: unknown[]) => console.error("[shell-history]", ...args);

const getHistoryPaths = (): string[] => {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [

      path.join(appData, "Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),

      path.join(home, ".bash_history"),
    ];
  }

  return [
    path.join(home, ".zsh_history"),
    path.join(home, ".bash_history"),
  ];
};

const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /--password/i,
  /-p\S/i,
  /-p\s+\S+/i,
  /export\s+\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|URL)/i,
  /curl.*-H.*Authorization/i,
  /curl.*-u\s/i,

  /\w+:\/\/[^/\s]*:[^/\s]*@/i,

  /private[_-]?key/i,
  /encryption[_-]?key/i,

  /cat\s+.*\.env\b/i,
  /source\s+.*\.env\b/i,

  /sshpass/i,
  /htpasswd/i,
];

const isSensitiveCommand = (line: string): boolean => {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(line));
};

const DEV_TOOLS = new Set([

  "git",

  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "node",
  "deno",

  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "conda",

  "cargo",
  "rustc",
  "rustup",

  "go",

  "docker",
  "docker-compose",
  "kubectl",
  "terraform",
  "pulumi",
  "aws",
  "gcloud",
  "az",

  "code",
  "cursor",
  "vim",
  "nvim",
  "nano",
  "zed",
  "windsurf",

  "make",
  "cmake",
  "gradle",
  "mvn",

  "dotnet",

  "ruby",
  "gem",
  "bundle",

  "php",
  "composer",

  "java",
  "javac",
  "scala",
  "sbt",

  "swift",
  "xcodebuild",
  "flutter",
  "dart",

  "zig",

  "claude",
  "codex",
  "gemini",
  "aider",
  "copilot",
  "cody",
  "continue",
  "opencode",
  "amp",
]);

const parseZshLine = (line: string): string | null => {
  if (line.startsWith(": ")) {

    const semicolonIdx = line.indexOf(";");
    if (semicolonIdx !== -1) {
      return line.slice(semicolonIdx + 1).trim();
    }
  }
  return line.trim();
};

const extractBaseCommand = (line: string): string | null => {

  if (!line || line.startsWith("#")) return null;

  let cmd = line.trim();

  cmd = cmd.replace(/^(sudo|time|nohup|nice|env\s+\S+=\S+\s*)+/i, "").trim();

  const match = cmd.match(/^([a-zA-Z0-9_.-]+)/);
  return match ? match[1].toLowerCase() : null;
};

const isValidPath = (p: string): boolean => {

  if (/%[0-9A-Fa-f]{2}/.test(p)) return false;

  if (/^\/[a-zA-Z]:/.test(p)) return false;

  if (/[\x00-\x1F]/.test(p)) return false;

  return true;
};

const extractCdPath = (line: string): string | null => {
  const cdMatch = line.match(/^\s*cd\s+(.+)$/);
  if (!cdMatch) return null;

  let cdPath = cdMatch[1].trim();

  const chainMatch = cdPath.match(/^(?:"([^"]+)"|'([^']+)'|([^\s&|;><]+))/);
  if (chainMatch) {
    cdPath = chainMatch[1] || chainMatch[2] || chainMatch[3] || "";
  }

  cdPath = cdPath.trim();

  cdPath = cdPath.replace(/^["']|["']$/g, "");

  if (cdPath === "-" || cdPath === ".." || cdPath === "." || cdPath === "") return null;

  if (!isValidPath(cdPath)) return null;

  if (cdPath.startsWith("~")) {
    cdPath = cdPath.replace(/^~/, os.homedir());
  }

  if (cdPath.length < 3) return null;

  if (cdPath.length < 5 && !path.isAbsolute(cdPath)) return null;

  return cdPath;
};

export const analyzeShellHistory = async (): Promise<ShellAnalysis> => {
  log("Starting shell history analysis...");

  const historyPaths = getHistoryPaths();
  const commandCounts = new Map<string, number>();
  const projectPathCounts = new Map<string, number>();
  const toolsFound = new Set<string>();

  for (const historyPath of historyPaths) {
    try {
      const content = await fs.readFile(historyPath, "utf-8");
      const lines = content.split("\n");

      log(`Parsing ${historyPath}: ${lines.length} lines`);

      for (const rawLine of lines) {

        const line = parseZshLine(rawLine);
        if (!line) continue;

        if (isSensitiveCommand(line)) continue;

        const baseCmd = extractBaseCommand(line);
        if (baseCmd) {
          commandCounts.set(baseCmd, (commandCounts.get(baseCmd) || 0) + 1);

          if (DEV_TOOLS.has(baseCmd)) {
            toolsFound.add(baseCmd);
          }
        }

        const cdPath = extractCdPath(line);
        if (cdPath) {
          projectPathCounts.set(cdPath, (projectPathCounts.get(cdPath) || 0) + 1);
        }
      }
    } catch {

      continue;
    }
  }

  const topCommands: CommandFrequency[] = Array.from(commandCounts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const projectPaths = Array.from(projectPathCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([p]) => p);

  const toolsUsed = Array.from(toolsFound).sort();

  log("Analysis complete:", {
    topCommands: topCommands.length,
    projectPaths: projectPaths.length,
    toolsUsed: toolsUsed.length,
  });

  return {
    topCommands,
    projectPaths,
    toolsUsed,
  };
};

export const formatShellAnalysisForSynthesis = (data: ShellAnalysis): string => {
  const sections: string[] = ["## Shell History"];

  if (data.toolsUsed.length > 0) {
    sections.push("\n### Dev Tools Used");
    sections.push(data.toolsUsed.join(", "));
  }

  if (data.topCommands.length > 0) {

    const devCommands = data.topCommands
      .filter((c) => DEV_TOOLS.has(c.command))
      .slice(0, 15);

    if (devCommands.length > 0) {
      sections.push("\n### Command Frequency");
      sections.push(devCommands.map((c) => `${c.command} (${c.count})`).join(", "));
    }
  }

  if (data.projectPaths.length > 0) {

    const meaningful = data.projectPaths.filter((p) => {
      if (path.isAbsolute(p)) return true;

      const segments = p.split(/[\\/]+/).filter(Boolean);
      return segments.length >= 2;
    });

    if (meaningful.length > 0) {
      sections.push("\n### Working Directories");
      sections.push(meaningful.slice(0, 10).join("\n"));
    }
  }

  return sections.join("\n");
};
