import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import type {
  CloudAuthorityIssue,
  CloudConversationAuthority,
} from "./cloud-conversation-authority";

/**
 * What the account-authority handshake has proven so far for one identity.
 * `identityKey` travels with every entry so a reader can tell a cached result
 * for a previous session apart from one for the session it is rendering.
 */
export type CloudAuthorityEntry =
  | { status: "loading"; identityKey: string }
  | {
      status: "ready";
      identityKey: string;
      authority: CloudConversationAuthority;
    }
  | { status: "failed"; identityKey: string; issue: CloudAuthorityIssue };

export type CloudAuthorityStorePorts = {
  /** The six-hop handshake (token, identity proof, conversation, config…). */
  resolve: (
    identity: CloudConversationIdentity,
  ) => Promise<CloudConversationAuthority>;
  describeFailure: (error: unknown, anonymous: boolean) => CloudAuthorityIssue;
  /**
   * Runs exactly once per identity-key change, before the new handshake
   * starts: the moment to drop the previous subject's bearer token and retire
   * its sockets. It deliberately does not run on remounts or retries.
   */
  onIdentityChange: (identity: CloudConversationIdentity) => void;
};

/**
 * Process-level cache of the account authority handshake, keyed by identity.
 *
 * The handshake used to live in component state, so every mount of the chat
 * screen (each return from Settings, the CarPlay bridge attaching) started it
 * from zero behind a full-screen spinner and threw away a still-valid Convex
 * JWT on the way. Here the resolved authority and the in-flight promise
 * outlive any one mount: a remount reads the cached value synchronously, two
 * surfaces on the same session share one handshake, and the root layout can
 * start it while the native splash is still up.
 */
export class CloudConversationAuthorityStore {
  private identity: CloudConversationIdentity | null = null;
  private anonymous = false;
  private entry: CloudAuthorityEntry | null = null;
  private inflight: Promise<void> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ports: CloudAuthorityStorePorts) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CloudAuthorityEntry | null => this.entry;

  /**
   * Starts the handshake for `identity` unless one already ran or is running
   * for the same identity key. Returns the promise for whichever handshake is
   * current, settled (never rejected) once it lands in the snapshot.
   */
  ensure(
    identity: CloudConversationIdentity,
    anonymous: boolean,
  ): Promise<void> {
    if (this.identity?.identityKey === identity.identityKey && this.entry) {
      this.anonymous = anonymous;
      return this.inflight ?? Promise.resolve();
    }
    this.generation += 1;
    this.ports.onIdentityChange(identity);
    this.identity = identity;
    this.anonymous = anonymous;
    return this.start();
  }

  /** Re-runs the handshake for the current identity, keeping its token. */
  retry(): Promise<void> {
    if (!this.identity) return Promise.resolve();
    return this.start();
  }

  /** Forgets everything; the next `ensure` is treated as an identity change. */
  reset(): void {
    this.generation += 1;
    this.identity = null;
    this.inflight = null;
    if (this.entry === null) return;
    this.entry = null;
    this.emit();
  }

  private start(): Promise<void> {
    const identity = this.identity!;
    const generation = ++this.generation;
    this.entry = { status: "loading", identityKey: identity.identityKey };
    this.emit();
    const request = this.ports.resolve(identity).then(
      (authority) => {
        if (generation !== this.generation) return;
        this.entry = {
          status: "ready",
          identityKey: identity.identityKey,
          authority,
        };
        this.emit();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.entry = {
          status: "failed",
          identityKey: identity.identityKey,
          issue: this.ports.describeFailure(error, this.anonymous),
        };
        this.emit();
      },
    );
    const tracked = request.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    this.inflight = tracked;
    return tracked;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
