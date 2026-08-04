/**
 * Resolves a DOM element back to the React component and source file that
 * rendered it, for the "select area" context chip.
 *
 * This replaces the `react-grab` dependency, which shipped a 307 KiB chunk and
 * a full selection UI (toolbar, hover labels, drag box, React-update freezing,
 * devtools-hook instrumentation) to expose the two calls Stella actually used:
 * `getSource` and `getStackContext`. Stella already owns the picker overlay,
 * the ring, and the payload shape, so all that was needed is the fiber walk —
 * and because we own the whole environment (one Electron renderer, one React
 * tree, Vite dev server) it can be much more direct than a library that has to
 * cope with Next.js, RSC, webpack, and server components.
 *
 * How it works:
 *
 *  - React tags every host node with a `__reactFiber$<random>` own property,
 *    so the fiber is one `Object.keys` scan away.
 *  - The `_debugOwner` chain gives the component stack — who rendered whom —
 *    which is more useful than the `return` chain because it skips the host
 *    elements and context providers nobody wrote by hand.
 *  - React 19 dropped `_debugSource` (the `__source` object the JSX transform
 *    passes to `jsxDEV` is accepted and discarded), leaving `_debugStack` — an
 *    `Error` captured at element creation — as the only source-position
 *    record. Its frames are in *generated* coordinates, so they are mapped
 *    back through the module's inline source map.
 *
 * All of this is dev-only by construction: a production React build has no
 * `_debugOwner` and no `_debugStack`, so there is nothing to read. That was
 * true of `react-grab` too, which meant its 307 KiB shipped to users to do
 * nothing. Here the whole module is behind `import.meta.env.DEV` at the call
 * site and tree-shakes out of the production bundle.
 */
import { originalPositionFor } from "./inline-source-map";
/** Guards against pathological trees; real owner chains are far shorter. */
const MAX_OWNER_DEPTH = 24;
/** Frames rendered into the `stack` field of the payload. */
const MAX_STACK_ENTRIES = 12;
const FIBER_KEY_PREFIXES = ["__reactFiber$", "__reactInternalInstance$"];
/**
 * Finds the fiber for `element`, walking up to ancestors when the element
 * itself is not a React host node (portals, text wrappers, and anything a
 * third-party script injected mid-tree).
 */
const findFiber = (element) => {
    let node = element;
    while (node) {
        // Own enumerable properties only — React installs the fiber key directly
        // on the node, so this avoids walking the whole DOM prototype chain.
        for (const key of Object.keys(node)) {
            if (FIBER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
                const fiber = node[key];
                if (fiber)
                    return fiber;
            }
        }
        node = node.parentElement;
    }
    return null;
};
/**
 * Human-readable name for a fiber's `type`. Host elements ("div") return null
 * so they never occupy a slot in the component stack; wrappers (memo,
 * forwardRef, lazy) are unwrapped to the component they carry.
 */
const componentNameOfType = (type, depth = 0) => {
    if (!type || depth > 4)
        return null;
    if (typeof type === "function") {
        const fn = type;
        return fn.displayName || fn.name || null;
    }
    if (typeof type === "object") {
        const wrapper = type;
        if (wrapper.displayName)
            return wrapper.displayName;
        if (wrapper.render)
            return componentNameOfType(wrapper.render, depth + 1);
        if (wrapper.type)
            return componentNameOfType(wrapper.type, depth + 1);
        if (wrapper._payload?._result) {
            return componentNameOfType(wrapper._payload._result, depth + 1);
        }
    }
    return null;
};
/**
 * Modules that are never what the user meant to select: React internals, the
 * dev-server client, and anything Vite pre-bundled out of node_modules.
 */
const isApplicationModule = (url) => {
    if (!url)
        return false;
    if (!/^https?:|^file:/.test(url))
        return false;
    if (url.includes("/node_modules/"))
        return false;
    if (url.includes("/.vite/deps/"))
        return false;
    if (url.includes("/@vite/"))
        return false;
    if (url.includes("/@react-refresh"))
        return false;
    if (url.includes("/@fs/"))
        return false;
    return /\.[cm]?[jt]sx?(\?|$)/.test(url);
};
/**
 * Pulls the first application frame out of a V8 stack string.
 *
 * Chromium renders frames as `    at Name (url:line:col)` or, for anonymous
 * functions, `    at url:line:col`. The frames above the JSX call site belong
 * to `react-jsx-dev-runtime` and `react-dom`, so the first frame that survives
 * `isApplicationModule` is the code that wrote the element.
 */
const firstApplicationFrame = (stack) => {
    if (typeof stack !== "string")
        return null;
    for (const rawLine of stack.split("\n")) {
        const match = rawLine.match(/\((.+):(\d+):(\d+)\)\s*$/) ??
            rawLine.match(/at\s+(.+):(\d+):(\d+)\s*$/);
        if (!match)
            continue;
        const moduleUrl = match[1];
        if (!isApplicationModule(moduleUrl))
            continue;
        return {
            moduleUrl,
            line: Number(match[2]),
            column: Number(match[3]),
        };
    }
    return null;
};
const stackStringOf = (fiber) => {
    const debugStack = fiber._debugStack;
    if (debugStack instanceof Error)
        return debugStack.stack;
    if (typeof debugStack === "string")
        return debugStack;
    return null;
};
/**
 * Rewrites an absolute module path to a repo-relative one, so the agent can
 * open it directly. Vite serves renderer modules by their real path, so both
 * the frame URLs and the source-map `sources` land inside `desktop/src`.
 */
