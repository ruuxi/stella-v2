/**
 * Generates the complete window.electronAPI shim script.
 *
 * Injected into the WebView via `injectedJavaScriptBeforeContentLoaded` so
 * that it runs synchronously BEFORE the desktop React app's JS executes.
 * The desktop frontend sees a fully functional electronAPI and doesn't know
 * it's running on mobile.
 *
 * Transport:
 *   • HTTP invoke/fire  → POST /bridge/ipc/:channel  (request-response / fire-and-forget)
 *   • WebSocket          → ws://.../bridge/ws          (real-time subscriptions)
 *
 * Desktop-only features (window chrome, screenshots, overlays, radial menu)
 * are stubbed as no-ops so the frontend never crashes.
 */
type MobileBridgeCapability = {
  mode: string;
  path: string;
  channel?: string;
  transport?: string;
  reason?: string;
};

type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
  mobileBridgeCapabilities?: {
    version: number;
    capabilities: MobileBridgeCapability[];
  };
};

export function generateShimScript(
  bridgeUrl: string,
  bootstrap: MobileBridgeBootstrap,
): string {
  const bridgeUrlJson = JSON.stringify(bridgeUrl);
  const bootstrapJson = JSON.stringify(bootstrap);

  return `(function() {
  'use strict';

  // ── Tag document for mobile CSS overrides ────────────────────────────
  document.documentElement.setAttribute('data-platform', 'mobile');

  // ── Native-feel touch resets ─────────────────────────────────────────
  // Universal selectors only, so this survives desktop self-modification
  // and never depends on Stella's class names or layout. Removes the
  // "this is a webpage" tells: tap-flash on touch, whole-page rubber-band
  // overscroll, and long-press save/share callouts on controls. Text
  // selection on content stays intact so chat output is still copyable.
  try {
    var __mreset = document.createElement('style');
    __mreset.id = 'stella-mobile-reset';
    __mreset.textContent =
      '*{-webkit-tap-highlight-color:transparent !important;}' +
      'html,body{overscroll-behavior:none;}' +
      'a,button,[role="button"]{-webkit-touch-callout:none;}';
    document.documentElement.appendChild(__mreset);
  } catch(e) {}

  // ── Inject bootstrap localStorage state ────────────────────────────
  // Copies the allowlisted desktop session and preference keys into the
  // WebView before the React app initializes.
  var __bootstrap = ${bootstrapJson};
  if (__bootstrap && __bootstrap.localStorage) {
    try {
      var __k = Object.keys(__bootstrap.localStorage);
      for (var __i = 0; __i < __k.length; __i++) {
        localStorage.setItem(__k[__i], __bootstrap.localStorage[__k[__i]]);
      }
    } catch(e) {
      console.warn('[stella-bridge] Failed to inject bootstrap state:', e);
    }
  }

  var BRIDGE_URL = ${bridgeUrlJson};
  var ws = null;
  var wsReady = false;
  var wsQueue = [];
  var responseCallbacks = new Map();
  var subscriptions = new Map();
  var bridgeCapabilities = (
    __bootstrap &&
    __bootstrap.mobileBridgeCapabilities &&
    Array.isArray(__bootstrap.mobileBridgeCapabilities.capabilities)
  ) ? __bootstrap.mobileBridgeCapabilities.capabilities : [];
  var hasCapabilityManifest = bridgeCapabilities.length > 0;

  var wsReconnectDelay = 1000;

  function postNativeMessage(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function toWebSocketUrl(httpUrl) {
    var url = new URL(httpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  function postBridgeJson(path, args) {
    return fetch(BRIDGE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: args }),
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() { return { error: 'Bridge error' }; }).then(function(err) {
          throw new Error(err.error || 'Bridge error');
        });
      }
      return res.json();
    });
  }

  function postBridgeVoid(path, args) {
    fetch(BRIDGE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: args }),
    }).catch(function() {});
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    return postBridgeJson('/bridge/ipc/' + encodeURIComponent(channel), args).then(function(data) {
      return data.result;
    });
  }

  function fire(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    postBridgeVoid('/bridge/ipc/' + encodeURIComponent(channel), args);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    ws = new WebSocket(toWebSocketUrl(BRIDGE_URL) + '/bridge/ws');

    ws.onopen = function() {
      wsReady = true;
      wsReconnectDelay = 1000;
      postNativeMessage({ type: 'connectionState', connected: true });
      while (wsQueue.length > 0) { ws.send(wsQueue.shift()); }
      for (var ch of subscriptions.keys()) {
        ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
      }
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'event' && msg.channel) {
          var listeners = subscriptions.get(msg.channel);
          if (listeners) {
            listeners.forEach(function(cb) {
              try { cb(msg.data); } catch(e) { console.error('[bridge] Listener error:', e); }
            });
          }
        }
        if (msg.type === 'response' && msg.id) {
          var cb = responseCallbacks.get(msg.id);
          if (cb) {
            responseCallbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error));
            else cb.resolve(msg.result);
          }
        }
      } catch(e) {}
    };

    ws.onclose = function() {
      wsReady = false;
      postNativeMessage({ type: 'connectionState', connected: false });
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 10000);
      setTimeout(connectWs, wsReconnectDelay);
    };

    ws.onerror = function() { wsReady = false; };
  }

  function wsSend(msg) {
    var str = JSON.stringify(msg);
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) { ws.send(str); }
    else { wsQueue.push(str); connectWs(); }
  }

  function subscribe(channel, cb) {
    if (!subscriptions.has(channel)) {
      subscriptions.set(channel, new Set());
      wsSend({ type: 'subscribe', channel: channel });
    }
    subscriptions.get(channel).add(cb);
    return function() {
      var listeners = subscriptions.get(channel);
      if (listeners) {
        listeners.delete(cb);
        if (listeners.size === 0) {
          subscriptions.delete(channel);
          wsSend({ type: 'unsubscribe', channel: channel });
        }
      }
    };
  }

  function findCapability(path, mode) {
    for (var i = 0; i < bridgeCapabilities.length; i++) {
      var capability = bridgeCapabilities[i];
      if (capability && capability.path === path && capability.mode === mode) {
        return capability;
      }
    }
    return null;
  }

  function unsupportedCapabilityError(path) {
    var capability = null;
    for (var i = 0; i < bridgeCapabilities.length; i++) {
      if (bridgeCapabilities[i] && bridgeCapabilities[i].path === path) {
        capability = bridgeCapabilities[i];
        break;
      }
    }
    var reason = capability && capability.reason ? ': ' + capability.reason : '';
    return new Error('Stella desktop capability is not available on mobile: ' + path + reason);
  }

  function invokeCapability(path, fallbackChannel) {
    var args = Array.prototype.slice.call(arguments, 2);
    var capability = findCapability(path, 'remote-request');
    var channel = capability && capability.channel;
    if (!channel && !hasCapabilityManifest) {
      channel = fallbackChannel;
    }
    if (!channel) {
      return Promise.reject(unsupportedCapabilityError(path));
    }
    return invoke.apply(null, [channel].concat(args));
  }

  function fireCapability(path, fallbackChannel) {
    var args = Array.prototype.slice.call(arguments, 2);
    var capability = findCapability(path, 'remote-request');
    var channel = capability && capability.channel;
    if (!channel && !hasCapabilityManifest) {
      channel = fallbackChannel;
    }
    if (!channel) {
      console.warn(unsupportedCapabilityError(path).message);
      return;
    }
    if (capability && capability.transport === 'invoke') {
      invoke.apply(null, [channel].concat(args)).catch(function(error) {
        console.warn('[stella-bridge] Failed capability invoke:', error && error.message ? error.message : error);
      });
      return;
    }
    fire.apply(null, [channel].concat(args));
  }

  function subscribeCapability(path, fallbackChannel, cb) {
    var capability = findCapability(path, 'remote-event');
    var channel = capability && capability.channel;
    if (!channel && !hasCapabilityManifest) {
      channel = fallbackChannel;
    }
    if (!channel) {
      console.warn(unsupportedCapabilityError(path).message);
      return noop;
    }
    return subscribe(channel, cb);
  }

  function setApiPath(root, path, value) {
    var parts = path.split('.');
    var target = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var part = parts[i];
      if (!target[part] || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part];
    }
    var leaf = parts[parts.length - 1];
    if (typeof target[leaf] !== 'function') {
      target[leaf] = value;
    }
  }

  function installRemoteCapabilities(root) {
    for (var i = 0; i < bridgeCapabilities.length; i++) {
      var capability = bridgeCapabilities[i];
      if (!capability || !capability.path || !capability.channel) continue;
      if (capability.mode === 'remote-request') {
        setApiPath(root, capability.path, (function(cap) {
          return function() {
            var args = Array.prototype.slice.call(arguments);
            if (cap.transport === 'send') {
              fire.apply(null, [cap.channel].concat(args));
              return;
            }
            return invoke.apply(null, [cap.channel].concat(args));
          };
        })(capability));
      }
      if (capability.mode === 'remote-event') {
        setApiPath(root, capability.path, (function(cap) {
          return function(cb) {
            return subscribe(cap.channel, cb);
          };
        })(capability));
      }
    }
  }

  // ── Stubs ─────────────────────────────────────────────────────────────

  function noop() {}
  function noopSub() { return noop; }
  function resolved(val) { return Promise.resolve(val); }

  // ── window.electronAPI ────────────────────────────────────────────────

  window.electronAPI = {
    platform: 'mobile',

    // ── Desktop window chrome (no-ops) ──────────────────────────────────

    window: {
      minimize: noop, maximize: noop, close: noop,
      isMaximized: function() { return resolved(false); },
      isMiniAlwaysOnTop: function() { return resolved(false); },
      setMiniAlwaysOnTop: noop,
      show: noop,
      setNativeButtonsVisible: noop,
    },

    // ── Display ─────────────────────────────────────────────────────────

    display: {
      onUpdate: function(cb) { return subscribe('display:update', cb); },
      readFile: function(filePath, options) {
        return invokeCapability('display.readFile', 'display:readFile', {
          filePath: filePath,
          conversationId: options && options.conversationId,
        });
      },
    },

    // ── UI state ────────────────────────────────────────────────────────

    ui: {
      getState: function() { return invoke('ui:getState'); },
      setState: function(partial) { return invoke('ui:setState', partial); },
      onState: function(cb) { return subscribe('ui:state', cb); },
      setAppReady: function(ready) { fire('app:setReady', ready); },
      reload: noop,
      hardReset: function() { return invoke('app:hardResetLocalState'); },
      morphStart: function() { return resolved({ ok: false }); },
      morphComplete: function() { return resolved({ ok: false }); },
    },

    // ── Screen capture (mostly no-ops on mobile) ────────────────────────

    capture: {
      getContext: function() { return invoke('chatContext:get'); },
      onContext: function(cb) { return subscribe('chatContext:updated', cb); },
      ackContext: noop,
      screenshot: function() { return resolved(null); },
      removeScreenshot: noop, submitRegionSelection: noop, submitRegionClick: noop,
      getWindowCapture: function() { return resolved(null); },
      cancelRegion: noop,
      pageDataUrl: function() { return resolved(null); },
      onRegionReset: noopSub,
    },

    // ── Radial menu overlay (no-ops) ────────────────────────────────────

    radial: { onShow: noopSub, onHide: noopSub, animDone: noop, onCursor: noopSub, onWindowBounds: noopSub },

    // ── Overlay system (no-ops) ─────────────────────────────────────────

    overlay: {
      setInteractive: noop, onModifierBlock: noopSub,
      onStartRegionCapture: noopSub, onEndRegionCapture: noopSub,
      onShowMini: noopSub, onHideMini: noopSub, onRestoreMini: noopSub,
      onShowVoice: noopSub, onHideVoice: noopSub, onDisplayChange: noopSub,
      onMorphForward: noopSub, onMorphReverse: noopSub, onMorphEnd: noopSub,       onMorphBounds: noopSub,
      onMorphState: noopSub,
      morphReady: noop, morphDone: noop,
    },

    // ── Mini bridge ─────────────────────────────────────────────────────

    mini: {
      onVisibility: noopSub, onDismissPreview: noopSub,
      request: function(req) { return invoke('miniBridge:request', req); },
      onUpdate: function(cb) { return subscribe('miniBridge:update', cb); },
      onRequest: noopSub, respond: noop, ready: noop, pushUpdate: noop,
    },

    // ── Themes ──────────────────────────────────────────────────────────

    theme: {
      onChange: function(cb) {
        return subscribe('theme:change', function(data) { cb(null, data); });
      },
      broadcast: noop,
      listInstalled: function() { return invoke('theme:listInstalled'); },
    },

    // ── Voice ───────────────────────────────────────────────────────────

    voice: {
      persistTranscript: function(p) { fire('voice:persistTranscript', p); },
      orchestratorChat: function(p) { return invoke('voice:orchestratorChat', p); },
      webSearch: function(p) { return invoke('voice:webSearch', p); },
      getRuntimeState: function() { return invoke('voice:getRuntimeState'); },
      onRuntimeState: function(cb) { return subscribe('voice:runtimeState', cb); },
      pushRuntimeState: function(s) { fire('voice:runtimeState', s); },
      setRtcShortcut: function() { return resolved({ ok: false, requestedShortcut: '', activeShortcut: '', error: 'Not supported on mobile' }); },
    },

    // ── Agent ───────────────────────────────────────────────────────────

    agent: {
      healthCheck: function() { return invoke('agent:healthCheck'); },
      getActiveRun: function() { return invoke('agent:getActiveRun'); },
      getAppSessionStartedAt: function() { return invoke('agent:getAppSessionStartedAt'); },
      startChat: function(p) { return invoke('agent:startChat', p); },
      sendInput: function(p) { return invokeCapability('agent.sendInput', 'agent:sendInput', p); },
      cancelChat: function(runId) { fire('agent:cancelChat', runId); },
      resumeStream: function(p) { return invoke('agent:resume', p); },
      resumeConversationExecution: function(p) { return invokeCapability('agent.resumeConversationExecution', 'agent:resume', p); },
      onStream: function(cb) { return subscribe('agent:event', cb); },
      onSelfModHmrState: function(cb) { return subscribe('agent:selfModHmrState', cb); },
      selfModRevert: function(fid, steps) { return invoke('selfmod:revert', { featureId: fid, steps: steps }); },
      getLastSelfModFeature: function() { return invoke('selfmod:lastFeature'); },
      listSelfModFeatures: function(limit) { return invoke('selfmod:recentFeatures', { limit: limit }); },
      triggerViteError: function() { return resolved({ ok: false }); },
      fixViteError: function() { return resolved({ ok: false }); },
    },

    // ── System ──────────────────────────────────────────────────────────

    system: {
      getDeviceId: function() { return invoke('device:getId'); },
      startPhoneAccessSession: function() { return invoke('phoneAccess:startSession'); },
      stopPhoneAccessSession: function() { return invoke('phoneAccess:stopSession'); },
      configurePiRuntime: function(c) { return invoke('host:configurePiRuntime', c); },
      setAuthState: function(payload) {
        return invoke('auth:setState', payload);
      },
      getAuthSession: function() { return invoke('auth:getSession'); },
      signInAnonymous: function() { return invoke('auth:signInAnonymous'); },
      signOutAuth: function() { return invoke('auth:signOut'); },
      getConvexAuthToken: function() { return invoke('auth:getConvexToken'); },
      completeRuntimeAuthRefresh: function(payload) {
        return invoke('auth:runtimeRefreshComplete', payload);
      },
      onRuntimeAuthRefreshRequested: function(cb) {
        return subscribe('auth:runtimeRefreshRequested', cb);
      },
      setCloudSyncEnabled: function() { return resolved(); },
      onAuthCallback: noopSub,
      openFullDiskAccess: noop,
      getPermissionStatus: function() { return invokeCapability('system.getPermissionStatus', 'permissions:getStatus'); },
      openPermissionSettings: function(kind) { return invokeCapability('system.openPermissionSettings', 'permissions:openSettings', { kind: kind }); },
      openExternal: function(url) {
        postNativeMessage({ type: 'openExternal', url: url });
      },
      showItemInFolder: noop,
      shellKillByPort: function() { return resolved(); },
      getLocalSyncMode: function() { return invoke('preferences:getSyncMode'); },
      setLocalSyncMode: function(m) { return invoke('preferences:setSyncMode', m); },
      getRadialTriggerKey: function() { return resolved('option'); },
      setRadialTriggerKey: function(k) { return resolved({ triggerKey: k }); },
      syncLocalModelPreferences: function(p) { return invokeCapability('system.syncLocalModelPreferences', 'preferences:setLocalModelPreferences', p); },
      listLlmCredentials: function() { return invokeCapability('system.listLlmCredentials', 'llmCredentials:list'); },
      saveLlmCredential: function(p) { return invokeCapability('system.saveLlmCredential', 'llmCredentials:save', p); },
      deleteLlmCredential: function(p) { return invokeCapability('system.deleteLlmCredential', 'llmCredentials:delete', p); },
      resetMessages: function() { return invoke('app:resetLocalMessages'); },
      onCredentialRequest: function(cb) {
        return subscribe('credential:request', function(data) { cb(null, data); });
      },
      submitCredential: function(p) { return invoke('credential:submit', p); },
      cancelCredential: function(p) { return invoke('credential:cancel', p); },
    },

    // ── Onboarding ──────────────────────────────────────────────────────

    onboarding: {
      synthesizeCoreMemory: function(p) { return invoke('onboarding:synthesizeCoreMemory', p); },
    },

    // ── Discovery ────────────────────────────────────────────────────────

    discovery: {
      checkCoreMemoryExists: function() { return invoke('discovery:coreMemoryExists'); },
      checkKnowledgeExists: function() { return invoke('discovery:knowledgeExists'); },
      collectData: function(o) { return invoke('discovery:collectBrowserData', o); },
      detectPreferred: function() { return invoke('discovery:detectPreferredBrowser'); },
      listProfiles: function(b) { return invoke('discovery:listBrowserProfiles', b); },
      writeCoreMemory: function(c) { return invoke('discovery:writeCoreMemory', c); },
      writeKnowledge: function(p) { return invoke('discovery:writeKnowledge', p); },
      collectAllSignals: function(o) { return invoke('discovery:collectAllSignals', o); },
    },

    // ── Browser data ────────────────────────────────────────────────────

    browser: {
      onBridgeStatus: function(cb) { return subscribe('browser:bridgeStatus', cb); },
      fetchJson: function(url, init) { return invoke('browser:fetchJson', url, init); },
      fetchText: function(url, init) { return invoke('browser:fetchText', url, init); },
    },

    // ── Office preview ──────────────────────────────────────────────────

    officePreview: {
      list: function() {
        return invoke('ui:getState').then(function(state) {
          return invoke('officePreview:list', {
            conversationId: state && state.conversationId,
          });
        });
      },
      start: function(filePath) {
        return invoke('ui:getState').then(function(state) {
          return invokeCapability('officePreview.start', 'officePreview:start', {
            filePath: filePath,
            conversationId: state && state.conversationId,
          });
        });
      },
      onUpdate: function(cb) {
        var stopped = false;
        var timer = null;
        var delivered = {};
        function scan() {
          if (stopped) return;
          invoke('ui:getState').then(function(state) {
            return invoke('officePreview:list', {
              conversationId: state && state.conversationId,
            });
          }).then(function(snapshots) {
            if (!Array.isArray(snapshots)) return;
            snapshots.forEach(function(snapshot) {
              if (!snapshot || !snapshot.sessionId) return;
              var previous = delivered[snapshot.sessionId] || -1;
              var updatedAt = typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0;
              if (previous >= updatedAt) return;
              delivered[snapshot.sessionId] = updatedAt;
              try { cb(snapshot); } catch(e) { console.error('[bridge] Listener error:', e); }
            });
          }).catch(function() {}).then(function() {
            if (!stopped) timer = setTimeout(scan, 1000);
          });
        }
        scan();
        return function() {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      },
    },

    // ── Media ────────────────────────────────────────────────────────────

    media: {
      saveOutput: function(url, fn) { return invoke('media:saveOutput', url, fn); },
      getStellaMediaDir: function() { return invoke('media:getStellaMediaDir'); },
    },

    // ── Google Workspace ─────────────────────────────────────────────────

    googleWorkspace: {
      getAuthStatus: function() { return invoke('googleWorkspace:authStatus'); },
      connect: function() { return invoke('googleWorkspace:connect'); },
      disconnect: function() { return invoke('googleWorkspace:disconnect'); },
      onAuthRequired: function(cb) { return subscribe('googleWorkspace:authRequired', cb); },
    },

    // ── Projects ────────────────────────────────────────────────────────

    projects: {
      list: function() { return invoke('projects:list'); },
      pickDirectory: function() { return resolved({ canceled: true, projects: [] }); },
      start: function(id) { return invoke('projects:start', id); },
      stop: function(id) { return invoke('projects:stop', id); },
      onChanged: function(cb) { return subscribe('projects:changed', cb); },
    },

    // ── Schedule ────────────────────────────────────────────────────────

    schedule: {
      listCronJobs: function() { return invoke('schedule:listCronJobs'); },
      listHeartbeats: function() { return invoke('schedule:listHeartbeats'); },
      listConversationEvents: function(p) { return invoke('schedule:listConversationEvents', p); },
      getConversationEventCount: function(p) { return invoke('schedule:getConversationEventCount', p); },
      onUpdated: function(cb) { return subscribe('schedule:updated', cb); },
    },

    // ── Store / self-mod ────────────────────────────────────────────────

    store: {
      listSelfModFeatures: function(l) { return invoke('store:listLocalFeatures', { limit: l }); },
      listFeatureBatches: function(fid) { return invoke('store:listFeatureBatches', { featureId: fid }); },
      getReleaseDraft: function(p) { return invoke('store:createReleaseDraft', p); },
      publishRelease: function(p) { return invoke('store:publishRelease', p); },
      listPackages: function() { return invoke('store:listPackages'); },
      getPackage: function(pid) { return invoke('store:getPackage', { packageId: pid }); },
      listPackageReleases: function(pid) { return invoke('store:listReleases', { packageId: pid }); },
      getPackageRelease: function(p) { return invoke('store:getRelease', p); },
      listInstalledMods: function() { return invoke('store:listInstalledMods'); },
      installRelease: function(p) { return invokeCapability('store.installRelease', 'store:installFromBlueprint', p); },
      uninstallPackage: function(pid) { return invoke('store:uninstallMod', { packageId: pid }); },
    },

    // ── Local chat ──────────────────────────────────────────────────────

    localChat: {
      getOrCreateDefaultConversationId: function() { return invoke('localChat:getOrCreateDefaultConversationId'); },
      listEvents: function(p) { return invoke('localChat:listEvents', p); },
      listMessages: function(p) { return invoke('localChat:listMessages', p); },
      listMessagesBefore: function(p) { return invoke('localChat:listMessagesBefore', p); },
      listActivity: function(p) { return invoke('localChat:listActivity', p); },
      listThreadActivity: function(p) { return invoke('localChat:listThreadActivity', p); },
      listFiles: function(p) { return invoke('localChat:listFiles', p); },
      getEventCount: function(p) { return invoke('localChat:getEventCount', p); },
      appendEvent: function(p) { return invoke('localChat:appendEvent', p); },
      persistDiscoveryWelcome: function(p) { return invoke('localChat:persistDiscoveryWelcome', p); },
      listSyncMessages: function(p) { return invoke('localChat:listSyncMessages', p); },
      getSyncCheckpoint: function(p) { return invoke('localChat:getSyncCheckpoint', p); },
      setSyncCheckpoint: function(p) { return invoke('localChat:setSyncCheckpoint', p); },
      onUpdated: function(cb) { return subscribe('localChat:updated', cb); },
      onThreadActivityUpdated: function(cb) { return subscribe('localChat:threadActivityUpdated', cb); },
      onTaskDecorationUpdated: function(cb) { return subscribe('localChat:taskDecorationUpdated', cb); },
    },

    // ── Social sessions ─────────────────────────────────────────────────

    socialSessions: {
      create: function(p) { return invoke('socialSessions:create', p); },
      updateStatus: function(p) { return invoke('socialSessions:updateStatus', p); },
      queueTurn: function(p) { return invoke('socialSessions:queueTurn', p); },
      getStatus: function() { return invoke('socialSessions:getStatus'); },
    },
  };

  installRemoteCapabilities(window.electronAPI);

  connectWs();

  console.log('[stella-bridge] Mobile bridge shim initialized');
})();
true;`;
}
