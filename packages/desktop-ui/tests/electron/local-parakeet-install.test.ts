import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  downloadModelWithResume: vi.fn(),
  helperPath: "/fake/parakeet_transcriber",
  userData: "",
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.userData),
  },
}));

vi.mock("../../../desktop/electron/native-helper-path.js", () => ({
  resolveNativeHelperPath: vi.fn(() => mocks.helperPath),
}));

vi.mock(
  "../../../desktop/electron/dictation/resumable-model-download.js",
  () => ({
    downloadModelWithResume: mocks.downloadModelWithResume,
  }),
);

const originalPlatform = process.platform;
const originalArch = process.arch;
const roots: string[] = [];

const forceAppleSilicon = () => {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: "arm64",
    configurable: true,
  });
};

const forceWindowsX64 = () => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: "x64",
    configurable: true,
  });
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  forceAppleSilicon();
  mocks.userData = await mkdtemp(
    path.join(os.tmpdir(), "stella-parakeet-install-"),
  );
  roots.push(mocks.userData);
});

afterEach(async () => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: originalArch,
    configurable: true,
  });
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local Parakeet background installation", () => {
  it("fails fast into cloud fallback while CoreML is not installed", async () => {
    const { getLocalParakeetStatus, transcribeWithLocalParakeet } =
      await import(
        "../../../desktop/electron/dictation/local-parakeet.js"
      );

    await expect(getLocalParakeetStatus()).resolves.toMatchObject({
      available: false,
      reason: "Local Parakeet model is not installed yet.",
    });
    await expect(transcribeWithLocalParakeet("audio")).rejects.toThrow(
      "not installed yet",
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("deduplicates installation and marks CoreML ready only after verification", async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() =>
          callback(
            null,
            '{"ok":true,"model":"parakeet-tdt-0.6b-v3-coreml"}\n',
          ),
        );
        return { kill: vi.fn() };
      },
    );
    const { downloadLocalParakeet, getLocalParakeetStatus } = await import(
      "../../../desktop/electron/dictation/local-parakeet.js"
    );

    const [first, second] = await Promise.all([
      downloadLocalParakeet(),
      downloadLocalParakeet(),
    ]);

    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual([
      "--download",
      "--cache-root",
      path.join(mocks.userData, "models", "parakeet"),
    ]);
    await expect(getLocalParakeetStatus()).resolves.toMatchObject({
      available: true,
      model: "parakeet-tdt-0.6b-v3-coreml",
    });
    const cacheFiles = await readdir(
      path.join(mocks.userData, "models", "parakeet"),
    );
    expect(cacheFiles).toContain(
      ".parakeet-tdt-0.6b-v3-coreml.ready",
    );
  });

  it("downloads and verifies the Windows GGUF model in the background", async () => {
    forceWindowsX64();
    mocks.downloadModelWithResume.mockImplementation(
      async ({ targetPath }: { targetPath: string }) => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, "");
        await truncate(targetPath, 940_663_680);
        return targetPath;
      },
    );
    const { downloadLocalParakeet, getLocalParakeetStatus } = await import(
      "../../../desktop/electron/dictation/local-parakeet.js"
    );

    await expect(getLocalParakeetStatus()).resolves.toMatchObject({
      available: false,
      reason: "Local Parakeet model is not installed yet.",
    });
    const [first, second] = await Promise.all([
      downloadLocalParakeet(),
      downloadLocalParakeet(),
    ]);

    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    expect(mocks.downloadModelWithResume).toHaveBeenCalledOnce();
    expect(mocks.downloadModelWithResume).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: path.join(
          mocks.userData,
          "models",
          "parakeet-cpp",
          "tdt-0.6b-v3-q8_0.gguf",
        ),
        expectedSize: 940_663_680,
      }),
    );
    await expect(getLocalParakeetStatus()).resolves.toMatchObject({
      available: true,
      model: "parakeet-tdt-0.6b-v3-gguf",
    });
  });
});
