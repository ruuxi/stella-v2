import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeCleanupApply,
  assertExactInstanceStillLive,
  buildInventoryReport,
  cleanupConfirmation,
  configuredContainerApplications,
  createWranglerReader,
  inferWorkload,
  parseDurableInventory,
  parseJsonc,
  parseWranglerApplications,
  parseWranglerInstancesPage,
  planExactCleanup,
} from "../scripts/sandbox-inventory-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "sandbox-inventory");
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const inputs = () => {
  const config = parseJsonc(
    readFileSync(path.join(FIXTURES, "wrangler.jsonc"), "utf8"),
  );
  const configured = configuredContainerApplications(config);
  const applications = parseWranglerApplications(readJson("applications.json"));
  const rawInstances = readJson("instances.json") as Record<string, unknown>;
  const instancesByApplication = new Map(
    Object.entries(rawInstances).map(([applicationId, page]) => [
      applicationId,
      parseWranglerInstancesPage(page).instances,
    ]),
  );
  return { configured, applications, instancesByApplication };
};

describe("sandbox inventory operational parser", () => {
  test("parses JSONC without treating URL slashes as comments", () => {
    const config = parseJsonc(
      readFileSync(path.join(FIXTURES, "wrangler.jsonc"), "utf8"),
    );
    expect(config.vars.URL_WITH_COMMENT_CHARS).toBe(
      "https://example.invalid/a//b",
    );
    expect(configuredContainerApplications(config)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: "dev",
          applicationName: "stella-v2-cloud-builder-dev-appbuildsandbox",
          className: "AppBuildSandbox",
          instanceType: "standard-4",
          maxInstances: 1,
        }),
        expect.objectContaining({
          environment: "bn118",
          applicationName:
            "stella-v2-cloud-builder-basic-nightingale-118-sandboxsmall-bn118",
          size: "small",
          maxInstances: 6,
        }),
      ]),
    );
  });

  test("does not remove comma-brace text inside a JSONC string", () => {
    expect(parseJsonc('{"value": ",} and ,]",}')).toEqual({
      value: ",} and ,]",
    });
  });

  test("accepts current array and explicitly paginated instance output", () => {
    const array = readJson("instances.json") as Record<string, unknown>;
    const records = array["a0308ae0-ef75-4f05-960c-033c72d0b2ce"];
    expect(parseWranglerInstancesPage(records)).toMatchObject({
      instances: { length: 3 },
      nextPageToken: null,
    });
    expect(
      parseWranglerInstancesPage({
        instances: records,
        result_info: { next_page_token: "next-page" },
      }).nextPageToken,
    ).toBe("next-page");
  });

  test("does not retain the application image URL", () => {
    const applications = parseWranglerApplications(
      readJson("applications.json"),
    );
    expect(applications).toHaveLength(4);
    expect(JSON.stringify(applications)).not.toContain(
      "registry.example.invalid",
    );
    expect(applications[0]).not.toHaveProperty("image");
  });

  test("classifies only workloads provable from class or logical name", () => {
    expect(inferWorkload("AppBuildSandbox", "opaque")).toEqual({
      classification: "app-build",
      candidates: ["app-build"],
    });
    expect(inferWorkload("SandboxSmall", "agent-a")).toEqual({
      classification: "agent-or-resident-attachment",
      candidates: ["agent", "resident-attachment"],
    });
    expect(inferWorkload("Sandbox", "other")).toEqual({
      classification: "unknown",
      candidates: [],
    });
  });

  test("reports exactly three stale live acceptance instances without asserting ownership", () => {
    const report = buildInventoryReport({
      ...inputs(),
      durableTargets: null,
      nowMs: Date.parse("2026-08-30T12:00:00Z"),
      staleHours: 24,
    });
    expect(report.mutation).toBe("none");
    expect(report.totals).toEqual({
      configuredApplications: 6,
      deployedApplications: 4,
      liveInstances: 3,
      staleLiveInstances: 3,
      inactiveRecords: 2,
    });
    expect(report.reconciliation).toMatchObject({
      authority: "unavailable",
      orphan: [],
      unverifiedLive: { length: 3 },
    });
    const bn118AppBuild = report.configuredApplications.find(
      (entry) =>
        entry.environment === "bn118" && entry.className === "AppBuildSandbox",
    );
    expect(bn118AppBuild?.deployed).toBe(false);
    expect(bn118AppBuild?.capacity).toEqual({
      instanceType: "standard-4",
      maxInstances: 1,
      liveInstances: 0,
      headroom: 1,
      state: "not-deployed",
      configurationDrift: null,
    });
    const bn118Small = report.configuredApplications.find(
      (entry) =>
        entry.environment === "bn118" && entry.className === "SandboxSmall",
    );
    expect(bn118Small?.capacity).toEqual({
      instanceType: "standard-2",
      maxInstances: 6,
      liveInstances: 2,
      headroom: 4,
      state: "available",
      configurationDrift: false,
    });
    const live = report.configuredApplications.flatMap((entry) => entry.live);
    expect(live.map((entry) => entry.ageBand)).toEqual([
      "stale",
      "stale",
      "stale",
    ]);
    expect(JSON.stringify(report)).not.toContain("location");
    expect(JSON.stringify(report)).not.toContain("registry.example.invalid");
  });

  test("reconciles only against an explicit durable export", () => {
    const durableTargets = parseDurableInventory(
      readJson("durable-inventory.json"),
    );
    const report = buildInventoryReport({
      ...inputs(),
      durableTargets,
      nowMs: Date.parse("2026-08-30T12:00:00Z"),
      staleHours: 24,
    });
    expect(report.reconciliation).toMatchObject({
      authority: "explicit-export",
      ownedLive: [
        "17edee7b3307a3ec7e611948a303852239574edbbb19517bbdad2de189e819c9",
      ],
      retiringLive: [
        "63e318dc8089fd42cb9a3068fa1509b22e1e74dc42676460a8e1e7333581f450",
      ],
      orphan: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      missing: [expect.objectContaining({ sandboxId: "agent-missing" })],
    });
  });
});

