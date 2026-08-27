import { getActiveTab } from './tabs.js';

async function resolveCookieUrl(command) {
  if (command.url) return command.url;
  const tab = await getActiveTab(command);
  return tab.url;
}

export async function handleCookiesGet(command) {
  const url = await resolveCookieUrl(command);

  if (!url || url.startsWith('chrome://')) {
    return {
      id: command.id,
      success: true,
      data: { cookies: [] },
    };
  }

  const cookies = await chrome.cookies.getAll({ url });

  const filtered = command.name
    ? cookies.filter(c => c.name === command.name)
    : cookies;

  return {
    id: command.id,
    success: true,
    data: {
      cookies: filtered.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate || -1,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    },
  };
}

export async function handleCookiesExportAll(command) {
  const stores = await chrome.cookies.getAllCookieStores();
  const regularStores = stores.filter(store => store.incognito !== true);
  const cookiesByStore = await Promise.all(
    regularStores.map(store => chrome.cookies.getAll({ storeId: store.id })),
  );

  return {
    id: command.id,
    success: true,
    data: {
      cookies: cookiesByStore.flat(),
    },
  };
}

export async function handleCookiesSet(command) {
  const url = await resolveCookieUrl(command);

  if (!url) throw new Error('URL is required for cookies_set');

  const cookie = {
    url: url,
    name: command.name,
    value: command.value,
    ...(command.domain && { domain: command.domain }),
    ...(command.path && { path: command.path }),
    ...(command.secure !== undefined && { secure: command.secure }),
    ...(command.httpOnly !== undefined && { httpOnly: command.httpOnly }),
    ...(command.sameSite && { sameSite: command.sameSite }),
    ...(command.expires && { expirationDate: command.expires }),
  };

  const result = await chrome.cookies.set(cookie);

  return {
    id: command.id,
    success: true,
    data: { cookie: result },
  };
}

export async function handleCookiesClear(command) {
  const url = await resolveCookieUrl(command);

  if (!url || url.startsWith('chrome://')) {
    return {
      id: command.id,
      success: true,
      data: { cleared: 0 },
    };
  }

  const cookies = await chrome.cookies.getAll({ url });

  let cleared = 0;
  for (const cookie of cookies) {

    if (command.name && cookie.name !== command.name) continue;

    const cookieUrl =
      (cookie.secure ? 'https://' : 'http://') +
      cookie.domain.replace(/^\./, '') +
      cookie.path;

    await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
    cleared++;
  }

  return {
    id: command.id,
    success: true,
    data: { cleared },
  };
}
