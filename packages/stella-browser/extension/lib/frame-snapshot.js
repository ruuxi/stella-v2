import { executeSnapshot } from "./snapshot.js";
import {
  exactRef,
  evaluateFrame,
  frameTarget,
  frameVisible,
  getObservationFrames,
} from "./frame-elements.js";

const MAX_CHARS = 20_000;
const MAX_NODES = 200;
const MAX_FRAMES = 32;
const CONTENT_BUDGET = MAX_CHARS - 2048;
const quote = (value) => JSON.stringify(String(value ?? "").slice(0, 1000));
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

async function domFrame(tabId, frame, options) {
  const registry = JSON.stringify(`__stellaSnapshot_${crypto.randomUUID()}`);
  const capture = await evaluateFrame(
    tabId,
    frame,
    `(() => {
    globalThis[${registry}] = new Map();
    try { return (${executeSnapshot.toString()})({...${JSON.stringify(options)}, traverseFrames:false,
      onRef:(ref,el)=>globalThis[${registry}].set(ref,el)}); }
    catch (error) { delete globalThis[${registry}]; throw error; }
  })()`,
  );
  const refs = {};
  const renamed = new Map();
  try {
    // Bound outstanding CDP requests while resolving exact nodes, not role matches.
    const entries = Object.entries(capture.refs || {});
    for (let offset = 0; offset < entries.length; offset += 12) {
      await Promise.all(
        entries.slice(offset, offset + 12).map(async ([oldRef, data]) => {
          const object = await evaluateFrame(
            tabId,
            frame,
            `globalThis[${registry}].get(${JSON.stringify(oldRef)})`,
            false,
          );
          if (!object?.objectId) return;
          try {
            const { node } = await chrome.debugger.sendCommand(
              frameTarget(tabId, frame.sessionId),
              "DOM.describeNode",
              { objectId: object.objectId },
            );
            const [ref, exact] = exactRef(
              tabId,
              frame,
              node.backendNodeId,
              data,
            );
            refs[ref] = exact;
            renamed.set(oldRef, ref);
          } finally {
            await chrome.debugger
              .sendCommand(
                frameTarget(tabId, frame.sessionId),
                "Runtime.releaseObject",
                { objectId: object.objectId },
              )
              .catch(() => undefined);
          }
        }),
      );
    }
  } finally {
    await evaluateFrame(tabId, frame, `delete globalThis[${registry}]`).catch(
      () => undefined,
    );
  }
  const tree = capture.tree.replace(/\[ref=(e\d+)\]/g, (_, ref) =>
    renamed.has(ref) ? `[ref=${renamed.get(ref)}]` : "[unavailable]",
  );
  return { tree, refs, truncated: capture.truncated };
}

