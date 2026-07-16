import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isFullWindowReloadRelevantPath,
  isRendererHmrRelevantPath,
  isRestartRequiredNonHmrPath,
  isSelfModRelevantPath,
  isViteTrackablePath,
  isWorkerRestartRelevantPath,
  normalizeContentionPath,
  toSelfModRelevantKey,
} from "@stella/runtime/kernel/self-mod/path-relevance";

const repoRoot = path.resolve("/tmp/stella-fake-root");

describe("normalizeContentionPath", () => {
  it("returns repo-relative posix path for source files", () => {
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "src", "app.tsx"),
        repoRoot,
      ),
    ).toBe("packages/desktop-ui/src/app.tsx");
  });

  it("rejects paths outside the repo root", () => {
    expect(
      normalizeContentionPath("/var/log/system.log", repoRoot),
    ).toBeNull();
  });

  it("rejects excluded path segments (node_modules, dist, .git, dist-electron)", () => {
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "node_modules", "x", "index.js"),
        repoRoot,
      ),
    ).toBeNull();
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "dist-electron", "main.js"),
        repoRoot,
      ),
    ).toBeNull();
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "dist", "bundle.js"),
        repoRoot,
      ),
    ).toBeNull();
  });

  it("rejects binary / artifact extensions (CSV, PDF, MP4, PNG)", () => {
    for (const filename of [
      "report.csv",
      "deck.pdf",
      "clip.mp4",
      "icon.png",
      "data.sqlite",
      "lock.lockb",
    ]) {
      expect(
        normalizeContentionPath(
          path.join(repoRoot, "packages", "desktop-ui", "exports", filename),
          repoRoot,
        ),
      ).toBeNull();
    }
  });

  it("allows text renderer assets that Vite serves as source modules", () => {
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "src", "icons", "logo.svg"),
        repoRoot,
      ),
    ).toBe("packages/desktop-ui/src/icons/logo.svg");
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "exports", "logo.svg"),
        repoRoot,
      ),
    ).toBeNull();
  });

  it("allows top-level lockfile exceptions before artifact suffix exclusion", () => {
    expect(
      normalizeContentionPath(path.join(repoRoot, "bun.lockb"), repoRoot),
    ).toBe("bun.lockb");
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "exports", "lock.lockb"),
        repoRoot,
      ),
    ).toBeNull();
  });

  it("allows legacy nested package manifests before artifact suffix exclusion", () => {
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "desktop-ui", "package.json"),
        repoRoot,
      ),
    ).toBe("packages/desktop-ui/package.json");
    expect(
      normalizeContentionPath(
        path.join(repoRoot, "packages", "stella-browser", "bun.lockb"),
        repoRoot,
      ),
    ).toBe("packages/stella-browser/bun.lockb");
  });

  it("rejects the repo root itself", () => {
    expect(normalizeContentionPath(repoRoot, repoRoot)).toBeNull();
  });
});

describe("isRendererHmrRelevantPath", () => {
  it("accepts renderer modules that can be applied by the Vite overlay", () => {
    expect(isRendererHmrRelevantPath("packages/desktop-ui/src/app.tsx")).toBe(true);
    expect(isRendererHmrRelevantPath("packages/desktop-ui/src/icons/logo.svg")).toBe(true);
  });

  it("rejects restart-required and non-renderer paths from renderer HMR contention", () => {
    expect(isRendererHmrRelevantPath("packages/desktop/electron/main.ts")).toBe(false);
    expect(isRendererHmrRelevantPath("packages/desktop-ui/vite.config.ts")).toBe(false);
    expect(isRendererHmrRelevantPath("packages/runtime/kernel/runner.ts")).toBe(false);
    expect(isRendererHmrRelevantPath("package.json")).toBe(false);
    expect(isRendererHmrRelevantPath("bun.lock")).toBe(false);
    expect(isRendererHmrRelevantPath("bun.lockb")).toBe(false);
  });

  it("rejects unknown top-level files", () => {
    expect(isRendererHmrRelevantPath("README.md")).toBe(false);
    expect(isRendererHmrRelevantPath("notes.txt")).toBe(false);
  });

  it("rejects paths outside known source roots", () => {
    expect(isRendererHmrRelevantPath("docs/api.md")).toBe(false);
    expect(isRendererHmrRelevantPath("scripts/build.sh")).toBe(false);
  });
});

