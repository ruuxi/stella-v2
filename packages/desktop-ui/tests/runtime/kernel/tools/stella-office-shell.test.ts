import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  createShellState,
  extractOfficePreviewRef,
  runShell,
} from "@stella/runtime/kernel/tools/shell";

const officeBinDir = path.resolve(process.cwd(), "../stella-office", "bin");
const officeWrapperPath = path.join(officeBinDir, "stella-office.js");
const officeNativeReady = [
  "stella-office-linux-x64",
  "stella-office-linux-arm64",
  "stella-office-darwin-arm64",
  "stella-office-darwin-x64",
  "stella-office-win32-x64.exe",
  "stella-office-win32-arm64.exe",
].some((name) => existsSync(path.join(officeBinDir, name)));
const runIfOfficeBinary =
  existsSync(officeWrapperPath) && officeNativeReady ? it : it.skip;

describe("stella-office shell bootstrap", () => {
  runIfOfficeBinary("injects the stella-office command into Bash", async () => {
    const state = createShellState(os.tmpdir(), {
      stellaOfficeBinPath: officeWrapperPath,
    });
    const command = "stella-office --version";

    const output = await runShell(state, command, process.cwd(), 10_000);

    expect(output).not.toContain("Command exited with code");
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it("extracts inline office preview refs from shell output", () => {
    const output = [
      "__STELLA_OFFICE_PREVIEW_REF__{\"sessionId\":\"preview-123\",\"title\":\"deck.pptx\",\"sourcePath\":\"/tmp/deck.pptx\"}",
      "Started inline office preview for deck.pptx.",
    ].join("\n");

    const extracted = extractOfficePreviewRef(output);

    expect(extracted.cleanedOutput).toBe(
      "Started inline office preview for deck.pptx.",
    );
    expect(extracted.officePreviewRef).toEqual({
      sessionId: "preview-123",
      title: "deck.pptx",
      sourcePath: "/tmp/deck.pptx",
    });
  });
});