describe("sandbox cleanup safety gate", () => {
  const report = () =>
    buildInventoryReport({
      ...inputs(),
      durableTargets: null,
      nowMs: Date.parse("2026-08-30T12:00:00Z"),
      staleHours: 24,
    });
  const instanceId =
    "17edee7b3307a3ec7e611948a303852239574edbbb19517bbdad2de189e819c9";

  test("builds a dry-run plan only for explicit, live, exact IDs", () => {
    const plan = planExactCleanup({
      report: report(),
      environment: "bn118",
      instanceIds: [instanceId],
    });
    expect(plan).toMatchObject({
      environment: "bn118",
      mutation: "dry-run",
      selected: [
        expect.objectContaining({
          instanceId,
          name: "agent-8cf8109a-ec39-4213-907c-080cfea3c7c0",
        }),
      ],
      confirmation: cleanupConfirmation("bn118", [instanceId]),
    });
    expect(plan.warning).toContain("never permitted");
  });

  test("rejects unknown, cross-environment, and duplicate selections", () => {
    expect(() =>
      planExactCleanup({
        report: report(),
        environment: "dev",
        instanceIds: [instanceId],
      }),
    ).toThrow("not exactly one live dev instance");
    expect(() =>
      planExactCleanup({
        report: report(),
        environment: "bn118",
        instanceIds: [instanceId, instanceId],
      }),
    ).toThrow("must be unique");
    expect(() =>
      planExactCleanup({
        report: report(),
        environment: "bn118",
        instanceIds: ["agent-name-is-not-an-instance-id"],
      }),
    ).toThrow("64-character hex IDs");
  });

  test("keeps apply separately gated by exact confirmation and an adapter", () => {
    expect(
      authorizeCleanupApply({
        apply: false,
        environment: "bn118",
        instanceIds: [instanceId],
        confirmation: null,
        adapter: null,
      }),
    ).toEqual({ authorized: false, adapter: null });
    expect(() =>
      authorizeCleanupApply({
        apply: true,
        environment: "bn118",
        instanceIds: [instanceId],
        confirmation: "RETIRE:wrong",
        adapter: "/operator/adapter",
      }),
    ).toThrow("Refusing mutation");
    expect(() =>
      authorizeCleanupApply({
        apply: true,
        environment: "bn118",
        instanceIds: [instanceId],
        confirmation: cleanupConfirmation("bn118", [instanceId]),
        adapter: null,
      }),
    ).toThrow("--adapter is required");
    expect(
      authorizeCleanupApply({
        apply: true,
        environment: "bn118",
        instanceIds: [instanceId],
        confirmation: cleanupConfirmation("bn118", [instanceId]),
        adapter: "/operator/adapter",
      }),
    ).toEqual({ authorized: true, adapter: "/operator/adapter" });
  });

  test("re-verifies the exact ID, logical name, and live state before an adapter", () => {
    const selected = planExactCleanup({
      report: report(),
      environment: "bn118",
      instanceIds: [instanceId],
    }).selected[0];
    expect(() =>
      assertExactInstanceStillLive(
        {
          findExactInstance: () => [
            {
              id: instanceId,
              name: selected.name,
              state: "running",
              version: 23,
              created: selected.created,
            },
          ],
        },
        selected,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactInstanceStillLive(
        {
          findExactInstance: () => [
            {
              id: instanceId,
              name: "reassigned-name",
              state: "running",
              version: 23,
              created: selected.created,
            },
          ],
        },
        selected,
      ),
    ).toThrow("changed after the cleanup plan");
  });

  test("Wrangler reader paginates with argument arrays and never a shell", () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const execFile = (executable: string, args: string[]) => {
      calls.push({ executable, args });
      if (args[1] === "list")
        return JSON.stringify(readJson("applications.json"));
      if (!args.includes("--page-token")) {
        return JSON.stringify({
          instances: [],
          result_info: { next_page_token: "page-2" },
        });
      }
      return JSON.stringify({
        instances: [],
        result_info: { next_page_token: null },
      });
    };
    const reader = createWranglerReader({
      wranglerPath: "/exact/wrangler",
      cwd: "/exact/cwd",
      execFile: execFile as never,
    });
    expect(reader.listApplications()).toHaveLength(4);
    expect(
      reader.listInstances("a0308ae0-ef75-4f05-960c-033c72d0b2ce"),
    ).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        executable: "/exact/wrangler",
        args: ["containers", "list", "--json", "--per-page", "100"],
      }),
      expect.objectContaining({
        args: expect.arrayContaining(["--per-page", "100"]),
      }),
      expect.objectContaining({
        args: expect.arrayContaining(["--page-token", "page-2"]),
      }),
    ]);
  });
});
