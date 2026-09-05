/** Frame-scoped CDP observations and exact-node refs, including OOPIF targets. */
import {
  ensureDebugger,
  onCdpEvent,
  offCdpEvent,
  getAttachedFrameSessions,
} from "./debugger.js";

const tabs = new Map();
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};
const WORLD = "stella-observation";
let nextRef = 0;
let nextAttachment = 0;

export function frameTarget(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

async function initialize(tabId) {
  await ensureDebugger(tabId);
  let state = tabs.get(tabId);
  if (state) {
    await state.ready;
    return state;
  }
  state = {
    sessions: getAttachedFrameSessions(tabId),
    pending: new Set(),
    refs: new Map(),
    attachmentId: ++nextAttachment,
  };
  tabs.set(tabId, state);
  state.attached = ({ sessionId, targetInfo }) => {
    if (!sessionId || targetInfo?.type !== "iframe") return;
    state.sessions.set(sessionId, targetInfo.targetId);
    const ready = chrome.debugger
      .sendCommand(
        frameTarget(tabId, sessionId),
        "Target.setAutoAttach",
        AUTO_ATTACH,
      )
      .catch(() => undefined)
      .finally(() => state.pending.delete(ready));
    state.pending.add(ready);
  };
  state.detached = ({ sessionId }) => state.sessions.delete(sessionId);
  onCdpEvent(tabId, "Target.attachedToTarget", state.attached);
  onCdpEvent(tabId, "Target.detachedFromTarget", state.detached);
  state.ready = (async () => {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand(
      { tabId },
      "Target.setAutoAttach",
      AUTO_ATTACH,
    );
    for (const sessionId of state.sessions.keys()) {
      await chrome.debugger
        .sendCommand(
          frameTarget(tabId, sessionId),
          "Target.setAutoAttach",
          AUTO_ATTACH,
        )
        .catch(() => undefined);
    }
  })();
  try {
    await state.ready;
  } catch (cause) {
    offCdpEvent(tabId, "Target.attachedToTarget", state.attached);
    offCdpEvent(tabId, "Target.detachedFromTarget", state.detached);
    if (tabs.get(tabId) === state) tabs.delete(tabId);
    throw cause;
  }
  return state;
}

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
chrome.debugger.onDetach.addListener((source) => {
  if (!source.sessionId) {
    const state = tabs.get(source.tabId);
    if (state) {
      offCdpEvent(source.tabId, "Target.attachedToTarget", state.attached);
      offCdpEvent(source.tabId, "Target.detachedFromTarget", state.detached);
    }
    tabs.delete(source.tabId);
  }
});

export async function getObservationFrames(tabId) {
  const state = await initialize(tabId);
  for (let i = 0; state.pending.size && i < 16; i++)
    await Promise.all([...state.pending]);
  const frames = new Map();
  const targets = [null, ...state.sessions.keys()];
  for (const sessionId of targets) {
    let result;
    try {
      result = await chrome.debugger.sendCommand(
        frameTarget(tabId, sessionId),
        "Page.getFrameTree",
      );
    } catch {
      continue;
    }
    const visit = (tree, parentId) => {
      const frame = tree.frame;
      // The dedicated OOPIF session supersedes the placeholder in its parent.
      const previous = frames.get(frame.id);
      frames.set(frame.id, {
        ...frame,
        parentId: frame.parentId || parentId || previous?.parentId,
        sessionId,
      });
      for (const child of tree.childFrames || []) visit(child, frame.id);
    };
    visit(result.frameTree);
  }
  if (!frames.size) throw new Error("No accessible browser frame");
  const root = [...frames.values()].find((frame) => !frame.parentId);
  if (!root)
    throw new Error("Main browser frame disappeared during observation");
  return {
    frames,
    root,
    attachmentId: state.attachmentId,
    documentKey: `${root.id}:${root.loaderId}`,
  };
}

async function frameContext(tabId, frame) {
  const result = await chrome.debugger.sendCommand(
    frameTarget(tabId, frame.sessionId),
    "Page.createIsolatedWorld",
    {
      frameId: frame.id,
      worldName: WORLD,
    },
  );
  return result.executionContextId;
}

export async function evaluateFrame(tabId, frame, expression, byValue = true) {
  const contextId = await frameContext(tabId, frame);
  const response = await chrome.debugger.sendCommand(
    frameTarget(tabId, frame.sessionId),
    "Runtime.evaluate",
    {
      expression,
      contextId,
      returnByValue: byValue,
      awaitPromise: true,
      timeout: 5000,
    },
  );
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text,
    );
  return byValue ? response.result?.value : response.result;
}

export function exactRef(tabId, frame, backendNodeId, metadata = {}) {
  const state = tabs.get(tabId);
  const identity = `${frame.id}:${frame.loaderId}:${backendNodeId}`;
  let ref = state.refs.get(identity);
  if (!ref) {
    ref = `e${++nextRef}`;
    // This cache only stabilizes labels. Eviction cannot redirect an old ref.
    if (state.refs.size >= 5000)
      state.refs.delete(state.refs.keys().next().value);
    state.refs.set(identity, ref);
  }
  return [
    ref,
    {
      ...metadata,
      frameId: frame.id,
      documentId: frame.loaderId,
      sessionId: frame.sessionId,
      attachmentId: state.attachmentId,
      backendNodeId,
      exact: true,
    },
  ];
}

