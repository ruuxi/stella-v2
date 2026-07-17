import { describe, expect, it } from "vitest";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { WorkerPeerLike } from "@stella/runtime/worker/peer-broker";
import { make as makeHostBus } from "@stella/runtime/worker/server/host-bus";

/**
 * The connect-card host hop: turn aborts must settle the pending desktop
 * card as cancelled immediately (the abort/timeout path of the Effect
 * worker surface).
 */
const createRecordingPeer = () => {
  const requests: Array<{
    method: string;
    params: unknown;
    resolve: (value: unknown) => void;
  }> = [];
  const peer: WorkerPeerLike = {
    notify: () => undefined,
    request: (method, params) =>
      new Promise((resolve) => {
        requests.push({ method, params, resolve: resolve as never });
      }),
    registerRequestHandler: () => undefined,
    registerNotificationHandler: () => undefined,
  };
  return { peer, requests };
};

describe("HostBus.requestConnectCard", () => {
  it("returns the host outcome when no abort happens", async () => {
    const { peer, requests } = createRecordingPeer();
    const bus = makeHostBus(peer);
    const pending = bus.requestConnectCard(
      METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
      { provider: "gmail" },
    );
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe(METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST);
    expect((request.params as { provider: string }).provider).toBe("gmail");
    expect((request.params as { offerId?: string }).offerId).toBeTruthy();
    request.resolve({ ok: true, status: "connected" });
    await expect(pending).resolves.toEqual({ ok: true, status: "connected" });
  });

  it("short-circuits when the signal is already aborted", async () => {
    const { peer, requests } = createRecordingPeer();
    const bus = makeHostBus(peer);
    const controller = new AbortController();
    controller.abort();
    await expect(
      bus.requestConnectCard(
        METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
        {},
        controller.signal,
      ),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  it("cancels the pending desktop card when aborted mid-flight", async () => {
    const { peer, requests } = createRecordingPeer();
    const bus = makeHostBus(peer);
    const controller = new AbortController();
    const pending = bus.requestConnectCard(
      METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
      { provider: "notion" },
      controller.signal,
    );
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    const offerId = (requests[0]!.params as { offerId: string }).offerId;

    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: "cancelled" });

    // Best-effort cancel hop fired with the same offerId.
    await Promise.resolve();
    const cancel = requests.find(
      (request) =>
        request.method === METHOD_NAMES.HOST_CONNECTOR_CONNECT_CANCEL,
    );
    expect(cancel).toBeDefined();
    expect((cancel!.params as { offerId: string }).offerId).toBe(offerId);

    // The eventual host response is swallowed — no unhandled rejection.
    requests[0]!.resolve({ ok: true, status: "connected" });
  });

  it("maps host transport failures to a reason string", async () => {
    const peer: WorkerPeerLike = {
      notify: () => undefined,
      request: () => Promise.reject(new Error("boom")),
      registerRequestHandler: () => undefined,
      registerNotificationHandler: () => undefined,
    };
    const bus = makeHostBus(peer);
    await expect(
      bus.requestConnectCard(METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST, {}),
    ).resolves.toEqual({ ok: false, reason: "boom" });
  });
});