const toRepoRelativePath = (rawPath) => {
    let path = rawPath;
    try {
        path = decodeURI(path);
    }
    catch {
        // Leave the path as-is if it carries invalid escapes.
    }
    path = path.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
    path = path.replace(/^file:\/\//, "");
    const desktopIndex = path.lastIndexOf("/desktop/src/");
    if (desktopIndex !== -1)
        return path.slice(desktopIndex + 1);
    const runtimeIndex = path.lastIndexOf("/runtime/");
    if (runtimeIndex !== -1)
        return path.slice(runtimeIndex + 1);
    const srcIndex = path.lastIndexOf("/src/");
    if (srcIndex !== -1)
        return `desktop${path.slice(srcIndex)}`;
    return path.replace(/^\//, "");
};
/**
 * Turns a generated frame into an original file/line. Falls back to the
 * generated module path (without a line) when the map is unavailable — a file
 * with no line is still useful context, whereas a wrong line is actively
 * misleading.
 */
const resolveFramePosition = async (frame) => {
    const original = await originalPositionFor(frame.moduleUrl, frame.line, frame.column);
    if (!original)
        return { filePath: toRepoRelativePath(frame.moduleUrl) };
    return {
        filePath: toRepoRelativePath(original.source),
        lineNumber: original.line,
    };
};
/**
 * Walks the `_debugOwner` chain from `fiber` outward, collecting the
 * components that rendered it. Consecutive duplicates are dropped: wrappers
 * that re-render the same component (memo, forwardRef) otherwise repeat.
 */
const collectOwners = (fiber) => {
    const entries = [];
    let current = fiber;
    let depth = 0;
    while (current && depth < MAX_OWNER_DEPTH) {
        const componentName = componentNameOfType(current.type ?? current.elementType);
        if (componentName && entries[entries.length - 1]?.componentName !== componentName) {
            entries.push({
                componentName,
                frame: firstApplicationFrame(stackStringOf(current)),
            });
        }
        current = current._debugOwner;
        depth += 1;
    }
    return entries;
};
/**
 * Renders the owner chain as a component stack, mirroring React's own
 * `in <Component>` idiom and appending the source position when it resolves.
 */
const formatStack = (owners, positions) => owners
    .map((owner, index) => {
    const position = positions[index];
    if (!position)
        return `    in ${owner.componentName}`;
    const location = typeof position.lineNumber === "number"
        ? `${position.filePath}:${position.lineNumber}`
        : position.filePath;
    return `    in ${owner.componentName} (${location})`;
})
    .join("\n");
/**
 * Resolves the component name, source location, and component stack for a
 * selected element. Returns null when React is running a production build (no
 * debug fields) or the element sits outside the React tree.
 */
export const resolveReactSource = async (element) => {
    const fiber = findFiber(element);
    if (!fiber)
        return null;
    const owners = collectOwners(fiber);
    // The element's own `_debugStack` points at the JSX that created it; when
    // that is missing (host fibers do not always carry one) the nearest owner's
    // creation site is the closest honest answer.
    const ownFrame = firstApplicationFrame(stackStringOf(fiber));
    const primaryFrame = ownFrame ?? owners[0]?.frame ?? null;
    // React <=18 handed us the original position outright; prefer it and skip
    // the source-map round trip entirely.
    const legacySource = fiber._debugSource;
    const legacyPosition = legacySource?.fileName
        ? {
            filePath: toRepoRelativePath(legacySource.fileName),
            ...(typeof legacySource.lineNumber === "number"
                ? { lineNumber: legacySource.lineNumber }
                : {}),
        }
        : null;
    // One pass over the distinct modules involved; `originalPositionFor`
    // memoizes per URL, so the stack frames mostly hit an already-decoded map.
    const [primaryPosition, ownerPositions] = await Promise.all([
        legacyPosition ??
            (primaryFrame ? resolveFramePosition(primaryFrame) : Promise.resolve(null)),
        Promise.all(owners
            .slice(0, MAX_STACK_ENTRIES)
            .map((owner) => owner.frame ? resolveFramePosition(owner.frame) : Promise.resolve(null))),
    ]);
    const componentName = owners[0]?.componentName;
    const stack = owners.length > 0 ? formatStack(owners.slice(0, MAX_STACK_ENTRIES), ownerPositions) : "";
    const result = {};
    if (primaryPosition?.filePath)
        result.filePath = primaryPosition.filePath;
    if (typeof primaryPosition?.lineNumber === "number") {
        result.lineNumber = primaryPosition.lineNumber;
    }
    if (componentName)
        result.componentName = componentName;
    if (stack.trim())
        result.stack = stack;
    return Object.keys(result).length > 0 ? result : null;
};
