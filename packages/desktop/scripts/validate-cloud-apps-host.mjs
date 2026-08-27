#!/usr/bin/env node

const DEVELOPMENT_APPS_HOST =
  "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";

const allowedArguments = new Set(["--allow-development-host"]);
const unknownArgument = process.argv
  .slice(2)
  .find((arg) => !allowedArguments.has(arg));
if (unknownArgument) {
  throw new Error(`Unknown argument: ${unknownArgument}`);
}

const allowDevelopmentHost = process.argv.includes("--allow-development-host");
const configuredHost = process.env.VITE_STELLA_APPS_HOST?.trim();

if (!configuredHost) {
  throw new Error(
    "VITE_STELLA_APPS_HOST must be configured before building a connected desktop package.",
  );
}

let parsed;
try {
  parsed = new URL(configuredHost);
} catch {
  throw new Error("VITE_STELLA_APPS_HOST must be a valid HTTPS origin.");
}

if (
  parsed.protocol !== "https:" ||
  parsed.username ||
  parsed.password ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash
) {
  throw new Error("VITE_STELLA_APPS_HOST must be a valid HTTPS origin.");
}

if (parsed.origin === DEVELOPMENT_APPS_HOST && !allowDevelopmentHost) {
  throw new Error(
    "The development Apps host cannot be embedded in a production desktop package.",
  );
}

console.log(`Validated Stella Apps host: ${parsed.origin}`);
