import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { runAppsHostWorkerdAcceptance } from "../scripts/workerd-runtime-acceptance.mjs";

describe("production bundle in workerd", () => {
  test("serves real local KV/R2 state and fails closed before removing its state", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stella-apps-host-workerd-test-"),
    );
    try {
      const result = await runAppsHostWorkerdAcceptance({
        stateDirectory: path.join(root, "apps-host-workerd"),
        runId: "00000000-0000-4000-8000-000000000001",
      });
      expect(result.observations).toMatchObject({
        workerName: "stella-v2-apps-host-dev",
        deploymentIdentity: "dev:impartial-crab-34",
        runtimeEngine: "workerd",
        wranglerVersion: "4.113.0",
        healthStatus: 200,
        appAssetStatus: 200,
        appHeadStatus: 200,
        interiorManifestStatus: 200,
        interiorAssetStatus: 200,
        interiorBundleStatus: 200,
        authHandoffStatus: 200,
        blockedProxyStatus: 400,
        invalidConfigStatus: 503,
        productionBundleBuilt: true,
        workerdRuntimeStarted: true,
        realKvBindingUsed: true,
        realR2BindingUsed: true,
        sameOriginInteriorManifest: true,
        strictHostedContentSecurityPolicy: true,
        authHandoffNoStore: true,
        privateProxyTargetBlockedBeforeFetch: true,
        invalidConfigurationFailedClosed: true,
        runtimeDisposed: true,
        isolatedStateRemoved: true,
      });
      expect(result.observations.bundleBytes).toBeGreaterThan(0);
      for (const field of [
        "bundleSha256",
        "routeSetSha256",
        "appAssetSha256",
        "interiorManifestSha256",
        "interiorAssetsSha256",
        "authHandoffSha256",
        "blockedProxyResponseSha256",
        "receiptChainSha256",
      ]) {
        expect(result.observations[field]).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect(result.receipts.length).toBeGreaterThanOrEqual(12);
      expect(
        result.receipts.every(
          (entry) =>
            entry.surface === "apps-host-workerd" &&
            entry.mocked === false &&
            entry.synthetic === false,
        ),
      ).toBeTrue();
      expect(result.receipts.map((entry) => entry.operation)).toEqual(
        expect.arrayContaining([
          "apps-host.bundle.production",
          "apps-host.binding.kv.seed",
          "apps-host.binding.r2.seed",
          "apps-host.workerd.start",
          "apps-host.http.app-asset",
          "apps-host.http.interior-manifest",
          "apps-host.http.auth-handoff",
          "apps-host.http.proxy-private-target",
          "apps-host.workerd.invalid-config",
          "apps-host.workerd.cleanup",
        ]),
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
