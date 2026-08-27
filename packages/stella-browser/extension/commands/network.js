import {
  ensureDebugger,
  holdDebugger,
  onCdpEvent,
  offCdpEvent,
  clearCdpEvents,
  releaseDebugger,
} from '../lib/debugger.js';
import { getActiveTab } from './tabs.js';

const trackedRequests = new Map();
const activeRoutes = new Map();
const harRecording = new Map();

const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BODY_BYTES = 8 * 1024 * 1024;

const MAX_TRACKED_REQUESTS = 5000;

const NETWORK_ENABLE_PARAMS = {
  maxTotalBufferSize: 100 * 1024 * 1024,
  maxResourceBufferSize: 20 * 1024 * 1024,
};

const MAX_STREAM_FRAMES = 300;
const MAX_FRAME_BYTES = 32 * 1024;

const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};

function isMediaManifest(request) {
  const mimeType = (request.mimeType || '').toLowerCase();
  if (
    mimeType.includes('mpegurl') ||
    mimeType.includes('dash+xml') ||
    mimeType.includes('vnd.apple.mpegurl')
  ) {
    return true;
  }
  const url = (request.url || '').toLowerCase().split('?')[0];
  return url.endsWith('.m3u8') || url.endsWith('.mpd');
}

function isApiShapedRequest(request) {
  if (request.type === 'XHR' || request.type === 'Fetch') return true;
  const mimeType = (request.mimeType || '').toLowerCase();
  if (mimeType.includes('json') || mimeType.includes('graphql')) return true;
  return isMediaManifest(request);
}

function sessionTarget(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

function findRequest(state, requestId, sessionId) {
  const scoped = sessionId ?? null;
  for (let index = state.requests.length - 1; index >= 0; index -= 1) {
    const request = state.requests[index];
    if (request.requestId === requestId && request.sessionId === scoped) return request;
  }
  return null;
}

async function enableNetworkForSession(tabId, sessionId) {
  const target = sessionTarget(tabId, sessionId);
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', NETWORK_ENABLE_PARAMS);
  } catch {

  }
  try {
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
  } catch {

  }
}

