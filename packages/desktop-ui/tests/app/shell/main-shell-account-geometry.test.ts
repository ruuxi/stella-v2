import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Rect = {
  left: number;
  right: number;
  width: number;
};

type GeometrySample = {
  label: string;
  shell: Rect;
  main: Rect;
  actions: Rect;
  account: Rect;
  accountRendered: boolean;
  sidebar: Rect;
};

type GeometryResult = {
  desiredGap: number;
  samples: GeometrySample[];
};

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(TEST_ROOT, "../../../src");
const FIXTURE_PATH = path.join(
  TEST_ROOT,
  "fixtures/main-shell-account-geometry.cjs",
);

const runGeometryProbe = async (): Promise<GeometryResult> => {
  const require = createRequire(import.meta.url);
  const electronPath = require("electron") as string;
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;

  return await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [FIXTURE_PATH], {
      env: {
        ...environment,
        STELLA_GEOMETRY_SOURCE_ROOT: SOURCE_ROOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            "Electron geometry probe failed (" +
              String(code) +
              "):\n" +
              stderr +
              stdout,
          ),
        );
        return;
      }
      const marker = "STELLA_GEOMETRY_RESULT=";
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(marker));
      if (!line) {
        reject(new Error("Geometry result missing:\n" + stderr + stdout));
        return;
      }
      resolve(JSON.parse(line.slice(marker.length)) as GeometryResult);
    });
  });
};

describe("main-shell account geometry", () => {
  it(
    "stays strictly left of the opened sidebar across animation and resize",
    async () => {
      const result = await runGeometryProbe();
      const samplesByLabel = new Map(
        result.samples.map((sample) => [sample.label, sample]),
      );
      const openSamples = result.samples.filter(
        (sample) => sample.sidebar.width > 0.5 && sample.accountRendered,
      );

      expect(result.desiredGap).toBeGreaterThan(0);
      expect(openSamples.length).toBeGreaterThanOrEqual(7);
      for (const sample of openSamples) {
        expect(
          sample.account.right,
          sample.label,
        ).toBeLessThanOrEqual(
          sample.sidebar.left - result.desiredGap + 0.25,
        );
        expect(sample.main.right, sample.label).toBeCloseTo(
          sample.sidebar.left,
          1,
        );
      }

      expect(
        samplesByLabel.get("resized-open-640")?.account.right,
      ).toBeLessThan(
        samplesByLabel.get("resized-open-420")?.account.right ?? 0,
      );
      expect(
        samplesByLabel.get("default-open-end")?.sidebar.width,
      ).toBeGreaterThan(380);
      expect(samplesByLabel.get("resized-open-640")?.sidebar.width).toBeCloseTo(
        640,
        0,
      );
      expect(samplesByLabel.get("resized-open-420")?.sidebar.width).toBeCloseTo(
        420,
        0,
      );
      expect(
        samplesByLabel.get("resized-open-narrow-shell")?.account.right,
      ).toBeLessThan(
        samplesByLabel.get("resized-open-wide-shell")?.account.right ?? 0,
      );
      expect(samplesByLabel.get("expanded-panel")?.accountRendered).toBe(
        false,
      );
      expect(samplesByLabel.get("expanded-panel")?.account.width).toBe(0);
      expect(samplesByLabel.get("restored-from-expanded")?.accountRendered).toBe(
        true,
      );

      for (const label of ["closed", "closed-end"]) {
        const sample = samplesByLabel.get(label);
        expect(sample?.sidebar.width, label).toBeCloseTo(0, 1);
        expect(sample?.main.right, label).toBeCloseTo(sample?.shell.right ?? 0, 1);
        expect(sample?.actions.right, label).toBeCloseTo(
          sample?.shell.right ?? 0,
          1,
        );
        expect(sample?.account.right, label).toBeCloseTo(
          (sample?.shell.right ?? 0) - result.desiredGap,
          1,
        );
      }
    },
    20_000,
  );
});