describe("isWorkerRestartRelevantPath", () => {
  it("flags runtime/kernel paths that are not host-owned", () => {
    expect(isWorkerRestartRelevantPath("packages/runtime/kernel/runner.ts")).toBe(true);
    expect(
      isWorkerRestartRelevantPath("packages/runtime/kernel/agent-runtime/run-events.ts"),
    ).toBe(true);
  });

  it("does not flag host-owned runtime/kernel paths", () => {
    expect(isWorkerRestartRelevantPath("packages/runtime/kernel/storage/foo.ts")).toBe(false);
    expect(isWorkerRestartRelevantPath("packages/runtime/kernel/shared/util.ts")).toBe(false);
    expect(
      isWorkerRestartRelevantPath("packages/runtime/kernel/preferences/local-preferences.ts"),
    ).toBe(false);
  });

  it("flags runtime/ai, runtime/worker, packages/contracts/protocol/jsonl paths", () => {
    expect(isWorkerRestartRelevantPath("packages/runtime/ai/index.ts")).toBe(true);
    expect(isWorkerRestartRelevantPath("packages/runtime/worker/server.ts")).toBe(true);
    expect(isWorkerRestartRelevantPath("packages/contracts/protocol/jsonl/peer.ts")).toBe(true);
  });

  it("flags shipped agent metadata so applied capability updates restart the worker", () => {
    expect(
      isWorkerRestartRelevantPath(
        "packages/runtime/extensions/stella-runtime/agent-metadata/orchestrator.md",
      ),
    ).toBe(true);
  });

  it("does not flag desktop/* paths", () => {
    expect(isWorkerRestartRelevantPath("packages/desktop-ui/src/app.tsx")).toBe(false);
  });
});

describe("isFullWindowReloadRelevantPath", () => {
  it("flags Vite-served browser resources that need a full window reload", () => {
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/index.html")).toBe(true);
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/mini.html")).toBe(true);
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/overlay.html")).toBe(true);
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/pet.html")).toBe(true);
  });

  it("flags sidebar app metadata because it changes the eager app glob", () => {
    expect(
      isFullWindowReloadRelevantPath("packages/desktop-ui/src/app/launch-checklist/metadata.ts"),
    ).toBe(true);
  });

  it("flags theme registry modules because the theme picker reads a glob snapshot", () => {
    expect(
      isFullWindowReloadRelevantPath(
        "packages/desktop-ui/src/shared/theme/themes/interstellar.ts",
      ),
    ).toBe(true);
    expect(
      isFullWindowReloadRelevantPath("packages/desktop-ui/src/shared/theme/themes/index.ts"),
    ).toBe(true);
  });

  it("does not pretend manifests or Vite config can be fixed by browser reload", () => {
    expect(isFullWindowReloadRelevantPath("package.json")).toBe(false);
    expect(isFullWindowReloadRelevantPath("bun.lock")).toBe(false);
    expect(isFullWindowReloadRelevantPath("bun.lockb")).toBe(false);
    expect(isFullWindowReloadRelevantPath("tsconfig.json")).toBe(false);
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/vite.config.ts")).toBe(false);
  });

  it("does not flag ordinary desktop modules", () => {
    expect(isFullWindowReloadRelevantPath("packages/desktop-ui/src/app.tsx")).toBe(false);
    expect(
      isFullWindowReloadRelevantPath(
        "packages/desktop-ui/src/app/launch-checklist/LaunchChecklistView.tsx",
      ),
    ).toBe(false);
  });
});

describe("isViteTrackablePath", () => {
  it("accepts only files the Vite overlay can pin or reload", () => {
    expect(isViteTrackablePath("packages/desktop-ui/src/app.tsx")).toBe(true);
    expect(isViteTrackablePath("packages/desktop-ui/src/icons/logo.svg")).toBe(true);
    expect(isViteTrackablePath("packages/desktop-ui/index.html")).toBe(true);
    expect(isViteTrackablePath("packages/desktop-ui/mini.html")).toBe(true);
    expect(isViteTrackablePath("packages/desktop-ui/overlay.html")).toBe(true);
    expect(isViteTrackablePath("packages/desktop-ui/pet.html")).toBe(true);
    expect(isViteTrackablePath("package.json")).toBe(false);
    expect(isViteTrackablePath("packages/desktop-ui/vite.config.ts")).toBe(false);
    expect(isViteTrackablePath("packages/runtime/kernel/runner.ts")).toBe(false);
  });
});

