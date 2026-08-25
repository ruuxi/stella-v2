/**
 * Fire-time behavior of the three trigger kinds:
 *
 *  - reminder (`notify`) — direct message + notification, no runner
 *  - task — stored intent delivered as an orchestrator turn
 *  - watch — deterministic sensor: silent when unchanged, orchestrator
 *    escalation on diff or sensor failure, busy-parking of escalations
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalCronJobRecord } from "@stella/contracts/scheduling";
import { LocalSchedulerService } from "@stella/runtime/kernel/local-scheduler-service";

type AutomationTurn = {
  conversationId: string;
  userPrompt: string;
  agentType?: string;
};

type AutomationResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const makeRunner = (
  respond: (turn: AutomationTurn) => AutomationResult,
) => {
  const turns: AutomationTurn[] = [];
  const runner = {
    runAutomationTurn: async (turn: AutomationTurn) => {
      turns.push(turn);
      return respond(turn);
    },
    getActiveOrchestratorRun: () => null,
  };
  return { runner, turns };
};

const makeService = async (
  runner: ReturnType<typeof makeRunner>["runner"] | null,
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-sched-triggers-"));
  tempRoots.push(root);
  const notifications: Array<{ title: string; body: string }> = [];
  const service = new LocalSchedulerService({
    stellaDataDir: root,
    runnerTarget: { getRunner: () => runner as never },
    showNotification: (params) =>
      notifications.push({ title: params.title, body: params.body }),
  });
  service.start();
  return { service, notifications };
};

type PrivateService = {
  executeCronJob: (
    active: LocalCronJobRecord,
    runner: unknown,
  ) => Promise<"done" | "busy">;
};

const fire = (
  service: LocalSchedulerService,
  job: LocalCronJobRecord,
  runner: unknown,
) => (service as unknown as PrivateService).executeCronJob(job, runner);

describe("reminder trigger", () => {
  it("delivers the stored message + notification with no runner involved", async () => {
    const { service, notifications } = await makeService(null);
    try {
      const job = service.addCronJob({
        name: "Lunch",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "notify", text: "12:00 PM — lunch time" },
      });

      await fire(service, job, null);

      expect(service.listCronJobs()[0]).toMatchObject({
        lastStatus: "ok",
        lastOutputPreview: "12:00 PM — lunch time",
      });
      expect(notifications).toEqual([
        { title: "Lunch", body: "12:00 PM — lunch time" },
      ]);
      expect(service.listConversationEvents("c1")).toHaveLength(1);
    } finally {
      service.stop();
    }
  });
});

describe("task trigger", () => {
  it("delivers the stored intent as an orchestrator turn and reports the result", async () => {
    const { runner, turns } = makeRunner(() => ({
      status: "ok",
      finalText: "Inbox summarized: 3 items need you.",
    }));
    const { service, notifications } = await makeService(runner);
    try {
      const job = service.addCronJob({
        name: "Morning brief",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "task", prompt: "Summarize my inbox." },
      });

      await fire(service, job, runner);

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        conversationId: "c1",
        agentType: "orchestrator",
      });
      expect(turns[0]!.userPrompt).toContain("Summarize my inbox.");
      expect(service.listCronJobs()[0]).toMatchObject({ lastStatus: "ok" });
      expect(notifications).toEqual([
        { title: "Morning brief", body: "Inbox summarized: 3 items need you." },
      ]);
    } finally {
      service.stop();
    }
  });
});

describe("watch trigger", () => {
  const writeScript = async (
    service: LocalSchedulerService,
    name: string,
    code: string,
  ) => {
    const scriptsDir = service.getScheduleScriptsDir();
    await mkdir(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, name);
    await writeFile(scriptPath, code);
    return scriptPath;
  };

  it("is silent when the sensor reports no change", async () => {
    const { runner, turns } = makeRunner(() => ({
      status: "ok",
      finalText: "should never run",
    }));
    const { service, notifications } = await makeService(runner);
    try {
      const scriptPath = await writeScript(service, "no-change.ts", "");
      const job = service.addCronJob({
        name: "Watch: models",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "watch", scriptPath },
      });

      await fire(service, job, runner);

      expect(turns).toHaveLength(0);
      expect(notifications).toHaveLength(0);
      expect(service.listConversationEvents("c1")).toHaveLength(0);
      expect(service.listCronJobs()[0]).toMatchObject({
        lastStatus: "no-change",
      });
    } finally {
      service.stop();
    }
  });

  it("escalates a detected change to an orchestrator turn and delivers its reply", async () => {
    const { runner, turns } = makeRunner(() => ({
      status: "ok",
      finalText: "New OpenRouter model: example-1.",
    }));
    const { service, notifications } = await makeService(runner);
    try {
      const scriptPath = await writeScript(
        service,
        "change.ts",
        `console.log("model added: example-1");`,
      );
      const job = service.addCronJob({
        name: "Watch: models",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "watch", scriptPath },
      });

      await fire(service, job, runner);

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ agentType: "orchestrator" });
      expect(turns[0]!.userPrompt).toContain("detected a change");
      expect(turns[0]!.userPrompt).toContain("model added: example-1");
      expect(service.listCronJobs()[0]).toMatchObject({ lastStatus: "ok" });
      expect(notifications).toEqual([
        { title: "Watch: models", body: "New OpenRouter model: example-1." },
      ]);
    } finally {
      service.stop();
    }
  });

  it("escalates a sensor failure so the orchestrator can repair it", async () => {
    const { runner, turns } = makeRunner(() => ({
      status: "ok",
      finalText: "The models watch broke; I'm fixing it.",
    }));
    const { service } = await makeService(runner);
    try {
      const scriptPath = await writeScript(
        service,
        "broken.ts",
        `console.error("endpoint 404"); process.exit(3);`,
      );
      const job = service.addCronJob({
        name: "Watch: models",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "watch", scriptPath },
      });

      await fire(service, job, runner);

      expect(turns).toHaveLength(1);
      expect(turns[0]!.userPrompt).toContain("FAILED");
      expect(turns[0]!.userPrompt).toContain("exit 3");
      expect(turns[0]!.userPrompt).toContain(scriptPath);
      expect(service.listCronJobs()[0]).toMatchObject({
        lastStatus: "sensor-error",
      });
      expect(service.listCronJobs()[0]?.lastError).toContain("endpoint 404");
    } finally {
      service.stop();
    }
  });

  it("parks an escalation while the worker is busy and drains it without re-running the script", async () => {
    let busy = true;
    const { runner, turns } = makeRunner(() =>
      busy
        ? { status: "busy", finalText: "", error: "busy" }
        : { status: "ok", finalText: "Change delivered late." },
    );
    const { service } = await makeService(runner);
    try {
      // The script self-destructs its marker after one run: a second
      // execution would print nothing, so a drained escalation proves the
      // scheduler did NOT re-run it.
      const scriptPath = await writeScript(
        service,
        "one-shot-diff.ts",
        `import fs from "node:fs";
const marker = process.env.STELLA_SCHEDULE_SCRIPT_PATH + ".state.json";
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, "{}");
  console.log("first-run diff");
}`,
      );
      const job = service.addCronJob({
        name: "Watch: parked",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "watch", scriptPath },
      });

      const first = await fire(service, job, runner);
      expect(first).toBe("busy");
      expect(service.listCronJobs()[0]?.pendingEscalation).toMatchObject({
        reason: "change",
        summary: "first-run diff",
      });

      busy = false;
      const second = await fire(service, service.listCronJobs()[0]!, runner);
      expect(second).toBe("done");
      expect(turns).toHaveLength(2);
      expect(turns[1]!.userPrompt).toContain("first-run diff");
      expect(service.listCronJobs()[0]?.pendingEscalation).toBeUndefined();
      expect(service.listCronJobs()[0]).toMatchObject({ lastStatus: "ok" });
    } finally {
      service.stop();
    }
  });
});

describe("legacy payload compatibility", () => {
  it("keeps executing legacy script jobs with direct delivery (no orchestrator turn)", async () => {
    const { runner, turns } = makeRunner(() => ({
      status: "ok",
      finalText: "unused",
    }));
    const { service, notifications } = await makeService(runner);
    try {
      const scriptsDir = service.getScheduleScriptsDir();
      await mkdir(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, "legacy.ts");
      await writeFile(scriptPath, `console.log("legacy message");`);
      const job = service.addCronJob({
        name: "Legacy script",
        conversationId: "c1",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "script", scriptPath },
      });

      await fire(service, job, runner);

      expect(turns).toHaveLength(0);
      expect(notifications).toEqual([
        { title: "Legacy script", body: "legacy message" },
      ]);
      expect(service.listCronJobs()[0]).toMatchObject({ lastStatus: "ok" });
    } finally {
      service.stop();
    }
  });
});
