#!/usr/bin/env bun
/**
 * Generates an ES256 capability signing key pair for one issuer.
 *
 *   bun scripts/generate-capability-keys.mjs convex-1
 *   bun scripts/generate-capability-keys.mjs builder-1
 *
 * Prints the PKCS8 private key (set as CAPABILITY_SIGNING_KEY on the issuer:
 * Convex env for `convex-*`, cloud-builder secret for `builder-*`) and the
 * public JWK entry to append to the model gateway's CAPABILITY_JWKS var.
 */
import { generateCapabilityKeyPair } from "../packages/contracts/gateway/jwt.ts";

const kid = process.argv[2];
if (!kid || !/^[a-z0-9-]{3,64}$/.test(kid)) {
  console.error("usage: generate-capability-keys.mjs <kid>  (e.g. convex-1, builder-1)");
  process.exit(2);
}
const issuer = kid.startsWith("convex")
  ? "stella-convex"
  : kid.startsWith("builder")
    ? "stella-cloud-builder"
    : null;
if (!issuer) {
  console.error("kid must start with `convex` or `builder` so the issuer is unambiguous.");
  process.exit(2);
}

const pair = await generateCapabilityKeyPair();
console.log(`# CAPABILITY_SIGNING_KID=${kid}`);
console.log("# CAPABILITY_SIGNING_KEY (PKCS8 PEM, keep secret):");
console.log(pair.privateKeyPem);
console.log("# CAPABILITY_JWKS entry (public):");
console.log(JSON.stringify({ kid, issuer, jwk: pair.publicJwk }));
