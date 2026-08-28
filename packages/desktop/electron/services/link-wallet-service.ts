import { randomUUID } from "crypto";
import { BrowserWindow, shell } from "electron";
import {
  formatLinkSpendUsd,
  LINK_WALLET_ADD_CARD_URL,
  type LinkWalletCardView,
  type LinkWalletSnapshot,
} from "@stella/contracts/link-wallet";
import { createLinkCli } from "@stella/runtime/kernel/wallet/cli";
import { PendingRequestStore } from "./pending-request-store.js";

const CARD_TIMEOUT_MS = 9.5 * 60 * 1000;

export type LinkWalletConnectOutcome =
  | {
      ok: true;
      status: "connected" | "already_connected";
      snapshot: LinkWalletSnapshot;
    }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

type LinkWalletPendingMeta = {
  conversationId?: string;
  offerId?: string;
  state: "pending" | "connecting";
  abort: AbortController;
  windows: BrowserWindow[];
};

type WindowManagerLike = {
  getFullWindow: () => BrowserWindow | null;
};

export type LinkWalletServiceOptions = {
  windowManagerTarget: {
    getWindowManager: () => WindowManagerLike | null | undefined;
  };
  stellaDataDir: string;
  getStellaDataDir?: () => string | null | undefined;
};

const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
};

export class LinkWalletService {
  private readonly options: LinkWalletServiceOptions;
  private readonly pending = new PendingRequestStore<LinkWalletConnectOutcome>();
  private readonly meta = new Map<string, LinkWalletPendingMeta>();
  private queue: Promise<void> = Promise.resolve();
  private lastSnapshot: LinkWalletSnapshot = { status: "disconnected" };

  constructor(options: LinkWalletServiceOptions) {
    this.options = options;
  }

  private dataDir(): string {
    return this.options.getStellaDataDir?.() || this.options.stellaDataDir;
  }

  private cli() {
    return createLinkCli({ stellaDataDir: this.dataDir() });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private targetWindows(): BrowserWindow[] {
    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const fullWindow = windowManager?.getFullWindow() ?? null;
    return fullWindow ? [fullWindow] : BrowserWindow.getAllWindows();
  }

  private broadcastSnapshot(snapshot: LinkWalletSnapshot) {
    this.lastSnapshot = snapshot;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("link-wallet:snapshot", snapshot);
    }
  }