async function validateRef(tabId, ref) {
  await ensureDebugger(tabId);
  if (
    ref.attachmentId !== undefined &&
    tabs.get(tabId)?.attachmentId !== ref.attachmentId
  ) {
    throw new Error(
      "Stale frame ref: debugger connection changed. Take a new snapshot.",
    );
  }
  let result;
  try {
    result = await chrome.debugger.sendCommand(
      frameTarget(tabId, ref.sessionId),
      "Page.getFrameTree",
    );
  } catch {
    throw new Error(
      "Stale frame ref: frame is no longer attached. Take a new snapshot.",
    );
  }
  const found = findFrame(result.frameTree, ref.frameId);
  if (!found || found.loaderId !== ref.documentId) {
    throw new Error(
      "Stale frame ref: document navigated. Take a new snapshot.",
    );
  }
  return { ...found, sessionId: ref.sessionId };
}

/** The frame metadata for `frameId` anywhere in a Page.getFrameTree result. */
function findFrame(tree, frameId) {
  if (tree.frame.id === frameId) return tree.frame;
  for (const child of tree.childFrames || []) {
    const found = findFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}

export async function callExactElement(tabId, resolved, body, options = {}) {
  const ref = resolved.exactNode || resolved;
  const frame = await validateRef(tabId, ref);
  const target = frameTarget(tabId, frame.sessionId);
  const executionContextId = await frameContext(tabId, frame);
  let objectId;
  try {
    const result = await chrome.debugger.sendCommand(
      target,
      "DOM.resolveNode",
      { backendNodeId: ref.backendNodeId, executionContextId },
    );
    objectId = result.object?.objectId;
    if (!objectId) throw new Error("Node is no longer available");
    const response = await chrome.debugger.sendCommand(
      target,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() { const el = this; if (!el.isConnected || el.ownerDocument !== document) throw new Error('Stale element ref: node detached or document changed. Take a new snapshot.'); ${body} }`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: options.userGesture === true,
      },
    );
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text,
      );
    return response.result?.value;
  } catch (cause) {
    throw new Error(`Exact frame element unavailable: ${cause.message}`);
  } finally {
    if (objectId)
      await chrome.debugger
        .sendCommand(target, "Runtime.releaseObject", { objectId })
        .catch(() => undefined);
  }
}

async function frameOwner(tabId, frame, frames) {
  const parent = frames.get(frame.parentId);
  if (!parent) throw new Error("Ancestor frame unavailable");
  const result = await chrome.debugger.sendCommand(
    frameTarget(tabId, parent.sessionId),
    "DOM.getFrameOwner",
    { frameId: frame.id },
  );
  return {
    frameId: parent.id,
    documentId: parent.loaderId,
    sessionId: parent.sessionId,
    backendNodeId: result.backendNodeId,
  };
}

const VISIBLE = `
  for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
    const style = getComputedStyle(node);
    if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
  }
  return el.getClientRects().length > 0;
`;

/**
 * Yield the owner-element ref of `frame` and of each ancestor frame in turn,
 * innermost first, stopping at the main frame. Lazy so callers can stop at
 * the first ancestor that fails a check.
 */
async function* frameOwners(tabId, frame, frames) {
  const visited = new Set();
  while (frame.parentId) {
    if (visited.has(frame.id)) throw new Error("Cyclic frame ancestry");
    visited.add(frame.id);
    yield await frameOwner(tabId, frame, frames);
    frame = frames.get(frame.parentId);
  }
}

export async function frameVisible(tabId, frame, frames) {
  for await (const owner of frameOwners(tabId, frame, frames)) {
    if (!(await callExactElement(tabId, owner, VISIBLE))) return false;
  }
  return true;
}

/** Convert a frame-local point through each ancestor, checking occlusion. */
export async function exactElementPoint(
  tabId,
  resolved,
  { boxOnly = false, scroll = !boxOnly } = {},
) {
  const ref = resolved.exactNode || resolved;
  const { frames } = await getObservationFrames(tabId);
  let frame = frames.get(ref.frameId);
  if (!frame || frame.loaderId !== ref.documentId)
    throw new Error("Stale frame ref. Take a new snapshot.");
  const owners = [];
  for await (const owner of frameOwners(tabId, frame, frames))
    owners.push(owner);
  for (const owner of scroll ? [...owners].reverse() : []) {
    await callExactElement(
      tabId,
      owner,
      "el.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true;",
    );
  }
  let point = await callExactElement(
    tabId,
    ref,
    `
    if (${scroll}) el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Element has no clickable area');
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
    if (!${boxOnly} && (!hit || hit !== el && !el.contains(hit))) throw new Error('Element is occluded');
    return {x,y,left:rect.left,top:rect.top,width:rect.width,height:rect.height};
  `,
  );
  for (const owner of owners) {
    const geometry = await callExactElement(
      tabId,
      owner,
      `
      for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
        const style = getComputedStyle(node);
        if (style.transform !== 'none' || !['1','normal'].includes(style.zoom)) throw new Error('Transformed or zoomed iframe geometry is not supported');
      }
      const rect = el.getBoundingClientRect();
      const x = rect.left + el.clientLeft + ${point.x};
      const y = rect.top + el.clientTop + ${point.y};
      const hit = document.elementFromPoint(x,y);
      if (!${boxOnly} && hit !== el) throw new Error('Ancestor iframe is hidden or occluded: ' + JSON.stringify({x,y,rect:rect.toJSON(),viewport:[innerWidth,innerHeight],hit:hit?.tagName}));
      return {x,y,dx:rect.left + el.clientLeft,dy:rect.top + el.clientTop};
    `,
    );
    point = {
      ...point,
      x: geometry.x,
      y: geometry.y,
      left: point.left + geometry.dx,
      top: point.top + geometry.dy,
    };
  }
  return point;
}
