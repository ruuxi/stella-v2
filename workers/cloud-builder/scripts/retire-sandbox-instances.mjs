#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  authorizeCleanupApply,
  assertExactInstanceStillLive,
  collectInventoryReport,
  createWranglerReader,
  parseArguments,
  planExactCleanup,
} from "./sandbox-inventory-lib.mjs";

const args = parseArguments(process.argv.slice(2));
if (args.flag("help")) {
  process.stdout.write(
    `Usage: node scripts/retire-sandbox-instances.mjs [options]\n\n`,
  );
  process.stdout.write(
    `  --environment <dev|bn118>   Required deployment scope\n`,
  );
  process.stdout.write(
    `  --instance-id <exact-id>    Required; repeat for each exact instance\n`,
  );
  process.stdout.write(
    `  --durable-inventory <file>  Optional ownership export for the report\n`,
  );
  process.stdout.write(
    `  --apply                     Opt in to mutation; omitted is dry-run\n`,
  );
  process.stdout.write(
    `  --confirm <exact-string>    Printed by dry-run; required with --apply\n`,
  );
  process.stdout.write(
    `  --adapter <executable>      Required with --apply\n\n`,
  );
  process.stdout.write(
    `The adapter receives one JSON argument per exact instance. It must call the deployed Worker's supported logical Sandbox destroy path. Wrangler cannot delete one instance; this command never calls 'wrangler containers delete'.\n`,
  );
  process.exit(0);
}

const environment = args.one("environment");
const instanceIds = args.many("instance-id");
const wranglerReader = createWranglerReader();
const report = collectInventoryReport({
  configPath: args.one("config", DEFAULT_CONFIG_PATH),
  durableInventoryPath: args.one("durable-inventory"),
  wranglerReader,
});
const plan = planExactCleanup({ report, environment, instanceIds });

const authorization = authorizeCleanupApply({
  apply: args.flag("apply"),
  environment,
  instanceIds,
  confirmation: args.one("confirm"),
  adapter: args.one("adapter"),
});
if (!authorization.authorized) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
const adapterPath = path.resolve(authorization.adapter);
for (const selected of plan.selected) {
  assertExactInstanceStillLive(wranglerReader, selected);
  execFileSync(
    adapterPath,
    [
      JSON.stringify({
        schemaVersion: 1,
        environment: selected.environment,
        applicationId: selected.applicationId,
        instanceId: selected.instanceId,
        sandboxId: selected.name,
        size: selected.size,
        workload: selected.workload,
        workloadCandidates: selected.workloadCandidates,
      }),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
}
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    environment,
    mutation: "adapter-invoked",
    exactInstanceIds: [...instanceIds].sort(),
  })}\n`,
);
