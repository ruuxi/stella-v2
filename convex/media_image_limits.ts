import { isRecord } from "./shared_validators";

/** Desktop and gateway must mirror these managed image_gen wire limits. */
export const MAX_MANAGED_IMAGE_REFERENCE_ITEMS = 4;
export const MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES = 1024 * 1024;
export const MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_MANAGED_IMAGE_REFERENCE_SERIALIZED_CHARS =
  Math.ceil(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 3) * 4 +
  MAX_MANAGED_IMAGE_REFERENCE_ITEMS * 64;
export const MAX_MANAGED_IMAGE_REMOTE_URL_CHARS = 8 * 1024;
export const MAX_MANAGED_IMAGE_REQUEST_BYTES = 3 * 1024 * 1024;
export const MAX_DURABLE_IMAGE_SUBMISSION_PLAINTEXT_BYTES =
  MAX_MANAGED_IMAGE_REQUEST_BYTES + 16 * 1024;

export const PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS = 96 * 1024;
export const MAX_PRIVATE_MEDIA_PAYLOAD_CHARS = (9 * 1024 * 1024) / 2;

const CONVEX_ACTION_MEMORY_BYTES = 64 * 1024 * 1024;
const DISPATCH_FIXED_HEADROOM_BYTES = 8 * 1024 * 1024;

/**
 * Conservative dispatcher peak: two UTF-16 encrypted representations
 * (chunk set/join and parsed envelope), three UTF-16 plaintext/provider-body
 * representations, ciphertext+plaintext byte buffers, and 8 MiB runtime
 * headroom. Keeping this below Convex's 64 MiB action limit is a release gate.
 */
export const MAX_MANAGED_IMAGE_DISPATCH_ESTIMATED_PEAK_BYTES =
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS * 2 * 2 +
  MAX_DURABLE_IMAGE_SUBMISSION_PLAINTEXT_BYTES * 3 * 2 +
  MAX_DURABLE_IMAGE_SUBMISSION_PLAINTEXT_BYTES * 2 +
  DISPATCH_FIXED_HEADROOM_BYTES;

if (
  MAX_MANAGED_IMAGE_DISPATCH_ESTIMATED_PEAK_BYTES >= CONVEX_ACTION_MEMORY_BYTES
) {
  throw new Error("Managed image dispatcher envelope exceeds 64 MiB.");
}

const supportedManagedImageMime = (value: string): boolean =>
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    value.toLowerCase(),
  );

const decodedBase64Length = (value: string, start: number): number | null => {
  const length = value.length - start;
  if (length < 4 || length % 4 !== 0) return null;
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 61) padding += 1;
  if (value.charCodeAt(value.length - 2) === 61) padding += 1;
  for (let index = start; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return null;
    }
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return Math.floor((length * 3) / 4) - padding;
};

const isHttpReference = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

export const validateManagedImageReferenceEnvelope = (
  capabilityId: string,
  input: Record<string, unknown>,
): string | null => {
  if (!["text_to_image", "image_edit", "icon"].includes(capabilityId)) {
    return null;
  }
  const rawReferences = input.image_urls;
  if (rawReferences === undefined) return null;
  if (!Array.isArray(rawReferences)) return "input.image_urls must be an array";
  if (rawReferences.length > MAX_MANAGED_IMAGE_REFERENCE_ITEMS) {
    return `input.image_urls accepts at most ${MAX_MANAGED_IMAGE_REFERENCE_ITEMS} references`;
  }
  let decodedTotal = 0;
  let serializedTotal = 0;
  for (const [index, reference] of rawReferences.entries()) {
    if (typeof reference !== "string" || reference.length === 0) {
      return `input.image_urls[${index}] must be a non-empty URL`;
    }
    if (isHttpReference(reference)) {
      if (reference.length > MAX_MANAGED_IMAGE_REMOTE_URL_CHARS) {
        return `input.image_urls[${index}] exceeds the remote URL length limit`;
      }
      continue;
    }
    const comma = reference.indexOf(",");
    if (comma < 0 || comma > 64) {
      return `input.image_urls[${index}] must be an http(s) or supported image data URL`;
    }
    const header = reference.slice(0, comma).toLowerCase();
    const headerMatch = /^data:([^;,]+);base64$/.exec(header);
    if (!headerMatch || !supportedManagedImageMime(headerMatch[1]!)) {
      return `input.image_urls[${index}] must be an http(s) or supported image data URL`;
    }
    const decoded = decodedBase64Length(reference, comma + 1);
    if (decoded === null || decoded < 1) {
      return `input.image_urls[${index}] contains invalid base64`;
    }
    if (decoded > MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES) {
      return `input.image_urls[${index}] exceeds the managed per-reference byte limit`;
    }
    decodedTotal += decoded;
    serializedTotal += reference.length;
    if (
      decodedTotal > MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES ||
      serializedTotal > MAX_MANAGED_IMAGE_REFERENCE_SERIALIZED_CHARS
    ) {
      return "input.image_urls exceeds the managed aggregate reference limit";
    }
  }
  return null;
};

export const assertDurableImageSubmissionShape = (value: unknown): void => {
  if (!isRecord(value) || !isRecord(value.input)) {
    throw new Error("Durable image submission payload is invalid.");
  }
  const error = validateManagedImageReferenceEnvelope(
    "image_edit",
    value.input,
  );
  if (error) throw new Error(`Durable image submission ${error}.`);
};
