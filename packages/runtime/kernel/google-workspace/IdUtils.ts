import { logToFile } from './logger.js';

const DOC_ID_REGEX = /\/d\/([a-zA-Z0-9-_]+)/;

export function extractDocId(url: string): string | undefined {
  logToFile(`[IdUtils] Attempting to extract doc ID from URL: ${url}`);
  if (!url || typeof url !== 'string') {
    logToFile(`[IdUtils] Invalid input: URL is null or not a string.`);
    return undefined;
  }
  const match = url.match(DOC_ID_REGEX);
  if (match && match[1]) {
    const docId = match[1];
    logToFile(`[IdUtils] Successfully extracted doc ID: ${docId}`);
    return docId;
  }
  logToFile(`[IdUtils] Could not extract doc ID from URL.`);
  return undefined;
}
