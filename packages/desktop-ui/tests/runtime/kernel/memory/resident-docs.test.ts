import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unicodeCodePointLength } from "@stella/runtime/kernel/memory/dream-storage";

import {
  LIFE_MEMORY_MAP_DISPLAY_PATH,
  readMemoryMapDoc,
  readStartupDocBodyFromDisk,
  readUserProfileDoc,
  RETIRED_STARTUP_DOC_DISPLAY_PATHS,
  stripInjectedHtmlComments,
} from "@stella/runtime/kernel/memory/resident-docs";

let stellaDataDir: string;

const writeMemoryFile = (name: string, content: string): void => {
  const memoriesDir = path.join(stellaDataDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, name), content);
};

describe("stripInjectedHtmlComments", () => {
  it("removes retired comment transport without changing visible content", () => {
    expect(
      stripInjectedHtmlComments(
        "# Active\n\n- user-authored <!-- inline retired note --> content\n\n<!-- DREAM:RETIRED_SUMMARY\n- old bullet\n-->\n\n- another live entry",
      ),
    ).toBe("# Active\n\n- user-authored  content\n\n- another live entry");
  });

  it("drops an unterminated comment through end-of-doc", () => {
    expect(
      stripInjectedHtmlComments("live\n<!-- retired archive that never closes"),
    ).toBe("live");
  });

  it("returns empty for a comment-only document", () => {
    expect(stripInjectedHtmlComments("<!-- template guidance only -->")).toBe(
      "",
    );
  });
});

describe("resident memory document reads", () => {
  beforeEach(() => {
    stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-resident-docs-"),
    );
  });

  afterEach(() => {
    fs.rmSync(stellaDataDir, { recursive: true, force: true });
  });

  it("injects only the map's non-comment content", () => {
    writeMemoryFile(
      "memory_map.md",
      "<!-- DREAM:MAP_CHARTER\nwriter guidance\n-->\n# Memory map\n\n<!-- DREAM:MAP_START -->\n- benchmark -> MEMORY.md\n<!-- DREAM:MAP_END -->",
    );
    expect(readMemoryMapDoc(stellaDataDir)).toBe(
      "# Memory map\n\n- benchmark -> MEMORY.md",
    );
    expect(
      readStartupDocBodyFromDisk(stellaDataDir, LIFE_MEMORY_MAP_DISPLAY_PATH),
    ).toContain("benchmark");
  });

  it("caps an oversized map at a complete line without corrupting Unicode or CRLF", () => {
    writeMemoryFile(
      "memory_map.md",
      `<!-- guidance -->\r\n${"- 😀 cafe\u0301 route\r\n".repeat(600)}`,
    );
    const map = readMemoryMapDoc(stellaDataDir);
    expect(unicodeCodePointLength(map ?? "")).toBeLessThanOrEqual(6_000);
    expect(map).toContain("[resident memory truncated]");
    expect(map).not.toMatch(/\r(?!\n)/u);
    expect(map).not.toContain("\uFFFD");
    expect(/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(map ?? "")).toBe(
      false,
    );
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(map ?? "")).toBe(false);
  });

  it("preserves an exact 6,000-code-point map without truncation", () => {
    const exact = "😀".repeat(6_000);
    writeMemoryFile("memory_map.md", exact);
    const map = readMemoryMapDoc(stellaDataDir);
    expect(map).toBe(exact);
    expect(unicodeCodePointLength(map ?? "")).toBe(6_000);
  });

  it("rejects malformed UTF-8 instead of injecting replacement characters", () => {
    const memoriesDir = path.join(stellaDataDir, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoriesDir, "memory_map.md"),
      new Uint8Array([0xc3, 0x28]),
    );
    expect(readMemoryMapDoc(stellaDataDir)).toBeUndefined();
  });

  it("never reloads retired summary or index paths", () => {
    writeMemoryFile("memory_summary.md", "# Memory summary\n\n- focus");
    writeMemoryFile("memory_index.md", "# Memory index\n\n- entry");
    for (const retiredPath of RETIRED_STARTUP_DOC_DISPLAY_PATHS) {
      expect(
        readStartupDocBodyFromDisk(stellaDataDir, retiredPath),
      ).toBeUndefined();
    }
  });

  it("strips comments from profile injection without rewriting its file", () => {
    const raw =
      "# User Profile\n\n- goes by Bob\n<!-- superseded: went by Robert -->";
    writeMemoryFile("profile.md", raw);
    expect(readUserProfileDoc(stellaDataDir)).toBe(
      "# User Profile\n\n- goes by Bob",
    );
    expect(
      fs.readFileSync(
        path.join(stellaDataDir, "memories", "profile.md"),
        "utf-8",
      ),
    ).toBe(raw);
  });
});
