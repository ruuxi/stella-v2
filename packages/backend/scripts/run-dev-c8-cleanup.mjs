#!/usr/bin/env node

import {
  createConvexRunner,
  parseArgs,
  runDriver,
} from "./c8-cleanup-driver-lib.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = runDriver({
    options,
    runner: createConvexRunner({ cwd: process.cwd() }),
  });
  process.stdout.write(
    `${JSON.stringify({
      mode: result.mode,
      receiptPath: result.receiptPath,
      publicManifestDigest: result.publicManifestDigest,
      ...(result.zeroAudit ? { zeroAudit: true } : {}),
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
