/// <reference types="vite/client" />

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const convexRoot = fileURLToPath(new URL(".", import.meta.url));

const productionTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "_generated" ? [] : productionTypeScriptFiles(path);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".convex.test.ts")
    ) {
      return [];
    }
    return [path];
  });

describe("managed billing alternate-writer inventory", () => {
  it("has no production post-response or scheduled generic metering bypass", () => {
    const allowedBillingImplementations = new Set([
      `${convexRoot}/billing.ts`,
      `${convexRoot}/lib/managed_billing.ts`,
    ]);
    const forbiddenCall =
      /\b(?:meterManagedUsage|recordManagedUsage|scheduleManagedUsage|persistManagedUsage)\s*\(|internal\.billing\.logManagedUsage\b|internal\.agent\.hooks\.(?:logUsage|logProxyUsage)\b/u;
    const violations = productionTypeScriptFiles(convexRoot)
      .filter((path) => !allowedBillingImplementations.has(path))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return forbiddenCall.test(source)
          ? [path.slice(convexRoot.length + 1)]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it("keeps hook and gate modules incapable of charging provider usage", () => {
    const hookSource = readFileSync(`${convexRoot}/agent/hooks.ts`, "utf8");
    const gateSource = readFileSync(
      `${convexRoot}/lib/gate_and_meter.ts`,
      "utf8",
    );

    expect(hookSource).not.toMatch(
      /\b(?:afterChat|logUsage|logProxyUsage|persistManagedUsage)\b/u,
    );
    expect(gateSource).not.toMatch(
      /\b(?:meterManagedUsage|scheduleManagedUsage)\b/u,
    );
    expect(hookSource).toContain("export async function afterToolExecution");
    expect(hookSource).toContain("export const logToolExecution");
  });
});