function startTracking(tabId) {
  if (trackedRequests.has(tabId)) return;

  trackedRequests.set(tabId, { requests: [], tracking: true });

  onCdpEvent(tabId, 'Target.attachedToTarget', (params) => {
    if (!params?.sessionId) return;
    void enableNetworkForSession(tabId, params.sessionId);
  });

  onCdpEvent(tabId, 'Network.requestWillBeSent', (params, source) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const sessionId = source?.sessionId ?? null;

    if (params.redirectResponse) {
      const previous = findRequest(state, params.requestId, sessionId);
      if (previous && previous.status === null) {
        previous.status = params.redirectResponse.status;
        previous.statusText = params.redirectResponse.statusText ?? '';
        previous.responseHeaders = params.redirectResponse.headers ?? null;
        previous.mimeType = params.redirectResponse.mimeType ?? '';
      }
    }

    if (state.requests.length >= MAX_TRACKED_REQUESTS) {
      state.truncated = true;
      return;
    }

    state.requests.push({
      requestId: params.requestId,
      sessionId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,

      postData: params.request.postData ?? null,
      hasPostData: Boolean(params.request.hasPostData),
      timestamp: params.timestamp,
      type: params.type,
      status: null,
      responseHeaders: null,
      responseBody: null,
      responseBodyBase64: false,
      responseBodyTruncated: false,
    });
  });

  onCdpEvent(tabId, 'Network.responseReceived', (params, source) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const req = findRequest(state, params.requestId, source?.sessionId ?? null);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.responseHeaders = params.response.headers;
      req.mimeType = params.response.mimeType;
      req.responseSize = params.response.encodedDataLength;
    }
  });

  onCdpEvent(tabId, 'Network.loadingFinished', (params, source) => {
    const harState = harRecording.get(tabId);
    if (!harState) return;

    const state = trackedRequests.get(tabId);
    if (!state) return;

    const sessionId = source?.sessionId ?? null;
    const req = findRequest(state, params.requestId, sessionId);
    if (!req || !isApiShapedRequest(req)) return;
    if (harState.bodyBytes >= MAX_TOTAL_BODY_BYTES) return;

    const target = sessionTarget(tabId, sessionId);
    const capture = (async () => {

      if (!req.postData && req.hasPostData) {
        try {
          const posted = await chrome.debugger.sendCommand(
            target,
            'Network.getRequestPostData',
            { requestId: params.requestId }
          );
          if (typeof posted?.postData === 'string') req.postData = posted.postData;
        } catch {

        }
      }

      try {
        const result = await chrome.debugger.sendCommand(
          target,
          'Network.getResponseBody',
          { requestId: params.requestId }
        );
        if (typeof result?.body !== 'string') return;

        let body = result.body;
        if (body.length > MAX_BODY_BYTES) {
          body = body.slice(0, MAX_BODY_BYTES);
          req.responseBodyTruncated = true;
        }
        req.responseBody = body;
        req.responseBodyBase64 = Boolean(result.base64Encoded);
        harState.bodyBytes += body.length;
      } catch {

      }
    })();

    harState.pending.add(capture);
    void capture.finally(() => harState.pending.delete(capture));
  });

  const streamEntry = (state, requestId, sessionId, url, kind) => {
    let entry = findRequest(state, requestId, sessionId);
    if (entry) return entry;
    if (state.requests.length >= MAX_TRACKED_REQUESTS) {
      state.truncated = true;
      return null;
    }
    entry = {
      requestId,
      sessionId: sessionId ?? null,
      url,
      method: 'GET',
      headers: {},
      postData: null,
      hasPostData: false,
      timestamp: Date.now() / 1000,
      type: kind,
      status: 101,
      statusText: '',
      responseHeaders: null,
      responseBody: null,
      responseBodyBase64: false,
      responseBodyTruncated: false,
      frames: [],
    };
    state.requests.push(entry);
    return entry;
  };

  const pushFrame = (entry, direction, payload, extra = {}) => {
    if (!entry || !Array.isArray(entry.frames)) return;
    if (entry.frames.length >= MAX_STREAM_FRAMES) {
      entry.framesTruncated = true;
      return;
    }
    const text = typeof payload === 'string' ? payload : '';
    entry.frames.push({
      type: direction,
      time: Date.now() / 1000,
      data: text.length > MAX_FRAME_BYTES ? text.slice(0, MAX_FRAME_BYTES) : text,
      ...extra,
    });
  };

  onCdpEvent(tabId, 'Network.webSocketCreated', (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;
    streamEntry(state, params.requestId, source?.sessionId ?? null, params.url, 'WebSocket');
  });

  const onWebSocketFrame = (direction) => (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;
    const entry = streamEntry(
      state,
      params.requestId,
      source?.sessionId ?? null,
      '',
      'WebSocket',
    );
    pushFrame(entry, direction, params.response?.payloadData, {
      opcode: params.response?.opcode,
    });
  };
  onCdpEvent(tabId, 'Network.webSocketFrameSent', onWebSocketFrame('send'));
  onCdpEvent(tabId, 'Network.webSocketFrameReceived', onWebSocketFrame('receive'));

  onCdpEvent(tabId, 'Network.eventSourceMessageReceived', (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const entry = streamEntry(
      state,
      params.requestId,
      source?.sessionId ?? null,
      '',
      'EventSource',
    );
    if (entry && !Array.isArray(entry.frames)) entry.frames = [];
    pushFrame(entry, 'receive', params.data, {
      eventName: params.eventName,
      eventId: params.eventId,
    });
  });
}

