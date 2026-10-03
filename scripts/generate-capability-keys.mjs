#!/usr/bin/env bun
/**
 * Generates an ES256 capability signing key pair for cloud-builder.
 *
 *   bun scripts/generate-capability-keys.mjs builder-1
 *
 * Prints the PKCS8 private key (set as the cloud-builder secret
 * CAPABILITY_SIGNING_KEY) and the public JWK entry to append to the model
 * gateway's CAPABILITY_JWKS var.
 */
import { generateCapabilityKeyPair } from "../packages/contracts/gateway/jwt.ts";

const kid = process.argv[2];
if (!kid || !/^[a-z0-9-]{3,64}$/.test(kid)) {
  console.error("usage: generate-capability-keys.mjs <kid>  (e.g. builder-1)");
  process.exit(2);
}
if (!kid.startsWith("builder")) {
  console.error("kid must start with `builder`.");
  process.exit(2);
}
const issuer = "stella-cloud-builder";

const pair = await generateCapabilityKeyPair();
console.log(`# CAPABILITY_SIGNING_KID=${kid}`);
console.log("# CAPABILITY_SIGNING_KEY (PKCS8 PEM, keep secret):");
console.log(pair.privateKeyPem);
console.log("# CAPABILITY_JWKS entry (public):");
console.log(JSON.stringify({ kid, issuer, jwk: pair.publicJwk }));
