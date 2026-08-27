#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';

const __dirname = import.meta.dirname;
const rootDir = join(__dirname, '..');

const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const packageVersion = packageJson.version;

const cargoToml = readFileSync(join(rootDir, 'cli/Cargo.toml'), 'utf-8');
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]*)"/m);

if (!cargoVersionMatch) {
  console.error('Could not find version in cli/Cargo.toml');
  process.exit(1);
}

const cargoVersion = cargoVersionMatch[1];

if (packageVersion !== cargoVersion) {
  console.error('Version mismatch detected!');
  console.error(`  package.json:    ${packageVersion}`);
  console.error(`  cli/Cargo.toml:  ${cargoVersion}`);
  console.error('');
  console.error("Run 'pnpm run version:sync' to fix this.");
  process.exit(1);
}

console.log(`Versions are in sync: ${packageVersion}`);
