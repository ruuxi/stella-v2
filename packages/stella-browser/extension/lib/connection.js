import { STELLA_NATIVE_HOST_NAME } from "./native-host-name.js";

const BRIDGE_HEALTH_URL = "http://127.0.0.1:39040/healthz";
const PROBE_INTERVAL = 4000;
const PROBE_TIMEOUT = 1500;
const EXTENSION_PROTOCOL_VERSION = "2.1";

let nativePort = null;
let probeTimer = null;
const probesInFlight = new Set();
let commandHandler = null;
let statusCallback = null;
let shouldConnect = false;
let connectionGeneration = 0;

export function onCommand(handler) {
  commandHandler = handler;
}

export function onStatus(callback) {
  statusCallback = callback;
}

export function connect() {
  if (
    shouldConnect &&
    (isConnected() || probesInFlight.has(connectionGeneration))
  ) {
    return;
  }
  shouldConnect = true;
  const generation = ++connectionGeneration;
  probeThenConnect(generation);
}

export function disconnect() {
  shouldConnect = false;
  connectionGeneration += 1;
  clearTimeout(probeTimer);
  probeTimer = null;
  const port = nativePort;
  nativePort = null;
  if (port) {
    try {
      port.disconnect();
    } catch {

    }
  }
  setStatus(false);
}

export function isConnected() {
  return nativePort !== null;
}

export function send(message) {
  if (nativePort) {
    try {
      nativePort.postMessage(message);
    } catch {

    }
  }
}

async function isDaemonUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    await fetch(BRIDGE_HEALTH_URL, {
      signal: controller.signal,
      cache: "no-store",
    });
    return true;
  } catch (err) {
    return err?.name === "AbortError";
  } finally {
    clearTimeout(timer);
  }
}

async function probeThenConnect(generation = connectionGeneration) {
  if (
    !shouldConnect ||
    generation !== connectionGeneration ||
    probesInFlight.has(generation) ||
    isConnected()
  ) {
    return;
  }
  clearTimeout(probeTimer);
  probeTimer = null;

  probesInFlight.add(generation);
  let up = false;
  try {
    up = await isDaemonUp();
  } finally {
    probesInFlight.delete(generation);
  }

  if (!shouldConnect || generation !== connectionGeneration || isConnected())
    return;
  if (up) {
    doConnect(generation);
    return;
  }
  scheduleProbe(generation);
}

function scheduleProbe(generation = connectionGeneration) {
  if (!shouldConnect || generation !== connectionGeneration) return;
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeThenConnect(generation);
  }, PROBE_INTERVAL);
}

function doConnect(generation) {
  if (!shouldConnect || generation !== connectionGeneration || nativePort)
    return;

  let port;
  try {
    port = chrome.runtime.connectNative(STELLA_NATIVE_HOST_NAME);
  } catch (err) {
    console.error("[connection] connectNative failed:", err);
    scheduleProbe(generation);
    return;
  }

  if (!shouldConnect || generation !== connectionGeneration) {
    try {
      port.disconnect();
    } catch {

    }
    return;
  }
  nativePort = port;

  port.onMessage.addListener(async (msg) => {
    if (generation !== connectionGeneration || nativePort !== port) return;

    if (msg.type === "welcome") {
      console.log("[connection] Authenticated, session:", msg.session);
      setStatus(true);
      return;
    }

    if (msg.type === "pong") {
      return;
    }

    if (msg.type === "auth_error") {
      console.error("[connection] Auth failed:", msg.error);
      setStatus(false);
      return;
    }

    if (msg.type === "command" && commandHandler) {
      try {
        const response = await commandHandler(msg);
        if (generation === connectionGeneration && nativePort === port) {
          port.postMessage(response);
        }
      } catch (err) {
        if (generation === connectionGeneration && nativePort === port) {
          port.postMessage({
            type: "response",
            id: msg.id,
            success: false,
            error: err.message || String(err),
          });
        }
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err?.message) {
      console.error("[connection] Native port disconnected:", err.message);
    }
    const wasActive =
      generation === connectionGeneration && nativePort === port;
    if (!wasActive) return;

    nativePort = null;
    setStatus(false);

    probeThenConnect(generation);
  });

  const extensionVersion = chrome.runtime.getManifest().version;
  port.postMessage({
    type: "hello",
    version: extensionVersion,
    extensionVersion,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    token: "",
  });
}

function setStatus(connected) {
  chrome.action.setBadgeText({ text: "" });

  if (statusCallback) {
    statusCallback(connected);
  }
}

chrome.alarms.create("keepalive", { periodInMinutes: 24 / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (isConnected()) {
      send({ type: "ping" });
    } else {

      if (shouldConnect) probeThenConnect(connectionGeneration);
    }
  }
});
