/**
 * AWS SigV4 for the drive's R2 bucket over its S3 API, on WebCrypto. A port
 * of `packages/backend/convex/lib/r2_sigv4.ts` (same canonical path encoding,
 * same header signing) plus query-string presigning, so clients PUT and GET
 * drive bytes straight to R2 and the Worker never carries them.
 *
 * The R2 binding (`env.DRIVE`) does everything else: HEAD, DELETE, LIST and
 * the inline writes of agent output. Only what must work without the binding
 * is signed here: client URLs and the server-side copy that moves an upload
 * out of its client-writable staging key.
 */

export type R2Signer = {
  accessKeyId: string;
  secretAccessKey: string;
  /** S3 API origin, `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
};

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** SHA-256 of the empty body, for signed requests that carry none. */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** SigV4 refuses presigned lifetimes past seven days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const REGION = "auto";
const SERVICE = "s3";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sha256Hex = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmac = async (
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", imported, encoder.encode(data));
};

/** RFC 3986 encoding, as SigV4 canonicalization wants it. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const unsafeR2PathProjection = (value: string): string => {
  let projection = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    const decoded = projection.replace(
      /%(25|2e|2f|5c)/giu,
      (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 16)),
    );
    if (decoded === projection) return projection;
    projection = decoded;
  }
  return projection;
};

const encodeR2PathSegment = (value: string, label: string): string => {
  const unsafeProjection = unsafeR2PathProjection(value);
  if (
    !value ||
    unsafeProjection === "." ||
    unsafeProjection === ".." ||
    unsafeProjection.includes("/") ||
    unsafeProjection.includes("\\")
  ) {
    throw new Error(`R2 ${label} contains an unsafe path segment.`);
  }
  try {
    // A literal percent is data, not an escape: it encodes to `%25`.
    return encodeRfc3986(value);
  } catch {
    throw new Error(`R2 ${label} is not valid Unicode.`);
  }
};

/** `https://<endpoint>/<bucket>/<key>`, every segment encoded exactly once. */
export const r2ObjectUrl = (
  signer: Pick<R2Signer, "endpoint" | "bucket">,
  key: string,
): URL => {
  let endpoint: URL;
  try {
    endpoint = new URL(signer.endpoint);
  } catch {
    throw new Error("R2 endpoint is not a valid URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("R2 endpoint must be an exact HTTPS origin.");
  }
  const encodedBucket = encodeR2PathSegment(signer.bucket, "bucket");
  const encodedKey = key
    .split("/")
    .map((segment) => encodeR2PathSegment(segment, "key"))
    .join("/");
  const expectedPathname = `/${encodedBucket}/${encodedKey}`;
  const url = new URL(endpoint.origin);
  url.pathname = expectedPathname;
  if (
    url.origin !== endpoint.origin ||
    url.pathname !== expectedPathname ||
    url.search ||
    url.hash
  ) {
    throw new Error("R2 object path did not survive canonical construction.");
  }
  return url;
};

const amzDateOf = (now: number): string =>
  new Date(now)
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");

const signingKey = async (
  secretAccessKey: string,
  dateStamp: string,
): Promise<ArrayBuffer> => {
  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return await hmac(kService, "aws4_request");
};

const signature = async (
  signer: R2Signer,
  amzDate: string,
  canonicalRequest: string,
): Promise<{ scope: string; signature: string }> => {
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  return {
    scope,
    signature: hex(
      await hmac(await signingKey(signer.secretAccessKey, dateStamp), stringToSign),
    ),
  };
};

/**
 * A request signed in its headers, for the Worker's own S3 calls. `headers`
 * are signed alongside host, date and payload hash (lower-cased names).
 */
export const signR2Request = async (
  signer: R2Signer,
  args: {
    method: "PUT" | "DELETE" | "GET" | "HEAD";
    key: string;
    payloadHash: string;
    headers?: Record<string, string>;
    now?: number;
  },
): Promise<{ url: string; headers: Record<string, string> }> => {
  const url = r2ObjectUrl(signer, args.key);
  const amzDate = amzDateOf(args.now ?? Date.now());
  const signed: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    signed[name.toLowerCase()] = value;
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders =
    names.map((name) => `${name}:${signed[name]!.trim()}`).join("\n") + "\n";
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    args.method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  const result = await signature(signer, amzDate, canonicalRequest);
  return {
    url: url.toString(),
    headers: {
      ...signed,
      authorization: `AWS4-HMAC-SHA256 Credential=${signer.accessKeyId}/${result.scope}, SignedHeaders=${signedHeaders}, Signature=${result.signature}`,
    },
  };
};

/**
 * A URL that carries its own authority: anyone holding it may `method` this
 * one object until it expires. Only `host` is signed, so the caller may send
 * any content type, and the body is unsigned.
 */
export const presignR2Url = async (
  signer: R2Signer,
  args: {
    method: "GET" | "PUT";
    key: string;
    expiresInSeconds: number;
    now?: number;
  },
): Promise<string> => {
  if (
    !Number.isSafeInteger(args.expiresInSeconds) ||
    args.expiresInSeconds < 1 ||
    args.expiresInSeconds > MAX_PRESIGN_SECONDS
  ) {
    throw new Error("Presigned R2 URL lifetime is out of range.");
  }
  const url = r2ObjectUrl(signer, args.key);
  const amzDate = amzDateOf(args.now ?? Date.now());
  const scope = `${amzDate.slice(0, 8)}/${REGION}/${SERVICE}/aws4_request`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", UNSIGNED_PAYLOAD],
    ["X-Amz-Credential", `${signer.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(args.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    args.method,
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const result = await signature(signer, amzDate, canonicalRequest);
  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${result.signature}`;
};

/** The drive's signer, or null when this deployment has no R2 S3 credentials. */
export const driveSigner = (
  env: Pick<
    Cloudflare.Env,
    "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_S3_ENDPOINT" | "R2_DRIVE_BUCKET"
  >,
): R2Signer | null => {
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = env.R2_S3_ENDPOINT?.trim();
  const bucket = env.R2_DRIVE_BUCKET?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;
  if (endpoint.includes("PENDING_")) return null;
  return { accessKeyId, secretAccessKey, endpoint, bucket };
};

/**
 * Server-side copy inside the drive bucket (S3 CopyObject), so a finalized
 * upload's bytes leave the staging key its presigned PUT can still write.
 * Throws unless storage confirms the copy.
 */
export const copyR2Object = async (
  signer: R2Signer,
  args: { from: string; to: string; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<void> => {
  const source = r2ObjectUrl(signer, args.from).pathname;
  const signed = await signR2Request(signer, {
    method: "PUT",
    key: args.to,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    headers: {
      "x-amz-copy-source": source,
      "x-amz-metadata-directive": "COPY",
    },
  });
  const response = await (args.fetchImpl ?? fetch)(signed.url, {
    method: "PUT",
    headers: signed.headers,
    signal: args.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text().catch(() => "");
  // S3 can answer a copy 200 and still report a failure in the body.
  if (!response.ok || !text.includes("CopyObjectResult")) {
    throw new Error(`R2 copy failed (${response.status}).`);
  }
};