describe("isRestartRequiredNonHmrPath", () => {
  it("flags manifests, Vite config, and non-renderer source roots", () => {
    expect(isRestartRequiredNonHmrPath("package.json")).toBe(true);
    expect(isRestartRequiredNonHmrPath("bun.lock")).toBe(true);
    expect(isRestartRequiredNonHmrPath("bun.lockb")).toBe(true);
    expect(
      isRestartRequiredNonHmrPath("packages/stella-browser/bun.lockb"),
    ).toBe(true);
    expect(isRestartRequiredNonHmrPath("packages/desktop-ui/vite.config.ts")).toBe(true);
    expect(isRestartRequiredNonHmrPath("packages/desktop/electron/main.ts")).toBe(true);
    expect(
      isRestartRequiredNonHmrPath(
        "packages/stella-browser/bin/stella-browser-darwin-arm64",
      ),
    ).toBe(true);
    expect(isRestartRequiredNonHmrPath("packages/runtime/kernel/runner.ts")).toBe(true);
  });

  it("does not flag renderer HMR paths", () => {
    expect(isRestartRequiredNonHmrPath("packages/desktop-ui/src/app.tsx")).toBe(false);
  });
});

describe("isSelfModRelevantPath", () => {
  it("accepts renderer, full-reload, worker, and restart-required paths", () => {
    expect(isSelfModRelevantPath("packages/desktop-ui/src/app.tsx")).toBe(true);
    expect(isSelfModRelevantPath("packages/desktop-ui/index.html")).toBe(true);
    expect(isSelfModRelevantPath("packages/desktop-ui/mini.html")).toBe(true);
    expect(isSelfModRelevantPath("packages/desktop-ui/overlay.html")).toBe(true);
    expect(isSelfModRelevantPath("packages/desktop-ui/pet.html")).toBe(true);
    expect(isSelfModRelevantPath("packages/runtime/kernel/runner.ts")).toBe(true);
    expect(isSelfModRelevantPath("packages/desktop-ui/vite.config.ts")).toBe(true);
    expect(isSelfModRelevantPath("package.json")).toBe(true);
  });

  it("rejects unrelated docs and artifact paths", () => {
    expect(isSelfModRelevantPath("README.md")).toBe(false);
    expect(isSelfModRelevantPath("outputs/exports/report.csv")).toBe(false);
  });
});

describe("toSelfModRelevantKey", () => {
  it("keeps restart-required and full-reload paths in the controller", () => {
    expect(
      toSelfModRelevantKey(path.join(repoRoot, "package.json"), repoRoot),
    ).toBe("package.json");
    expect(
      toSelfModRelevantKey(path.join(repoRoot, "packages", "desktop-ui", "index.html"), repoRoot),
    ).toBe("packages/desktop-ui/index.html");
    expect(
      toSelfModRelevantKey(path.join(repoRoot, "packages", "desktop-ui", "mini.html"), repoRoot),
    ).toBe("packages/desktop-ui/mini.html");
    expect(
      toSelfModRelevantKey(
        path.join(repoRoot, "packages", "runtime", "kernel", "runner.ts"),
        repoRoot,
      ),
    ).toBe("packages/runtime/kernel/runner.ts");
    expect(
      toSelfModRelevantKey(
        path.join(repoRoot, "packages", "desktop-ui", "package.json"),
        repoRoot,
      ),
    ).toBe("packages/desktop-ui/package.json");
    expect(
      toSelfModRelevantKey(
        path.join(repoRoot, "packages", "stella-browser", "bun.lockb"),
        repoRoot,
      ),
    ).toBe("packages/stella-browser/bun.lockb");
  });

  it("still rejects unrelated paths", () => {
    expect(
      toSelfModRelevantKey(path.join(repoRoot, "docs", "guide.md"), repoRoot),
    ).toBeNull();
  });
});
