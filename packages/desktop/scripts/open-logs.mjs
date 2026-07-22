#!/usr/bin/env node
// Resolve, print, and (by default) open the local Stella diagnostics log
// directory for this checkout. Pass --print to only print the path.
//
// Logs live under the selected Stella home's Electron userData root, where
// rootHash mirrors
// runtime/worker/runtime-paths.ts (sha256 of the resolved stellaAppDir,
// first 16 hex chars). Keep this in sync with that file.

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveDevElectronUserDataDir } from './lib/dev-home-paths.mjs'

const stellaAppDir = path.resolve(process.cwd())
const rootHash = crypto
  .createHash('sha256')
  .update(stellaAppDir)
  .digest('hex')
  .slice(0, 16)
const logDir = path.join(resolveDevElectronUserDataDir(), 'logs', rootHash)

console.log(logDir)

if (!existsSync(logDir)) {
  console.log('(no logs yet — directory will be created on next run)')
  process.exit(0)
}

const files = readdirSync(logDir)
  .filter((name) => /\.(txt|log)$/.test(name))
  .sort()
for (const name of files) {
  const { size } = statSync(path.join(logDir, name))
  console.log(`  ${name}  ${(size / 1024).toFixed(1)} KB`)
}

if (process.argv.includes('--print')) process.exit(0)

const opener =
  process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer'
      : 'xdg-open'
spawn(opener, [logDir], { stdio: 'ignore', detached: true }).unref()