async function ensureNetworkTracking(tabId) {
  if (!trackedRequests.has(tabId)) {
    await ensureDebugger(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', NETWORK_ENABLE_PARAMS);
    startTracking(tabId);

    try {
      await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
    } catch {

    }
  }
}

function findTrackedResponse(tabId, url) {
  const state = trackedRequests.get(tabId);
  if (!state) return null;

  for (let index = state.requests.length - 1; index >= 0; index--) {
    const request = state.requests[index];
    if (request.url.includes(url) && request.status != null) {
      return request;
    }
  }

  return null;
}

async function waitForTrackedResponse(tabId, url, timeout = 30000) {
  const existing = findTrackedResponse(tabId, url);
  if (existing) return existing;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offCdpEvent(tabId, 'Network.responseReceived', onResponse);
      reject(new Error(`Timed out waiting for response matching: ${url}`));
    }, timeout);

    const onResponse = (params) => {
      const request = findTrackedResponse(tabId, url);
      if (!request || request.requestId !== params.requestId) return;
      clearTimeout(timer);
      offCdpEvent(tabId, 'Network.responseReceived', onResponse);
      resolve(request);
    };

    onCdpEvent(tabId, 'Network.responseReceived', onResponse);
  });
}

export async function handleRequests(command) {
  const tab = await getActiveTab(command);

  if (command.clear) {
    trackedRequests.delete(tab.id);
    return { id: command.id, success: true, data: { cleared: true } };
  }

  await ensureNetworkTracking(tab.id);

  const state = trackedRequests.get(tab.id);
  let requests = state ? state.requests : [];

  if (command.filter) {
    const filter = command.filter.toLowerCase();
    requests = requests.filter(r =>
      r.url.toLowerCase().includes(filter) ||
      (r.method && r.method.toLowerCase().includes(filter))
    );
  }

  return {
    id: command.id,
    success: true,
    data: {
      requests: requests.map(r => ({
        url: r.url,
        method: r.method,
        status: r.status,
        type: r.type,
        mimeType: r.mimeType,
        requestId: r.requestId,
      })),
    },
  };
}

export async function handleResponseBody(command) {
  const tab = await getActiveTab(command);
  if (!command.url) throw new Error('url is required for responsebody');

  await ensureNetworkTracking(tab.id);
  const request = await waitForTrackedResponse(tab.id, command.url, command.timeout);
  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    'Network.getResponseBody',
    { requestId: request.requestId }
  );

  let body = result.body;
  if (!result.base64Encoded) {
    try {
      body = JSON.parse(result.body);
    } catch {

    }
  }

  return {
    id: command.id,
    success: true,
    data: {
      url: request.url,
      status: request.status,
      body,
      base64Encoded: result.base64Encoded,
    },
  };
}

function urlMatchesPattern(url, pattern) {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  return regex.test(url);
}

export async function handleRoute(command) {
  const tab = await getActiveTab(command);
  const pattern = command.url;
  if (!pattern) throw new Error('URL pattern is required for route');

  await ensureDebugger(tab.id);

  if (!activeRoutes.has(tab.id)) {
    activeRoutes.set(tab.id, new Map());

    onCdpEvent(tab.id, 'Fetch.requestPaused', async (params) => {
      const routes = activeRoutes.get(tab.id);
      if (!routes) return;

      let matched = null;
      for (const [routePattern, config] of routes) {
        if (urlMatchesPattern(params.request.url, routePattern)) {
          matched = config;
          break;
        }
      }

      try {
        if (matched) {
          if (matched.abort) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.failRequest', {
              requestId: params.requestId,
              errorReason: 'BlockedByClient',
            });
          } else if (matched.response) {
            const body = matched.response.body
              ? btoa(typeof matched.response.body === 'string' ? matched.response.body : JSON.stringify(matched.response.body))
              : undefined;
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.fulfillRequest', {
              requestId: params.requestId,
              responseCode: matched.response.status || 200,
              responseHeaders: Object.entries(matched.response.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
              body,
            });
          } else {

            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.continueRequest', {
              requestId: params.requestId,
            });
          }
        } else {

          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.continueRequest', {
            requestId: params.requestId,
          });
        }
      } catch (err) {
        console.error('[network] Route handler error:', err);
      }
    });
  }

  activeRoutes.get(tab.id).set(pattern, {
    response: command.response,
    abort: command.abort,
  });

  const allPatterns = Array.from(activeRoutes.get(tab.id).keys()).map(p => ({
    urlPattern: p,
  }));

  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
    patterns: allPatterns,
  });

  return { id: command.id, success: true, data: { routed: pattern } };
}