async function axFrame(tabId, frame, options) {
  const target = frameTarget(tabId, frame.sessionId);
  await chrome.debugger.sendCommand(target, "Accessibility.enable");
  const { nodes } = await chrome.debugger.sendCommand(
    target,
    "Accessibility.getFullAXTree",
    { frameId: frame.id },
  );
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let selectedRoot;
  if (options.selector) {
    const object = await evaluateFrame(
      tabId,
      frame,
      `document.querySelector(${JSON.stringify(options.selector)})`,
      false,
    );
    if (!object?.objectId)
      throw new Error(`AX snapshot selector not found: ${options.selector}`);
    try {
      const { node } = await chrome.debugger.sendCommand(
        target,
        "DOM.describeNode",
        { objectId: object.objectId },
      );
      selectedRoot = nodes.find(
        (item) => item.backendDOMNodeId === node.backendNodeId,
      );
      if (!selectedRoot)
        throw new Error("Selected element has no accessibility subtree");
    } finally {
      await chrome.debugger
        .sendCommand(target, "Runtime.releaseObject", {
          objectId: object.objectId,
        })
        .catch(() => undefined);
    }
  }
  const refs = {};
  const lines = [];
  const visited = new Set();
  let truncated = false;
  let chars = 0;
  const visit = async (node, depth) => {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (lines.length >= MAX_NODES || chars >= MAX_CHARS) {
      truncated = true;
      return;
    }
    if (options.maxDepth != null && depth > options.maxDepth) {
      truncated = true;
      return;
    }
    let nextDepth = depth;
    const role = node.role?.value || "unknown";
    const name = node.name?.value || "";
    const include =
      !node.ignored &&
      role !== "InlineTextBox" &&
      (!options.interactive || INTERACTIVE.has(role)) &&
      !(
        options.compact &&
        !name &&
        ["generic", "group", "LabelText"].includes(role)
      );
    let protectedNode = false;
    // Inspect only nodes inside the bounded output. Chrome normally masks
    // passwords, but do not depend on that behavior or print their descendants.
    if (
      !node.ignored &&
      ["textbox", "searchbox"].includes(role) &&
      node.backendDOMNodeId
    ) {
      const result = await chrome.debugger.sendCommand(
        target,
        "DOM.describeNode",
        { backendNodeId: node.backendDOMNodeId },
      );
      const attrs = result.node.attributes || [];
      for (let i = 0; i < attrs.length; i += 2)
        if (attrs[i] === "type" && attrs[i + 1].toLowerCase() === "password")
          protectedNode = true;
    }
    if (include) {
      let line = `${"  ".repeat(Math.min(depth, 40))}- ${role}${name ? ` ${quote(name)}` : ""}`;
      let entry;
      if (
        node.backendDOMNodeId &&
        role !== "RootWebArea" &&
        role !== "StaticText" &&
        role !== "InlineTextBox"
      ) {
        entry = exactRef(tabId, frame, node.backendDOMNodeId, {
          role,
          name: String(name).slice(0, 1000),
        });
        line += ` [ref=${entry[0]}]`;
      }
      if (protectedNode) line += " [protected]";
      else if (node.value?.value !== undefined && node.value.value !== "")
        line += ` [value=${quote(node.value.value)}]`;
      for (const property of node.properties || []) {
        if (
          [
            "checked",
            "disabled",
            "expanded",
            "selected",
            "required",
            "level",
            "busy",
            "pressed",
            "focused",
          ].includes(property.name)
        ) {
          line += ` [${property.name}=${quote(property.value?.value)}]`;
        }
      }
      if (chars + line.length + 1 > MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
      chars += line.length + 1;
      if (entry) refs[entry[0]] = entry[1];
      nextDepth += 1;
    }
    if (!protectedNode)
      for (const child of node.childIds || [])
        await visit(byId.get(child), nextDepth);
  };
  if (selectedRoot) await visit(selectedRoot, 0);
  else
    for (const node of nodes)
      if (!node.parentId || !byId.has(node.parentId)) await visit(node, 0);
  return { tree: lines.join("\n"), refs, truncated };
}

export async function captureFrameSnapshot(tabId, options = {}, kind = "dom") {
  const { frames, root, attachmentId } = await getObservationFrames(tabId);
  const lines = [];
  const refs = {};
  const coverage = [];
  let chars = 0;
  let emittedNodes = 0;
  let truncated = false;
  const ordered = [];
  const visit = (frame) => {
    if (ordered.some((item) => item.id === frame.id)) return;
    ordered.push(frame);
    for (const child of frames.values())
      if (child.parentId === frame.id) visit(child);
  };
  visit(root);
  for (const frame of ordered) {
    if (coverage.length >= MAX_FRAMES) {
      truncated = true;
      break;
    }
    const label = `frame ${frame.id}${frame.parentId ? ` parent=${frame.parentId}` : " main"} url=${quote(frame.url)}`;
    if (options.selector && frame.id !== root.id) {
      coverage.push({
        frameId: frame.id,
        status: "omitted",
        reason: "selector-scoped snapshot",
      });
      continue;
    }
    try {
      if (!(await frameVisible(tabId, frame, frames))) {
        coverage.push({ frameId: frame.id, status: "hidden" });
        continue;
      }
      const capture = await (kind === "ax" ? axFrame : domFrame)(
        tabId,
        frame,
        options,
      );
      const heading = `# ${label}`;
      if (chars + heading.length + 1 > CONTENT_BUDGET) {
        truncated = true;
        break;
      }
      lines.push(heading);
      chars += heading.length + 1;
      for (const line of capture.tree.split("\n")) {
        if (
          chars + line.length + 1 > CONTENT_BUDGET ||
          emittedNodes >= MAX_NODES
        ) {
          truncated = true;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
        emittedNodes += 1;
        for (const match of line.matchAll(/\[ref=(e\d+)\]/g))
          if (capture.refs[match[1]]) refs[match[1]] = capture.refs[match[1]];
      }
      truncated ||= capture.truncated;
      coverage.push({
        frameId: frame.id,
        parentId: frame.parentId,
        url: String(frame.url).slice(0, 2048),
        status: "included",
      });
    } catch (cause) {
      if (frame.id === root.id) throw cause;
      coverage.push({
        frameId: frame.id,
        parentId: frame.parentId,
        url: String(frame.url).slice(0, 2048),
        status: "inaccessible",
        reason: String(cause.message).slice(0, 200),
      });
    }
    if (chars >= CONTENT_BUDGET || emittedNodes >= MAX_NODES) {
      truncated = true;
      break;
    }
  }
  // Reject captures spanning a document replacement rather than publish wrong refs.
  const after = await getObservationFrames(tabId);
  if (after.attachmentId !== attachmentId)
    throw new Error(
      "Debugger connection changed during snapshot. Retry observation.",
    );
  for (const frame of ordered) {
    if (
      coverage.some(
        (entry) => entry.frameId === frame.id && entry.status === "included",
      ) &&
      after.frames.get(frame.id)?.loaderId !== frame.loaderId
    )
      throw new Error("Frame navigated during snapshot. Retry observation.");
  }
  const metadata = {
    truncated,
    totalFrames: ordered.length,
    observedFrames: coverage.length,
    maxFrames: MAX_FRAMES,
    emittedNodes,
    maxNodes: MAX_NODES,
    maxChars: MAX_CHARS,
    frames: coverage,
  };
  const summary = coverage
    .filter((frame) => frame.status !== "included")
    .map(
      (frame) =>
        `${frame.frameId}:${frame.status}${frame.reason ? ` ${quote(frame.reason)}` : ""}`,
    )
    .join("; ")
    .slice(0, 1800);
  lines.push(
    `[snapshot metadata: truncated=${truncated}; frames=${coverage.length}/${ordered.length}${summary ? `; ${summary}` : ""}]`,
  );
  const documentKey =
    `${attachmentId}|` +
    ordered
      .filter((frame) =>
        coverage.some(
          (entry) => entry.frameId === frame.id && entry.status === "included",
        ),
      )
      .map((frame) => `${frame.id}:${frame.loaderId}`)
      .sort()
      .join("|");
  return { snapshot: lines.join("\n"), refs, documentKey, metadata };
}
