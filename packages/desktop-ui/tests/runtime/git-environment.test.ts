import { describe, expect, it } from "vitest";

import { setupGitEnvironment } from "@stella/runtime/git-environment.js";

describe("setupGitEnvironment", () => {
  it("uses Stella's managed Git and preserves its runtime environment", () => {
    const result = setupGitEnvironment({
      STELLA_GIT_BIN: "/private/stella/git/bin/git",
      GIT_EXEC_PATH: "/private/stella/git/libexec/git-core",
    });

    expect(result.gitLocation).toBe("/private/stella/git/bin/git");
    expect(result.env.GIT_EXEC_PATH).toBe(
      "/private/stella/git/libexec/git-core",
    );
  });

  it("falls back to Git on PATH in source runs", () => {
    const previous = process.env.STELLA_GIT_BIN;
    delete process.env.STELLA_GIT_BIN;
    try {
      expect(setupGitEnvironment().gitLocation).toBe("git");
    } finally {
      if (previous === undefined) delete process.env.STELLA_GIT_BIN;
      else process.env.STELLA_GIT_BIN = previous;
    }
  });
});
