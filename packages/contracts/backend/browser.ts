/**
 * Hosted-browser handoffs: a cloud agent's browser reached a sign-in or a
 * device-code page and is waiting for the owner. Each wait is an interaction
 * in the owner's object; the private Browser Gateway holds everything secret
 * (the login URL, the Live View, the session), and these calls fetch it on
 * demand. `browser.decide` answers the wait and resumes the agent.
 */

import type {
  CloudBrowserEncryptedSessionTransfer,
  CloudBrowserInteractionDecision,
  CloudBrowserInteractionDetail,
  CloudBrowserInteractionSummary,
  CloudBrowserLiveViewCapability,
  CloudBrowserSessionTransferCapability,
} from "../cloud-browser.js";

export type BrowserCalls = {
  /** The gateway's private detail for one wait; null when it is unknown. */
  "browser.detail": {
    args: { interactionId: string };
    result: CloudBrowserInteractionDetail | null;
  };
  /** A short-lived Live View URL. Marks the wait as under human control. */
  "browser.liveView": {
    args: { interactionId: string; expectedRevision: number };
    result: CloudBrowserLiveViewCapability;
  };
  /** The gateway's public key for handing a signed-in session over. */
  "browser.sessionTransferKey": {
    args: { interactionId: string; expectedRevision: number };
    result: CloudBrowserSessionTransferCapability;
  };
  "browser.importSessionTransfer": {
    args: {
      interactionId: string;
      expectedRevision: number;
      transfer: CloudBrowserEncryptedSessionTransfer;
    };
    result: { schemaVersion: 1; interactionId: string; revision: number; verified: true };
  };
  /**
   * Done or cancel. Retrying with the same `requestId` answers with the same
   * result; the agent resumes once.
   */
  "browser.decide": {
    args: {
      interactionId: string;
      expectedRevision: number;
      requestId: string;
      decision: CloudBrowserInteractionDecision;
    };
    result: CloudBrowserInteractionSummary;
  };
  /** Forget every site the cloud browser is signed in to. Cancels open waits. */
  "browser.resetProfile": {
    args: { requestId: string };
    result: { schemaVersion: 1; profileId: "default"; profileEpoch: number; reset: true };
  };
};

export type BrowserViews = {
  /** Open waits, newest first. */
  "browser.pending": {
    args: Record<string, never>;
    result: CloudBrowserInteractionSummary[];
  };
};
