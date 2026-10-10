import { pathToFileURL } from "node:url";
import path from "node:path";
import { net, session } from "electron";
import type { DeviceFileSource } from "@stella/contracts/device-files";
import type { DeviceFileLocator } from "../services/device-file-locator.js";
import {
  publicDeviceFileSource,
  resolveDeviceFileSource,
  type DeviceFileSourceDeps,
} from "../services/device-file-source.js";

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

const requestedMediaPath = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null;
  const encoded = parsed.pathname.replace(/^\//, "");
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
};

let deviceFiles: DeviceFileSourceDeps | null = null;

/**
 * Lets `stella-media:` play a file another of the user's devices produced:
 * when it is not on this computer, the copy that device put in the user's
 * Drive is streamed instead.
 */
export const setDeviceMediaSource = (deps: DeviceFileSourceDeps | null) => {
  deviceFiles = deps;
};

/** Where a `stella-media:` stream for this path comes from, without reading it. */
export const describeMediaSource = async (
  requested: string,
): Promise<DeviceFileSource> =>
  publicDeviceFileSource(await resolveDeviceFileSource(requested, deviceFiles));

const withMediaHeaders = (upstream: Response, contentType?: string): Response => {
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("accept-ranges", "bytes");
  if (contentType && !responseHeaders.get("content-type")) {
    responseHeaders.set("content-type", contentType);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};

const rangeHeaders = (request: Request): Headers => {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  return headers;
};

const streamDriveCopy = async (
  locator: DeviceFileLocator,
  drivePath: string,
  request: Request,
): Promise<Response> => {
  for (const fresh of [false, true]) {
    const file = await locator.copyUrl(drivePath, { fresh });
    const upstream = await net.fetch(file.url, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: rangeHeaders(request),
    });
    if ((upstream.status === 401 || upstream.status === 403) && !fresh) {
      await upstream.body?.cancel().catch(() => undefined);
      continue;
    }
    return withMediaHeaders(upstream, file.contentType);
  }
  return new Response("Drive copy unavailable", { status: 502 });
};

export const serveMediaProtocol = (
  partition: string,
  options: { devices?: boolean } = {},
) => {
  const partitionSession = session.fromPartition(partition);
  if (partitionSession.protocol.isProtocolHandled(MEDIA_SCHEME)) return;
  const useDevices = options.devices ?? true;
  partitionSession.protocol.handle(MEDIA_SCHEME, async (request) => {
    const requested = requestedMediaPath(request.url);
    if (!requested) return new Response("Bad media path", { status: 400 });
    const devices = useDevices ? deviceFiles : null;
    try {
      const source = await resolveDeviceFileSource(requested, devices);
      if (source.kind === "local") {
        return withMediaHeaders(
          await net.fetch(pathToFileURL(source.filePath).toString(), {
            headers: rangeHeaders(request),
            bypassCustomProtocolHandlers: true,
          }),
        );
      }
      if (source.kind === "drive" && devices) {
        return await streamDriveCopy(devices.locator, source.drivePath, request);
      }
      return new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
};
