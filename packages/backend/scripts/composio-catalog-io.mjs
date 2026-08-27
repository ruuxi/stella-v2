/** Read a provider catalog page without allocating beyond the fixed byte cap. */
export const readCatalogResponseTextBounded = async (
  response,
  maxBytes,
  label = "Composio catalog",
) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid catalog response byte limit.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel("catalog page byte limit exceeded").catch(() => {});
    throw new Error(`${label}: Composio response is too large.`);
  }
  if (!response.body) throw new Error(`${label}: Composio returned no body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("catalog page byte limit exceeded").catch(() => {});
        throw new Error(`${label}: Composio response is too large.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

/** Fail before retaining an unbounded provider page or catalog entry. */
export const assertCatalogPageWithinLimit = (
  pageIndex,
  maxPages,
  label = "Composio catalog",
) => {
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    pageIndex >= maxPages
  ) {
    throw new Error(`${label}: pagination exceeded ${maxPages} pages.`);
  }
};

export const setCatalogEntryBounded = (
  entries,
  key,
  value,
  maxEntries,
  label = "Composio catalog",
) => {
  if (!entries.has(key) && entries.size >= maxEntries) {
    throw new Error(`${label}: entry count exceeds ${maxEntries}.`);
  }
  entries.set(key, value);
};
