#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { platform, arch } from 'os';

const __dirname = import.meta.dirname;
const projectRoot = join(__dirname, '..');

const sourceExt = platform() === 'win32' ? '.exe' : '';
const sourcePath = join(projectRoot, `cli/target/release/stella-browser${sourceExt}`);
const binDir = join(projectRoot, 'bin');

const platformKey = `${platform()}-${arch()}`;
const ext = platform() === 'win32' ? '.exe' : '';
const targetName = `stella-browser-${platformKey}${ext}`;
const targetPath = join(binDir, targetName);

if (!existsSync(sourcePath)) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error('Run "cargo build --release --manifest-path cli/Cargo.toml" first');
  process.exit(1);
}

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

const tempPath = join(binDir, `.${targetName}.${process.pid}.tmp`);

try {

  copyFileSync(sourcePath, tempPath);

  if (platform() !== 'win32') {
    chmodSync(tempPath, 0o755);
  }
  if (platform() === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', tempPath], {
      stdio: 'ignore',
    });
  }

  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (platform() === 'win32' && existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
      renameSync(tempPath, targetPath);
    } else {
      throw error;
    }
  }
} catch (error) {
  if (existsSync(tempPath)) {
    rmSync(tempPath, { force: true });
  }
  console.error(`Error: Failed to copy native binary to ${targetPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`✓ Copied native binary to ${targetPath}`);
