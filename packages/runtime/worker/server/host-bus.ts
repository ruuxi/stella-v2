import crypto from "node:crypto";
import { Context, Layer } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { WorkerPeerLike } from "../peer-broker.js";
import type { ConnectCardOutcome } from "./types.js";

/**
 * The worker's single seam to "the host" (Electron over the peer broker).
 * Every service talks to the host through this service instead of holding
 * the raw peer, so the outbound surface stays enumerable.
 *
 * Methods are plain functions (not Effects): they are captured by run/tool
 * callbacks that the runner invokes from non-Effect code, and the peer is
 * already promise-based. Handlers that want Effect semantics wrap call sites
 * with Effect.tryPromise at the point of use.
 */
export interface Interface {
  readonly notify: (method: string, params?: unknown) => void;
  readonly request: <TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { retryOnDisconnect?: boolean },
  ) => Promise<TResult>;
  readonly activeRequestHandlerCount: () => number;
  /**
   * Host hop for the inline connect cards (connector + browser extension).
   * Attaches a worker-generated `offerId` so a turn abort can cancel the
   * pending desktop card via `host.connectorConnect.cancel` instead of
   * leaving it up until the desktop's own timeout.
   */
  readonly requestConnectCard: (
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ConnectCardOutcome>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/HostBus",
) {}

export const make = (peer: WorkerPeerLike): Interface => {
  const requestConnectCard = async (
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectCardOutcome> => {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    const offerId = crypto.randomUUID();
    const request: Promise<ConnectCardOutcome> = peer
      .request<ConnectCardOutcome>(
        method,
        { ...payload, offerId },
        { retryOnDisconnect: true },
      )
      .catch((error: unknown) => ({
        ok: false as const,
        reason: (error as Error).message || "host_unreachable",
      }));
    if (!signal) return await request;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const winner = await Promise.race([request, aborted]);
      if (winner !== "aborted") return winner;
      // Best-effort: settle the desktop card as cancelled right away.
      void peer
        .request(METHOD_NAMES.HOST_CONNECTOR_CONNECT_CANCEL, { offerId })
        .catch(() => undefined);
      // Swallow the eventual host response — the turn is gone.
      void request.catch(() => undefined);
      return { ok: false, reason: "cancelled" };
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  return {
    notify: (method, params) => peer.notify(method, params),
    request: (method, params, options) => peer.request(method, params, options),
    activeRequestHandlerCount: () => peer.activeRequestHandlerCount?.() ?? 0,
    requestConnectCard,
  };
};

export const layer = (peer: WorkerPeerLike) => Layer.succeed(Service, make(peer));
