/**
 * Canonical policy injected into every cloud-built Stella renderer entrypoint.
 *
 * It intentionally excludes unsafe-eval and remote scripts. The desktop
 * verifies this exact tag before granting installed files its privileged
 * preload bridge.
 */
export const STELLA_RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const STELLA_RENDERER_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="${STELLA_RENDERER_CSP}">`;

const DOCUMENT_THROUGH_HEAD =
  /^(\s*<!doctype html>\s*<html(?:\s+[^<>]*)?>\s*<head(?:\s+[^<>]*)?>)/i;

export const stellaRendererHeadEnd = (html: string): number | null => {
  const match = DOCUMENT_THROUGH_HEAD.exec(html);
  return match ? match[0].length : null;
};
