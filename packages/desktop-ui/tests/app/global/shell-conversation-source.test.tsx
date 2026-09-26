// @vitest-environment jsdom

import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "https://issuer.test|owner-a";
const OTHER_OWNER = "https://issuer.test|owner-b";
const LISTED = "11111111-1111-4111-8111-111111111111";
const ROUTED = "22222222-2222-4222-8222-222222222222";
const CACHED = "33333333-3333-4333-8333-333333333333";
const LATER = "44444444-4444-4444-8444-444444444444";

const BOOTSTRAP = "cloud_apps:getMyShellBootstrap";
const MIGRATION = "auth_migration:getMyOwnershipMigrationStatus";
const LIST = "cloud_apps:listMyConversations";
const IDENTITY = "cloud_apps:getMyCloudConversationIdentity";
const GET = "cloud_apps:getMyConversation";

type Args = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  convexAuthenticated: true,
  /** Server answers by request key; absent = still in flight. */
  results: new Map<string, unknown>(),
  /** Request keys the latest renders subscribed to. */
  requested: new Set<string>(),
  argsByKey: new Map<string, Record<string, unknown>>(),
  cachedConversationId: null as string | null,
  uiState: new Map<string, string>(),
}));

const requestKey = (name: string, args: Args) =>
  name === "cloud_apps:getMyConversation"
    ? `${name}(${String(args.conversationId)})`
    : name;

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const subscribe = (query: unknown, args: Args) => {
    const key = requestKey(
      getFunctionName(query as Parameters<typeof getFunctionName>[0]),
      args,
    );
    mocks.requested.add(key);
    mocks.argsByKey.set(key, args);
    return mocks.results.get(key);
  };
  return {
    useConvexAuth: () => ({
      isAuthenticated: mocks.convexAuthenticated,
      isLoading: false,
    }),
    useQueries: (request: Record<string, { query: unknown; args: Args }>) =>
      Object.fromEntries(
        Object.entries(request).map(([name, { query, args }]) => [
          name,
          subscribe(query, args),
        ]),
      ),
    useQuery: (query: unknown, args: Args | "skip") =>
      args === "skip" ? undefined : subscribe(query, args),
  };
});

vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => mocks.uiState.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.uiState.set(key, value),
    removeItem: (key: string) => mocks.uiState.delete(key),
  },
}));

vi.mock("@/features/cloud/cloud-conversation-cache", () => ({
  readActiveCloudConversationIdCache: () => mocks.cachedConversationId,
}));

import { useShellConversationSource } from "@/global/auth/hooks/use-shell-conversation-source";
import type { CloudConversation } from "@/features/cloud/cloud-api";

type Source = ReturnType<typeof useShellConversationSource>;
type Session = Parameters<typeof useShellConversationSource>[0]["session"];

const conversation = (
  conversationId: string,
  ownerId = OWNER,
): CloudConversation => ({
  conversationId,
  ownerId,
  title: conversationId.slice(0, 4),
  createdAt: 1,
  updatedAt: 2,
});

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    isCloudConversationReady: false,
    isLoading: true,
    sessionGate: {
      hasSession: true,
      sessionIsLoading: false,
      convexIsAuthenticated: true,
      convexIsLoading: false,
      hasExpectedSubject: true,
      authBootstrapReady: true,
      authBootstrapFailed: false,
    },
    canConfirmIdentity: true,
    accountScope: "account:owner-a",
    expectedSubject: "owner-a",
    ownerSubject: OWNER,
    identityRevision: 3,
    error: null,
    authBootstrapStatus: "ready",
    retryAuthBootstrap: () => {},
    ...overrides,
  }) as Session;

/** The deployed backend, answering each query the way Convex would. */
const serve = (
  key: string,
  options: {
    migration?: unknown;
    bootstrapMissing?: boolean;
    bootstrapOwnerId?: string;
  } = {},
): unknown => {
  const migration = options.migration ?? null;
  const owned = new Map(
    [LISTED, ROUTED, CACHED, LATER].map((id) => [id, conversation(id)]),
  );
  const blocked =
    migration !== null &&
    ["pending", "running", "failed"].includes(
      (migration as { status: string }).status,
    );
  if (key === BOOTSTRAP) {
    if (options.bootstrapMissing) {
      return new Error(
        `[CONVEX Q(${BOOTSTRAP})] Server Error Could not find public function for '${BOOTSTRAP}'.`,
      );
    }
    const args = mocks.argsByKey.get(key)!;
    const lookup = (id: unknown) =>
      typeof id === "string" ? (owned.get(id) ?? null) : null;
    return {
      status: "ready",
      ownerId: options.bootstrapOwnerId ?? OWNER,
      migration,
      selection: blocked
        ? null
        : {
            ownerGeneration: "generation-1",
            conversations: [conversation(LISTED)],
            routeConversation: lookup(args.routeConversationId),
            cachedConversation: lookup(args.cachedConversationId),
          },
    };
  }
  if (key === MIGRATION) return migration;
  if (key === LIST) return [conversation(LISTED)];
  if (key === IDENTITY) {
    return { ownerId: OWNER, ownerGeneration: "generation-1" };
  }
  const match = /^cloud_apps:getMyConversation\((.*)\)$/u.exec(key);
  if (match) return owned.get(match[1]!) ?? null;
  throw new Error(`unexpected query ${key}`);
};

