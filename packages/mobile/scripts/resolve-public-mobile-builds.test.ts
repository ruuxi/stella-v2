import { describe, expect, test } from "bun:test";

import {
  parseJsonOutput,
  selectAndroidSubmission,
  selectIosLive,
  selectPlayProductionRelease,
  validateEasBuild,
} from "./resolve-public-mobile-builds";

const build = {
  id: "public-build",
  status: "FINISHED",
  appVersion: "1.0.38",
  appBuildVersion: "4",
  gitCommitHash: "abc123",
  updateChannel: { name: "preview" },
  runtime: { version: "public-runtime" },
  fingerprint: { hash: "public-runtime" },
};

describe("public mobile build provenance", () => {
  test("selects the live App Store version instead of newer TestFlight builds", () => {
    const live = selectIosLive({
      ios: {
        live: {
          versionString: "1.0.38",
          buildNumber: "133",
          state: "READY_FOR_DISTRIBUTION",
        },
        testFlightBuilds: [{ appVersion: "1.0.39", buildNumber: "140" }],
      },
    });
    expect(live.versionString).toBe("1.0.38");
    expect(live.buildNumber).toBe("133");
  });

  test("selects the completed production Play release", () => {
    const release = selectPlayProductionRelease({
      track: "production",
      releases: [
        { name: "draft", status: "draft", versionCodes: ["8"] },
        { name: "1.0.38", status: "completed", versionCodes: ["4"] },
      ],
    });
    expect(release.name).toBe("1.0.38");
    expect(release.versionCodes).toEqual(["4"]);
  });

  test("matches Play to a completed production submission rather than the newest build", () => {
    const submission = selectAndroidSubmission(
      [
        {
          id: "newer-preview",
          status: "FINISHED",
          androidConfig: { track: "internal", releaseStatus: "COMPLETED" },
          submittedBuild: { ...build, id: "newer-build", appBuildVersion: "6" },
        },
        {
          id: "public-submission",
          status: "FINISHED",
          androidConfig: { track: "production", releaseStatus: "COMPLETED" },
          submittedBuild: build,
        },
      ],
      "4",
    );
    expect(submission.id).toBe("public-submission");
    expect(submission.submittedBuild?.id).toBe("public-build");
  });

  test("requires the embedded channel and exact runtime fingerprint", () => {
    expect(validateEasBuild(build, "preview")).toEqual({
      channel: "preview",
      runtimeVersion: "public-runtime",
      fingerprintHash: "public-runtime",
    });
    expect(() => validateEasBuild({ ...build, updateChannel: { name: "production" } }, "preview")).toThrow();
    expect(() => validateEasBuild({ ...build, fingerprint: { hash: "other" } }, "preview")).toThrow();
  });

  test("parses JSON after command progress output", () => {
    expect(parseJsonOutput<{ value: number }>("progress\n{\"value\":4}\n")).toEqual({ value: 4 });
  });
});