export async function handleUnroute(command) {
  const tab = await getActiveTab(command);
  const pattern = command.url;
  const routes = activeRoutes.get(tab.id);

  if (!routes) {
    return { id: command.id, success: true, data: { unrouted: pattern ?? 'all' } };
  }

  if (pattern) {
    routes.delete(pattern);
  } else {
    routes.clear();
  }

  if (routes.size === 0) {
    activeRoutes.delete(tab.id);
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.disable');
    } catch {

    }
  } else {

    const allPatterns = Array.from(routes.keys()).map(p => ({ urlPattern: p }));
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
      patterns: allPatterns,
    });
  }

  return { id: command.id, success: true, data: { unrouted: pattern ?? 'all' } };
}

export async function handleHarStart(command) {
  const tab = await getActiveTab(command);

  await ensureNetworkTracking(tab.id);

  const state = trackedRequests.get(tab.id);
  if (state) {
    state.requests = [];
    state.truncated = false;
  }

  harRecording.set(tab.id, {
    startTime: Date.now(),
    bodyBytes: 0,
    pending: new Set(),
  });

  holdDebugger(tab.id);

  return { id: command.id, success: true, data: { started: true } };
}

async function resolvePostData(tabId, request) {
  if (request.postData) return request.postData;
  if (!request.hasPostData) return null;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Network.getRequestPostData',
      { requestId: request.requestId }
    );
    return typeof result?.postData === 'string' ? result.postData : null;
  } catch {
    return null;
  }
}

export async function handleHarStop(command) {
  const tab = await getActiveTab(command);
  const state = trackedRequests.get(tab.id);
  const harState = harRecording.get(tab.id);

  if (harState && harState.pending.size > 0) {
    await Promise.allSettled(Array.from(harState.pending));
  }

  releaseDebugger(tab.id);

  const requests = state ? state.requests : [];
  const requestCount = requests.length;

  const entries = await Promise.all(requests.map(async (r) => {
    const postData = await resolvePostData(tab.id, r);

    const frames = Array.isArray(r.frames) && r.frames.length > 0
      ? {
          [r.type === 'EventSource' ? '_eventSourceMessages' : '_webSocketMessages']: r.frames,
          ...(r.framesTruncated ? { _framesTruncated: true } : {}),
        }
      : {};

    return {
      startedDateTime: new Date(r.timestamp * 1000).toISOString(),
      _resourceType: r.type,
      ...frames,
      request: {
        method: r.method,
        url: r.url,
        headers: r.headers ? Object.entries(r.headers).map(([name, value]) => ({ name, value })) : [],
        ...(postData
          ? {
              postData: {
                mimeType: r.headers?.['content-type'] || r.headers?.['Content-Type'] || '',
                text: postData,
              },
            }
          : {}),
      },
      response: {
        status: r.status || 0,
        statusText: r.statusText || '',
        headers: r.responseHeaders ? Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })) : [],
        content: {
          size: r.responseSize || 0,
          mimeType: r.mimeType || '',
          ...(r.responseBody !== null
            ? {
                text: r.responseBody,
                ...(r.responseBodyBase64 ? { encoding: 'base64' } : {}),
                ...(r.responseBodyTruncated ? { _truncated: true } : {}),
              }
            : {}),
        },
      },
    };
  }));

  const bodiesCaptured = entries.filter(e => typeof e.response.content.text === 'string').length;
  const truncated = Boolean(state?.truncated);

  harRecording.delete(tab.id);

  if (state) {
    for (const request of state.requests) {
      request.responseBody = null;
      request.postData = null;
    }
  }

  return {
    id: command.id,
    success: true,
    data: {
      path: command.path,
      requestCount,
      bodiesCaptured,

      recordingWasOpen: Boolean(harState),
      ...(truncated ? { truncated: true, trackedLimit: MAX_TRACKED_REQUESTS } : {}),
      log: {
        version: '1.2',
        entries,
      },
    },
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  trackedRequests.delete(tabId);
  activeRoutes.delete(tabId);
  harRecording.delete(tabId);
  releaseDebugger(tabId);
});
