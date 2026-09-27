import { describe, expect, test } from "bun:test";
import { OAuth2Client } from "googleapis-common";
import type { AuthManager } from "./AuthManager.js";

/**
 * Proves the per-API `@googleapis/*` packages resolve and work at runtime
 * under Bun: each service module is imported the same way
 * `load-google-workspace-tools.ts` lazily imports it, builds its client from
 * a fake OAuth2 auth, and issues one request through a stubbed fetch so we
 * can check the URL, the injected bearer token, and the parsed response —
 * no network.
 */

const ACCESS_TOKEN = "fake-access-token";

const fakeAuthManager = (): AuthManager => {
  const client = new OAuth2Client({ clientId: "test-client-id" });
  client.setCredentials({
    access_token: ACCESS_TOKEN,
    expiry_date: Date.now() + 60 * 60 * 1000,
    token_type: "Bearer",
  });
  return {
    getAuthenticatedClient: async () => client,
  } as unknown as AuthManager;
};

type Captured = { url: string; authorization: string | null };

const stubFetch = (captured: Captured[]) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    captured.push({ url, authorization: headers.get("authorization") });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

type ClientGetter = (service: unknown) => Promise<unknown>;

const privateGetter =
  (name: string): ClientGetter =>
  (service) =>
    (service as Record<string, () => Promise<unknown>>)[name]!.call(service);

type Call = (
  client: any,
  fetchImplementation: typeof fetch,
) => Promise<{ data: unknown }>;

const cases: Array<{
  name: string;
  load: () => Promise<new (auth: AuthManager) => unknown>;
  getClient: ClientGetter;
  call: Call;
  expectedUrl: string;
}> = [
  {
    name: "gmail v1",
    load: async () => (await import("./GmailService.js")).GmailService,
    getClient: privateGetter("getGmailClient"),
    call: (c, f) => c.users.getProfile({ userId: "me" }, { fetchImplementation: f }),
    expectedUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  },
  {
    name: "calendar v3",
    load: async () => (await import("./CalendarService.js")).CalendarService,
    getClient: privateGetter("getCalendar"),
    call: (c, f) => c.calendarList.list({}, { fetchImplementation: f }),
    expectedUrl: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
  },
  {
    name: "drive v3",
    load: async () => (await import("./DriveService.js")).DriveService,
    getClient: privateGetter("getDriveClient"),
    call: (c, f) => c.about.get({ fields: "user" }, { fetchImplementation: f }),
    expectedUrl: "https://www.googleapis.com/drive/v3/about?fields=user",
  },
  {
    name: "docs v1",
    load: async () => (await import("./DocsService.js")).DocsService,
    getClient: privateGetter("getDocsClient"),
    call: (c, f) =>
      c.documents.get({ documentId: "doc-123" }, { fetchImplementation: f }),
    expectedUrl: "https://docs.googleapis.com/v1/documents/doc-123",
  },
  {
    name: "people v1",
    load: async () => (await import("./PeopleService.js")).PeopleService,
    getClient: privateGetter("getPeopleClient"),
    call: (c, f) =>
      c.people.get(
        { resourceName: "people/me", personFields: "names" },
        { fetchImplementation: f },
      ),
    expectedUrl:
      "https://people.googleapis.com/v1/people/me?personFields=names",
  },
];

describe("Google Workspace per-API clients", () => {
  test("AuthManager module loads with the googleapis-common OAuth2 client", async () => {
    const { AuthManager } = await import("./AuthManager.js");
    expect(typeof AuthManager).toBe("function");
  });

  for (const testCase of cases) {
    test(`${testCase.name} client resolves, authenticates, and round-trips`, async () => {
      const Service = await testCase.load();
      const service = new Service(fakeAuthManager());
      const client = await testCase.getClient(service);
      expect(client).toBeTruthy();

      const captured: Captured[] = [];
      const res = await testCase.call(client, stubFetch(captured));

      expect(res.data).toEqual({ ok: true });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe(testCase.expectedUrl);
      expect(captured[0]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    });
  }
});
