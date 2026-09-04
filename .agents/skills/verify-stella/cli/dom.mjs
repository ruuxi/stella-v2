// Serialized into the owned renderer. Keep this factory free of module dependencies.
export function createDomTools() {
  const visible = (el) => {
    if (!(el instanceof Element) || el.closest('[inert], [aria-hidden="true"]')) return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const roleOf = (el) => el.getAttribute('role') || ({
    BUTTON: 'button', A: 'link', TEXTAREA: 'textbox', SELECT: 'combobox',
    INPUT: ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox', button: 'button', submit: 'button' }[el.type] || 'textbox'),
  }[el.tagName] || el.tagName.toLowerCase());
  const nameOf = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    return (labelled || el.getAttribute('aria-label') ||
      (el.labels ? [...el.labels].map((label) => label.textContent).join(' ') : '') ||
      el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '')
      .replace(/\s+/g, ' ').trim();
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return { role: roleOf(el), name: nameOf(el).slice(0, 160),
      id: el.id || null, testId: el.getAttribute('data-testid'), tag: el.tagName.toLowerCase(),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  };
  const controls = 'button, a, input, textarea, select, [role], [aria-label], [placeholder], [data-testid]';
  const find = ({ role, name, placeholder, selector, text, within, unique = true }) => {
    const scopes = within ? [...document.querySelectorAll(within)].filter(visible) : [document];
    const matches = [...new Set(scopes.flatMap((scope) => [...scope.querySelectorAll(selector || (text ? '*' : controls))]))]
      .filter((el) => visible(el) && (!role || roleOf(el) === role) && (!name || nameOf(el) === name) &&
        (!placeholder || el.getAttribute('placeholder') === placeholder) &&
        (!text || nameOf(el).includes(text)) && Boolean(selector || role || name || placeholder || text));
    if (!matches.length || (unique && matches.length > 1)) {
      throw new Error('STELLA_TARGET:' + JSON.stringify({
        code: matches.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
        message: matches.length ? `${matches.length} visible controls match; narrow the target with --within or --selector.` : 'No visible control matches the query.',
        count: matches.length, candidates: matches.slice(0, 20).map(describe),
      }));
    }
    return matches[0];
  };
  const components = () => [...document.querySelectorAll(controls)].filter(visible).map(describe);
  const chat = (text, conversationId) => {
    const surfaces = [...document.querySelectorAll('[data-testid="chat-surface"]')]
      .filter((el) => visible(el) && el.getAttribute('data-conversation-id') === conversationId);
    if (surfaces.length !== 1) return { surfaceFound: false, matchingMessageIds: [], notices: [], composerCleared: false };
    const surface = surfaces[0];
    // Include mounted offscreen rows in the baseline, but only visible rows as evidence.
    const rows = [...surface.querySelectorAll('.event-row--user[data-chat-row-id]')];
    const matching = rows.filter((row) => (row.querySelector('.event-item.user')?.textContent || '').trim() === text.trim());
    const composers = [...surface.querySelectorAll('textarea.composer-input')].filter(visible);
    return { surfaceFound: true,
      matchingMessageIds: matching.filter(visible).map((row) => row.getAttribute('data-chat-row-id')),
      mountedMatchingMessageIds: matching.map((row) => row.getAttribute('data-chat-row-id')),
      composerCleared: composers.length === 1 && composers[0].value.length === 0,
      notices: [...surface.querySelectorAll('[role="alert"], [data-testid="composer-notice"]')]
        .filter(visible).map((el) => ({ role: el.getAttribute('role'), text: (el.innerText || el.textContent || '').trim().slice(0, 2000) })),
    };
  };
  return { visible, find, components, chat };
}

export const DOM_TOOLS_JS = `(${createDomTools.toString()})()`;

export function compareObservations(before, after) {
  const state = Object.fromEntries([...new Set([...Object.keys(before.state), ...Object.keys(after.state)])]
    .filter((key) => JSON.stringify(before.state[key]) !== JSON.stringify(after.state[key]))
    .map((key) => [key, { before: before.state[key], after: after.state[key] }]));
  // Multiset comparison preserves duplicate controls. Geometry changes appear as removal/addition.
  const difference = (left, right) => {
    const remaining = right.map((item) => JSON.stringify(item));
    return left.filter((item) => {
      const index = remaining.indexOf(JSON.stringify(item));
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
  };
  return { state, ...(before.accessibility && after.accessibility ? { accessibilityChanged: JSON.stringify(before.accessibility) !== JSON.stringify(after.accessibility) } : {}), addedControls: difference(after.components, before.components), removedControls: difference(before.components, after.components) };
}