let latest: Source | null = null;
let hookError: unknown = null;
let props: {
  session: Session;
  isPrivate: boolean;
  routeConversationId: string | null;
};

function Probe() {
  latest = useShellConversationSource(props);
  return null;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    hookError = error;
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Harness() {
  return (
    <Boundary>
      <Probe />
    </Boundary>
  );
}

describe("useShellConversationSource", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    mocks.requested.clear();
    await act(async () => root.render(<Harness />));
  };

  /**
   * Plays the launch as network round trips: every query subscribed but not
   * yet answered goes out together and is answered together. Returns the
   * keys sent in each trip.
   */
  const launch = async (
    options: Parameters<typeof serve>[1] & {
      /** Legacy chain: `confirmMySessionIdentity` lands with the first trip. */
      confirmOnFirstTrip?: boolean;
    } = {},
  ) => {
    await render();
    const trips: string[][] = [];
    const answered = new Set<string>();
    for (;;) {
      const pending = [...mocks.requested].filter((key) => !answered.has(key));
      if (options.confirmOnFirstTrip && trips.length === 0) {
        pending.push("cloud_apps:confirmMySessionIdentity");
      }
      if (pending.length === 0) return trips;
      trips.push(pending.sort());
      for (const key of pending) {
        answered.add(key);
        if (key !== "cloud_apps:confirmMySessionIdentity") {
          mocks.results.set(key, serve(key, options));
        }
      }
      if (options.confirmOnFirstTrip) {
        props = {
          ...props,
          session: makeSession({
            isCloudConversationReady: true,
            isLoading: false,
          }),
        };
      }
      await render();
      if (trips.length > 10) throw new Error("launch never settled");
    }
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    latest = null;
    hookError = null;
    mocks.convexAuthenticated = true;
    mocks.results.clear();
    mocks.requested.clear();
    mocks.argsByKey.clear();
    mocks.uiState.clear();
    mocks.cachedConversationId = CACHED;
    props = {
      session: makeSession(),
      isPrivate: false,
      routeConversationId: ROUTED,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("selects a conversation one round trip after Convex auth", async () => {
    // Ratchet: the route and cached conversations are both unlisted, the
    // worst case for the old chain (identity, then list, then lookups).
    const trips = await launch();

    expect(trips).toEqual([[BOOTSTRAP]]);
    expect(mocks.argsByKey.get(BOOTSTRAP)).toEqual({
      expectedSubject: "owner-a",
      expectedOwnerId: OWNER,
      identityRevision: 3,
      routeConversationId: ROUTED,
      cachedConversationId: CACHED,
    });
    expect(latest).toMatchObject({
      isCloudConversationReady: true,
      isLoading: false,
      ownershipMigration: null,
      ownershipMigrationGate: { canSelectConversation: true },
      cloudConversations: [conversation(LISTED)],
      ownerGeneration: "generation-1",
      cachedCloudConversationId: CACHED,
      routeIsListedOrPendingCloudConversation: false,
      exactCloudConversation: conversation(ROUTED),
      cachedConversationIsListed: false,
      exactCachedCloudConversation: conversation(CACHED),
    });
  });

  it("does not wait on the separate identity confirmation", async () => {
    // Other surfaces still confirm the session; the shell never needs it.
    props.session = makeSession({
      isCloudConversationReady: false,
      isLoading: true,
    });
    await launch();
    expect(latest?.isCloudConversationReady).toBe(true);
    expect(latest?.ownerGeneration).toBe("generation-1");
  });

  it("keeps the subscription when the route changes after launch", async () => {
    await launch();
    props = { ...props, routeConversationId: LATER };
    await render();

    expect(mocks.argsByKey.get(BOOTSTRAP)?.routeConversationId).toBe(ROUTED);
    expect([...mocks.requested].sort()).toEqual(
      [BOOTSTRAP, `${GET}(${LATER})`].sort(),
    );
    expect(latest?.exactCloudConversation).toBeUndefined();

    mocks.results.set(`${GET}(${LATER})`, conversation(LATER));
    await render();
    expect(latest?.exactCloudConversation).toEqual(conversation(LATER));
  });

  it("never exposes a result that belongs to another owner", async () => {
    const trips = await launch({ bootstrapOwnerId: OTHER_OWNER });

    expect(trips).toEqual([[BOOTSTRAP]]);
    expect(latest).toMatchObject({
      isCloudConversationReady: false,
      isLoading: true,
      ownershipMigration: undefined,
      cloudConversations: undefined,
      scopedCloudConversations: [],
      ownerGeneration: null,
      exactCloudConversation: undefined,
      exactCachedCloudConversation: undefined,
    });
  });

  it("stays loading while the connection holds another account", async () => {
    await render();
    mocks.results.set(BOOTSTRAP, { status: "identity_pending" });
    await render();

    expect(latest).toMatchObject({
      isCloudConversationReady: false,
      isLoading: true,
      cloudConversations: undefined,
    });
    expect([...mocks.requested]).toEqual([BOOTSTRAP]);
  });

  it.each(["pending", "running"] as const)(
    "holds selection during a %s migration and resumes live when it completes",
    async (status) => {
      const trips = await launch({ migration: { status, updatedAt: 5 } });

      expect(trips).toEqual([[BOOTSTRAP]]);
      expect(latest).toMatchObject({
        isCloudConversationReady: true,
        ownershipMigration: { status, updatedAt: 5 },
        ownershipMigrationGate: {
          isPending: true,
          canSelectConversation: false,
        },
        cloudConversations: undefined,
        ownerGeneration: null,
      });

      // The subscription is reactive: the completed transfer arrives on it.
      mocks.results.set(
        BOOTSTRAP,
        serve(BOOTSTRAP, { migration: { status: "complete", updatedAt: 6 } }),
      );
      await render();
      expect([...mocks.requested]).toEqual([BOOTSTRAP]);
      expect(latest).toMatchObject({
        ownershipMigrationGate: { canSelectConversation: true },
        cloudConversations: [conversation(LISTED)],
        ownerGeneration: "generation-1",
      });
    },
  );

  it("surfaces a failed migration and its error", async () => {
    const failed = {
      status: "failed",
      updatedAt: 5,
      error: "Account linking stopped.",
    };
    await launch({ migration: failed });

    expect(latest).toMatchObject({
      ownershipMigration: failed,
      ownershipMigrationGate: { isFailed: true, canSelectConversation: false },
      cloudConversations: undefined,
    });
  });

  it("throws a server failure, as the readiness-gated queries did", async () => {
    await render();
    mocks.results.set(BOOTSTRAP, new Error("Session has been revoked."));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await render();
    consoleError.mockRestore();
    expect(hookError).toEqual(new Error("Session has been revoked."));
  });

  it("falls back to the old chain when the backend lacks the query", async () => {
    const trips = await launch({
      bootstrapMissing: true,
      confirmOnFirstTrip: true,
    });

    // One wasted trip, then the old chain's own three: identity + migration,
    // then the list, generation and ownership lookups together.
    expect(trips).toEqual([
      ["cloud_apps:confirmMySessionIdentity", BOOTSTRAP].sort(),
      [MIGRATION],
      [IDENTITY, LIST, `${GET}(${CACHED})`, `${GET}(${ROUTED})`].sort(),
    ]);
    expect(hookError).toBeNull();
    expect(mocks.requested.has(BOOTSTRAP)).toBe(false);
    expect(latest).toMatchObject({
      isCloudConversationReady: true,
      ownershipMigration: null,
      cloudConversations: [conversation(LISTED)],
      ownerGeneration: "generation-1",
      exactCloudConversation: conversation(ROUTED),
      exactCachedCloudConversation: conversation(CACHED),
    });
  });

  it("does not start the old chain while the session is still loading", async () => {
    // Convex already holds a token but the session subject has not loaded.
    props.session = makeSession({
      expectedSubject: null,
      ownerSubject: null,
      canConfirmIdentity: false,
    });
    await render();
    expect([...mocks.requested]).toEqual([]);

    props.session = makeSession();
    await render();
    expect([...mocks.requested]).toEqual([BOOTSTRAP]);
  });

  it("uses the old chain when the owner id cannot be derived", async () => {
    props.session = makeSession({ ownerSubject: null });
    await render();
    expect([...mocks.requested]).toEqual([MIGRATION]);
  });

  it("reads nothing from Convex in private mode", async () => {
    props = { ...props, isPrivate: true };
    await render();
    expect([...mocks.requested]).toEqual([]);
    expect(latest).toMatchObject({
      isCloudConversationReady: false,
      cloudConversations: undefined,
    });
  });

  it("waits for the session before subscribing", async () => {
    props.session = makeSession({ canConfirmIdentity: false });
    await render();
    expect([...mocks.requested]).toEqual([]);
    expect(latest?.isCloudConversationReady).toBe(false);
  });
});
