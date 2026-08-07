import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
  nativeImage: {
    createEmpty: vi.fn(),
    createFromPath: vi.fn(),
  },
}));

const { resolveTrayIconPath } = await import(
  "../../../desktop/electron/windows/tray-controller.ts"
);

const tempRoots: string[] = [];

const makeTempRoot = () => {
  const root = path.join(
    os.tmpdir(),
    `stella-tray-controller-${process.pid}-${tempRoots.length}`,
  );
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Windows tray icon resolution", () => {
  it("uses the ICO copied beside app.asar in a packaged build", () => {
    const root = makeTempRoot();
    const resourcesPath = path.join(root, "resources");
    const iconPath = path.join(resourcesPath, "stella-tray.ico");
    const electronDir = path.join(
      resourcesPath,
      "app.asar",
      "dist-electron",
      "electron",
    );
    mkdirSync(resourcesPath, { recursive: true });
    writeFileSync(iconPath, "ico");

    expect(resolveTrayIconPath(electronDir, resourcesPath)).toBe(iconPath);
  });

  it("resolves build/icon.ico from the actual development output depth", () => {
    const root = makeTempRoot();
    const desktopRoot = path.join(root, "packages", "desktop");
    const electronDir = path.join(desktopRoot, "dist-electron", "electron");
    const iconPath = path.join(desktopRoot, "build", "icon.ico");
    mkdirSync(path.dirname(iconPath), { recursive: true });
    writeFileSync(iconPath, "ico");

    expect(
      resolveTrayIconPath(electronDir, path.join(root, "missing-resources")),
    ).toBe(iconPath);
  });

  it("ships the resolved packaged ICO through electron-builder", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );

    expect(packageJson.build.extraResources).toContainEqual({
      from: "packages/desktop/build/icon.ico",
      to: "stella-tray.ico",
    });
  });
});
