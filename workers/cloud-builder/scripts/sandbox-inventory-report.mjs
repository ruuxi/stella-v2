#!/usr/bin/env node

import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STALE_HOURS,
  collectInventoryReport,
  parseArguments,
} from "./sandbox-inventory-lib.mjs";

const args = parseArguments(process.argv.slice(2));
if (args.flag("help")) {
  process.stdout.write(
    `Usage: node scripts/sandbox-inventory-report.mjs [options]\n\n`,
  );
  process.stdout.write(
    `  --config <wrangler.jsonc>          Configured dev/bn118 topology\n`,
  );
  process.stdout.write(
    `  --durable-inventory <export.json>  Optional explicit DO ownership export\n`,
  );
  process.stdout.write(
    `  --stale-hours <hours>              Default: ${DEFAULT_STALE_HOURS}\n`,
  );
  process.stdout.write(
    `\nRead-only: this command never destroys, deploys, or writes cloud state.\n`,
  );
  process.stdout.write(
    `Durable export: {"schemaVersion":1,"environment":"dev|bn118","targets":[{"sandboxId":"...","size":"small|large","workload":"app-build|world","lifecycle":"owned|retiring"}]}\n`,
  );
  process.exit(0);
}

const staleHours = Number(args.one("stale-hours", String(DEFAULT_STALE_HOURS)));
const report = collectInventoryReport({
  configPath: args.one("config", DEFAULT_CONFIG_PATH),
  durableInventoryPath: args.one("durable-inventory"),
  staleHours,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
