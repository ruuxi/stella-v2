import { pathToFileURL } from "node:url";
import path from "node:path";
import { net, session } from "electron";

export const MEDIA_SCHEME = "stella-media";
export const MEDIA_ORIGIN = `${MEDIA_SCHEME}://local`;
export const MEDIA_PROBE_PARTITION = "persist:stella-media-probe";

export const MEDIA_SCHEME_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const;

export const mediaUrlForPath = (filePath: string): string =>
  `${MEDIA_ORIGIN}/${encodeURIComponent(path.resolve(filePath))}`;

export const filePathFromMediaUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null;
  const encoded = parsed.pathname.replace(/^\//, "");
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!path.isAbsolute(decoded)) return null;
  return path.resolve(decoded);
};

export const serveMediaProtocol = (partition: string) => {
  const partitionSession = session.fromPartition(partition);
  if (partitionSession.protocol.isProtocolHandled(MEDIA_SCHEME)) return;
  partitionSession.protocol.handle(MEDIA_SCHEME, async (request) => {
    const filePath = filePathFromMediaUrl(request.url);
    if (!filePath) return new Response("Bad media path", { status: 400 });
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    try {
      const upstream = await net.fetch(pathToFileURL(filePath).toString(), {
        headers,
        bypassCustomProtocolHandlers: true,
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("access-control-allow-origin", "*");
      responseHeaders.set("accept-ranges", "bytes");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
};