  private broadcastCard(card: LinkWalletCardView) {
    const windows = this.targetWindows();
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("link-wallet:card", card);
    }
  }

  async status(): Promise<LinkWalletSnapshot> {
    if ([...this.meta.values()].some((entry) => entry.state === "connecting")) {
      return this.lastSnapshot.status === "connecting"
        ? this.lastSnapshot
        : { status: "connecting" };
    }
    try {
      const snapshot = await this.enqueue(() => this.cli().status());
      this.broadcastSnapshot(snapshot);
      return snapshot;
    } catch {
      const snapshot: LinkWalletSnapshot = { status: "disconnected" };
      this.broadcastSnapshot(snapshot);
      return snapshot;
    }
  }

  async connect(payload: {
    conversationId?: string;
  } = {}): Promise<LinkWalletConnectOutcome> {
    return this.requestConnection({
      ...payload,
      skipOffer: true,
    });
  }

  async requestConnection(payload: {
    conversationId?: string;
    offerId?: string;
    reason?: string;
    skipOffer?: boolean;
  }): Promise<LinkWalletConnectOutcome> {
    const windows = this.targetWindows();
    if (windows.length === 0) {
      return { ok: false, reason: "unsupported" };
    }
    for (const meta of this.meta.values()) {
      if (meta.state === "connecting" || meta.state === "pending") {
        return { ok: false, reason: "already_pending" };
      }
    }

    let current: LinkWalletSnapshot;
    try {
      current = await this.status();
    } catch {
      current = { status: "disconnected" };
    }
    if (current.status === "connected") {
      if (current.paymentMethods.length === 0) {
        this.broadcastCard({
          requestId: randomUUID(),
          phase: "add_card",
          ...(payload.conversationId
            ? { conversationId: payload.conversationId }
            : {}),
        });
      }
      return { ok: true, status: "already_connected", snapshot: current };
    }

    const requestId = randomUUID();
    this.meta.set(requestId, {
      state: payload.skipOffer ? "connecting" : "pending",
      abort: new AbortController(),
      windows,
      ...(payload.conversationId
        ? { conversationId: payload.conversationId }
        : {}),
      ...(payload.offerId ? { offerId: payload.offerId } : {}),
    });

    const settled = new Promise<LinkWalletConnectOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        const meta = this.meta.get(requestId);
        if (!this.pending.has(requestId)) return;
        meta?.abort.abort(new Error("Connection timed out."));
        this.settle(requestId, { ok: false, reason: "timeout" });
      }, CARD_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject: () => undefined,
        timeout,
      });
    });

    if (payload.skipOffer) {
      this.broadcastCard({
        requestId,
        phase: "pairing",
        ...(payload.conversationId
          ? { conversationId: payload.conversationId }
          : {}),
      });
      void this.runLoginFlow(requestId);
    } else {
      this.broadcastCard({
        requestId,
        phase: "offer",
        ...(payload.conversationId
          ? { conversationId: payload.conversationId }
          : {}),
        ...(payload.reason ? { message: payload.reason } : {}),
      });
    }

    return settled;
  }

  respond(payload: {
    requestId: string;
    action: "accept" | "decline" | "cancel";
  }): { ok: boolean; error?: string } {
    const meta = this.meta.get(payload.requestId);
    if (!meta || !this.pending.has(payload.requestId)) {
      return { ok: false, error: "Connect request not found." };
    }
    if (payload.action === "decline") {
      meta.abort.abort(new Error("Connection declined."));
      this.settle(payload.requestId, { ok: false, reason: "declined" });
      return { ok: true };
    }
    if (payload.action === "cancel") {
      meta.abort.abort(new Error("Connection cancelled."));
      this.settle(payload.requestId, { ok: false, reason: "cancelled" });
      return { ok: true };
    }
    if (meta.state !== "pending") {
      return { ok: false, error: "Connect flow already started." };
    }
    meta.state = "connecting";
    this.broadcastCard({
      requestId: payload.requestId,
      phase: "pairing",
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    });
    void this.runLoginFlow(payload.requestId);
    return { ok: true };
  }

  cancelByOfferId(offerId: string): { ok: boolean } {
    for (const [requestId, meta] of this.meta) {
      if (meta.offerId !== offerId) continue;
      meta.abort.abort(new Error("Connection cancelled."));
      this.settle(requestId, { ok: false, reason: "cancelled" });
      return { ok: true };
    }
    return { ok: false };
  }

  async disconnect(): Promise<{ ok: boolean; error?: string }> {
    for (const [requestId, meta] of this.meta) {
      meta.abort.abort(new Error("Connection cancelled."));
      this.settle(requestId, { ok: false, reason: "cancelled" });
    }
    try {
      await this.enqueue(() => this.cli().logout());
      this.broadcastSnapshot({ status: "disconnected" });
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not disconnect Link.";
      return { ok: false, error: message };
    }
  }

  async addCard(): Promise<{ ok: boolean; error?: string }> {
    try {
      await shell.openExternal(LINK_WALLET_ADD_CARD_URL);
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not open Link wallet.";
      return { ok: false, error: message };
    }
  }

  notifySpendApproval(payload: {
    merchantName?: string;
    amountCents?: number;
    conversationId?: string;
  }): void {
    const amountLabel =
      payload.amountCents !== undefined
        ? formatLinkSpendUsd(payload.amountCents)
        : undefined;
    this.broadcastCard({
      requestId: randomUUID(),
      phase: "awaiting_approval",
      ...(payload.conversationId
        ? { conversationId: payload.conversationId }
        : {}),
      ...(payload.merchantName ? { merchantName: payload.merchantName } : {}),
      ...(amountLabel ? { amountLabel } : {}),
    });
  }

  private async runLoginFlow(requestId: string) {
    const meta = this.meta.get(requestId);
    if (!meta) return;
    this.broadcastSnapshot({ status: "connecting" });
    let openedUrl: string | undefined;
    try {
      const snapshot = await this.enqueue(() =>
        this.cli().login(meta.abort.signal, (prompt) => {
          if (meta.abort.signal.aborted) return;
          this.broadcastSnapshot({
            status: "connecting",
            ...(prompt.verificationUrl
              ? { verificationUrl: prompt.verificationUrl }
              : {}),
            ...(prompt.userCode ? { userCode: prompt.userCode } : {}),
          });
          this.broadcastCard({
            requestId,
            phase: "pairing",
            ...(meta.conversationId
              ? { conversationId: meta.conversationId }
              : {}),
            ...(prompt.verificationUrl
              ? { verificationUrl: prompt.verificationUrl }
              : {}),
            ...(prompt.userCode ? { userCode: prompt.userCode } : {}),
          });
          const url = prompt.verificationUrl;
          if (url && isHttpsUrl(url) && url !== openedUrl) {
            openedUrl = url;
            void shell.openExternal(url).catch(() => undefined);
          }
        }),
      );
      if (meta.abort.signal.aborted) {
        this.settle(requestId, { ok: false, reason: "cancelled" });
        return;
      }
      this.broadcastSnapshot(snapshot);
      if (snapshot.status !== "connected") {
        this.settle(
          requestId,
          { ok: false, reason: "Link did not finish connecting." },
          "Could not connect Link.",
        );
        return;
      }
      this.settle(requestId, {
        ok: true,
        status: "connected",
        snapshot,
      });
    } catch (error) {
      if (!this.pending.has(requestId)) return;
      const cancelled = meta.abort.signal.aborted;
      const message =
        error instanceof Error ? error.message : "Connection failed.";
      this.settle(
        requestId,
        { ok: false, reason: cancelled ? "cancelled" : message },
        cancelled ? undefined : message,
      );
    }
  }

  private settle(
    requestId: string,
    outcome: LinkWalletConnectOutcome,
    errorMessage?: string,
  ) {
    const meta = this.meta.get(requestId);
    if (!this.pending.resolve(requestId, outcome)) return;
    this.meta.delete(requestId);
    if (!outcome.ok) {
      if (
        outcome.reason === "declined" ||
        outcome.reason === "cancelled" ||
        outcome.reason === "timeout"
      ) {
        this.broadcastCard({
          requestId,
          phase: "error",
          ...(meta?.conversationId
            ? { conversationId: meta.conversationId }
            : {}),
          message: outcome.reason,
        });
      } else {
        this.broadcastCard({
          requestId,
          phase: "error",
          ...(meta?.conversationId
            ? { conversationId: meta.conversationId }
            : {}),
          message: errorMessage ?? outcome.reason,
        });
      }
      if (this.lastSnapshot.status === "connecting") {
        this.broadcastSnapshot({ status: "disconnected" });
      }
      return;
    }
    const needsCard =
      outcome.snapshot.status === "connected" &&
      outcome.snapshot.paymentMethods.length === 0;
    this.broadcastCard({
      requestId,
      phase: needsCard ? "add_card" : "connected",
      ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}),
    });
  }
}
