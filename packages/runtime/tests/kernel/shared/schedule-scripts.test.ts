import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalCronJobRecord } from "@stella/contracts/scheduling";
import { LocalSchedulerService } from "@stella/runtime/kernel/local-scheduler-service";
import {
  createScheduleScriptAuthEnv,
  runScheduleScript,
} from "@stella/runtime/kernel/shared/schedule-scripts";
import { createScriptDraftTool } from "@stella/runtime/kernel/tools/defs/script-draft";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runScheduleScript", () => {
  it("provides generic site auth and the existing X API aliases", () => {
    expect(
      createScheduleScriptAuthEnv({
        baseUrl: " https://example.convex.site/ ",
        authToken: " test-token ",
      }),
    ).toEqual({
      STELLA_SITE_BASE_URL: "https://example.convex.site/",
      STELLA_SITE_AUTH_TOKEN: "test-token",
      STELLA_X_API_BASE_URL: "https://example.convex.site/",
      STELLA_X_API_AUTH_TOKEN: "test-token",
    });
  });

  it("injects scheduler auth env without losing the script path contract", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stella-schedule-script-"),
    );
    tempRoots.push(root);
    const scriptPath = path.join(root, "scheduled.ts");
    await writeFile(
      scriptPath,
      `console.log(JSON.stringify({
        baseUrl: process.env.STELLA_SITE_BASE_URL,
        authToken: process.env.STELLA_SITE_AUTH_TOKEN,
        scriptPath: process.env.STELLA_SCHEDULE_SCRIPT_PATH,
      }));`,
    );

    const result = await runScheduleScript(scriptPath, {
      env: {
        STELLA_SITE_BASE_URL: "https://example.convex.site",
        STELLA_SITE_AUTH_TOKEN: "test-token",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      baseUrl: "https://example.convex.site",
      authToken: "test-token",
      scriptPath,
    });
  });

  it("gives ScriptDraft dry runs the same auth environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-script-draft-"));
    tempRoots.push(root);
    const tool = createScriptDraftTool({
      stellaDataDir: root,
      getStellaSiteAuth: () => ({
        baseUrl: "https://example.convex.site",
        authToken: "draft-token",
      }),
    });

    const result = await tool.execute({
      code: `console.log(JSON.stringify({
        baseUrl: process.env.STELLA_SITE_BASE_URL,
        authToken: process.env.STELLA_SITE_AUTH_TOKEN,
        xToken: process.env.STELLA_X_API_AUTH_TOKEN,
      }));`,
    });

    expect(result.result).toContain(
      '{"baseUrl":"https://example.convex.site","authToken":"draft-token","xToken":"draft-token"}',
    );
  });

  it("still runs a scheduled script when auth retrieval fails", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stella-scheduler-auth-"),
    );
    tempRoots.push(root);
    const service = new LocalSchedulerService({
      stellaDataDir: root,
      runnerTarget: { getRunner: () => null },
      getScriptAuthEnv: async () => {
        throw new Error("auth unavailable");
      },
    });
    service.start();
    try {
      const scriptsDir = service.getScheduleScriptsDir();
      await mkdir(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, "best-effort.ts");
      await writeFile(
        scriptPath,
        `console.log(process.env.STELLA_SITE_AUTH_TOKEN ?? "ran-without-auth");`,
      );
      const job = service.addCronJob({
        name: "best effort auth",
        conversationId: "conversation:test",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "script", scriptPath },
        deliver: false,
      });
      const privateService = service as unknown as {
        executeCronJob: (
          active: LocalCronJobRecord,
          runner: null,
        ) => Promise<"done" | "busy">;
      };

      await privateService.executeCronJob(job, null);

      expect(service.listCronJobs()[0]).toMatchObject({
        lastStatus: "ok",
        lastOutputPreview: "ran-without-auth",
      });
    } finally {
      service.stop();
    }
  });
});
