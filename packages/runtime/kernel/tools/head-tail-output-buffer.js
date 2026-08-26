export const RAW_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;
const omissionMarker = (omittedBytes) =>
  `... ${omittedBytes} bytes omitted ...`;

/**
 * Split text into non-empty UTF-8-safe frames without exceeding `maxBytes`.
 * Iterating JavaScript strings by code point prevents a frame boundary from
 * bisecting either a surrogate pair or its encoded UTF-8 scalar.
 */
export const splitUtf8TextByBytes = (text, maxBytes) => {
  const budget = Math.max(1, Math.floor(maxBytes));
  if (!text) return [];
  if (Buffer.byteLength(text, "utf8") <= budget) return [text];
  const frames = [];
  let codePoints = [];
  let frameBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (frameBytes > 0 && frameBytes + codePointBytes > budget) {
      frames.push(codePoints.join(""));
      codePoints = [];
      frameBytes = 0;
    }
    codePoints.push(codePoint);
    frameBytes += codePointBytes;
  }
  if (codePoints.length > 0) frames.push(codePoints.join(""));
  return frames;
};
/**
 * Byte-capped process output that keeps equal-sized head and tail regions.
 * This mirrors Codex's raw unified-exec collection boundary.
 */
export class HeadTailOutputBuffer {
  #maxBytes;
  #headBudget;
  #tailBudget;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #omittedBytes = 0;
  constructor(maxBytes = RAW_SHELL_OUTPUT_MAX_BYTES) {
    this.#maxBytes = Math.max(0, Math.floor(maxBytes));
    this.#headBudget = Math.floor(this.#maxBytes / 2);
    this.#tailBudget = this.#maxBytes - this.#headBudget;
  }
  pushText(text) {
    this.push(Buffer.from(text, "utf8"));
  }
  push(chunk) {
    if (chunk.length === 0) return;
    if (this.#maxBytes === 0) {
      this.#omittedBytes += chunk.length;
      return;
    }
    const remainingHead = this.#headBudget - this.#head.length;
    const headLength = Math.min(Math.max(0, remainingHead), chunk.length);
    if (headLength > 0) {
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, headLength)]);
    }
    this.#pushTail(chunk.subarray(headLength));
  }
  snapshot() {
    const retainedBytes = this.#head.length + this.#tail.length;
    const totalBytes = retainedBytes + this.#omittedBytes;
    const retained =
      this.#omittedBytes > 0
        ? Buffer.concat([
            this.#head,
            Buffer.from(`\n${omissionMarker(this.#omittedBytes)}\n`, "utf8"),
            this.#tail,
          ])
        : Buffer.concat([this.#head, this.#tail]);
    return {
      text: retained.toString("utf8"),
      retainedBytes,
      omittedBytes: this.#omittedBytes,
      totalBytes,
    };
  }
  drain() {
    const snapshot = this.snapshot();
    this.#head = Buffer.alloc(0);
    this.#tail = Buffer.alloc(0);
    this.#omittedBytes = 0;
    return snapshot;
  }
  #pushTail(chunk) {
    if (chunk.length === 0) return;
    if (this.#tailBudget === 0) {
      this.#omittedBytes += chunk.length;
      return;
    }
    if (chunk.length >= this.#tailBudget) {
      const kept = chunk.subarray(chunk.length - this.#tailBudget);
      this.#omittedBytes += this.#tail.length + (chunk.length - kept.length);
      this.#tail = Buffer.from(kept);
      return;
    }
    this.#tail = Buffer.concat([this.#tail, chunk]);
    const excess = this.#tail.length - this.#tailBudget;
    if (excess > 0) {
      this.#tail = this.#tail.subarray(excess);
      this.#omittedBytes += excess;
    }
  }
}
