import dns from "dns";
import https from "https";
import type net from "net";

const PUBLIC_FALLBACK_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const PUBLIC_FALLBACK_DNS_TIMEOUT_MS = 2_000;

let publicFallbackResolver: dns.Resolver | null = null;
const getPublicFallbackResolver = (): dns.Resolver => {
  if (!publicFallbackResolver) {
    publicFallbackResolver = new dns.Resolver({
      timeout: PUBLIC_FALLBACK_DNS_TIMEOUT_MS,
      tries: 1,
    });
    publicFallbackResolver.setServers(PUBLIC_FALLBACK_DNS_SERVERS);
  }
  return publicFallbackResolver;
};

const resolveAddresses = (
  resolver: Pick<dns.Resolver, "resolve4" | "resolve6">,
  hostname: string,
  callback: (addresses: dns.LookupAddress[] | null) => void,
) => {
  resolver.resolve4(hostname, (err4, ipv4) => {
    if (!err4 && ipv4.length > 0) {
      callback(ipv4.map((address) => ({ address, family: 4 })));
      return;
    }
    resolver.resolve6(hostname, (err6, ipv6) => {
      if (!err6 && ipv6.length > 0) {
        callback(ipv6.map((address) => ({ address, family: 6 })));
        return;
      }
      callback(null);
    });
  });
};

const cacheBypassLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => {
  const finish = (addresses: dns.LookupAddress[]) => {
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
  resolveAddresses(dns, hostname, (configured) => {
    if (configured) {
      finish(configured);
      return;
    }
    resolveAddresses(getPublicFallbackResolver(), hostname, (fallback) => {
      if (fallback) {
        finish(fallback);
        return;
      }
      dns.lookup(hostname, options, (err, address, family) =>
        callback(err, address, family),
      );
    });
  });
};

export const probeBridgePublicHealth = (
  url: string,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(`${url.replace(/\/+$/, "")}/bridge/health`);
    } catch {
      resolve(false);
      return;
    }

    const request = https.request(
      {
        host: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: target.pathname,
        method: "GET",
        timeout: timeoutMs,
        lookup: cacheBypassLookup as net.LookupFunction,
      },
      (response) => {
        response.resume();
        resolve(
          typeof response.statusCode === "number" &&
            response.statusCode >= 200 &&
            response.statusCode < 300,
        );
      },
    );
    request.on("timeout", () => {
      request.destroy();
    });
    request.on("error", () => resolve(false));
    request.end();
  });
