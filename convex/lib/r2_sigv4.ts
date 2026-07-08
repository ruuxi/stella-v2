"use node";

/**
 * Shared AWS SigV4 signer for Cloudflare R2 object writes/deletes.
 *
 * The backend signs its own R2 requests (rather than proxying bytes through a
 * component) so `"use node"` actions can PUT/DELETE objects directly with the
 * `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` credentials.
 *
 * This module was lifted out of the copy-pasted `signR2Put` / `uploadR2Object`
 * helpers in `data/user_pet_uploads.ts`, `data/emoji_pack_uploads.ts`,
 * `data/emoji_pack_generation.ts`, and `data/user_pet_generation.ts` so there
 * is a single implementation to reason about. It is intentionally
 * behavior-preserving for those callers (same canonical request, same signed
 * headers) and additionally supports custom object metadata (`x-amz-meta-*`)
 * and object deletes for the canvas-share feature.
 */

import { createHash, createHmac } from "node:crypto";

export type R2Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
};

/** SHA-256 hex digest of the empty body, used for signed DELETEs (no payload). */
const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

type SignRequestArgs = {
  method: "PUT" | "DELETE";
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  key: string;
  payloadHash: string;
  contentType?: string;
  cacheControl?: string;
  /** Custom object metadata. Keys are emitted as `x-amz-meta-<key>` headers. */
  metadata?: Record<string, string>;
};

const signR2Request = (
  args: SignRequestArgs,
): { url: string; headers: Record<string, string> } => {
  const url = new URL(
    `${args.endpoint.replace(/\/+$/, "")}/${args.bucket}/${args.key}`,
  );
  const region = "auto";
  const service = "s3";
  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const headersToSign: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
  };
  if (args.contentType !== undefined) {
    headersToSign["content-type"] = args.contentType;
  }
  if (args.cacheControl !== undefined) {
    headersToSign["cache-control"] = args.cacheControl;
  }
  if (args.metadata) {
    for (const [metaKey, metaValue] of Object.entries(args.metadata)) {
      headersToSign[`x-amz-meta-${metaKey.toLowerCase()}`] = metaValue;
    }
  }
  const signedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    signedHeaderKeys
      .map((key) => `${key}:${headersToSign[key]!.trim()}`)
      .join("\n") + "\n";
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = [
    args.method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    url: url.toString(),
    headers: {
      ...headersToSign,
      authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

/**
 * Produce a signed PUT URL + headers for an R2 object. Callers either hand the
 * result back to a client for a direct upload or fetch it themselves.
 */
export const signR2Put = (args: {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  key: string;
  payloadHash: string;
  contentType: string;
  cacheControl: string;
  metadata?: Record<string, string>;
}): { putUrl: string; headers: Record<string, string> } => {
  const signed = signR2Request({ method: "PUT", ...args });
  return { putUrl: signed.url, headers: signed.headers };
};

/** Sign and PUT a payload to R2 from the backend. Throws on non-2xx. */
export const uploadR2Object = async (args: {
  key: string;
  bytes: Buffer;
  contentType: string;
  cacheControl: string;
  metadata?: Record<string, string>;
  r2: R2Credentials;
}): Promise<void> => {
  const signed = signR2Put({
    accessKeyId: args.r2.accessKeyId,
    secretAccessKey: args.r2.secretAccessKey,
    endpoint: args.r2.endpoint,
    bucket: args.r2.bucket,
    key: args.key,
    payloadHash: sha256Hex(args.bytes),
    contentType: args.contentType,
    cacheControl: args.cacheControl,
    metadata: args.metadata,
  });
  const response = await fetch(signed.putUrl, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(args.bytes),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `R2 upload failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }
};

/**
 * Sign and DELETE an R2 object from the backend. A 404 is treated as success
 * (the object is already gone), so callers can use this idempotently.
 */
export const deleteR2Object = async (args: {
  key: string;
  r2: R2Credentials;
}): Promise<void> => {
  const signed = signR2Request({
    method: "DELETE",
    accessKeyId: args.r2.accessKeyId,
    secretAccessKey: args.r2.secretAccessKey,
    endpoint: args.r2.endpoint,
    bucket: args.r2.bucket,
    key: args.key,
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });
  const response = await fetch(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  });
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `R2 delete failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }
};
