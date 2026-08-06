import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = { addListener() {} };
const calls = [];

globalThis.chrome = {
  storage: {
    session: {
      async get() { return {}; },
      async set() {},
    },
  },
  debugger: { onEvent: noopEvent, onDetach: noopEvent },
  tabs: { onCreated: noopEvent, onRemoved: noopEvent },
  windows: { onRemoved: noopEvent },
  cookies: {
    async getAllCookieStores() {
      return [
        { id: 'regular-a', incognito: false, tabIds: [1] },
        { id: 'incognito', incognito: true, tabIds: [2] },
        { id: 'regular-b', incognito: false, tabIds: [3] },
      ];
    },
    async getAll(filter) {
      calls.push(filter);
      if (filter.storeId === 'regular-a') {
        return [{
          name: 'session',
          value: 'value-a',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: false,
          session: false,
          expirationDate: 2_000_000_000,
          sameSite: 'lax',
          storeId: 'regular-a',
          partitionKey: {
            topLevelSite: 'https://example.com',
            hasCrossSiteAncestor: false,
          },
        }];
      }
      return [{
        name: 'host',
        value: 'value-b',
        domain: 'another.example',
        path: '/app',
        secure: false,
        httpOnly: false,
        hostOnly: true,
        session: true,
        sameSite: 'unspecified',
        storeId: 'regular-b',
      }];
    },
  },
};

const { handleCookiesExportAll } = await import('./cookies.js');

test('cookies_export_all preserves Chrome cookie fields and excludes incognito stores', async () => {
  calls.length = 0;

  const response = await handleCookiesExportAll({
    id: 'export-all',
    action: 'cookies_export_all',
  });

  assert.deepEqual(calls, [
    { storeId: 'regular-a' },
    { storeId: 'regular-b' },
  ]);
  assert.equal(response.id, 'export-all');
  assert.equal(response.success, true);
  assert.deepEqual(response.data.cookies, [
    {
      name: 'session',
      value: 'value-a',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
      session: false,
      expirationDate: 2_000_000_000,
      sameSite: 'lax',
      storeId: 'regular-a',
      partitionKey: {
        topLevelSite: 'https://example.com',
        hasCrossSiteAncestor: false,
      },
    },
    {
      name: 'host',
      value: 'value-b',
      domain: 'another.example',
      path: '/app',
      secure: false,
      httpOnly: false,
      hostOnly: true,
      session: true,
      sameSite: 'unspecified',
      storeId: 'regular-b',
    },
  ]);
});
