const STORAGE_KEY = 'stella_site_mods';
const CONTENT_SCRIPT_ID = 'stella-site-mods';

async function getMods() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveMods(mods) {
  await chrome.storage.local.set({ [STORAGE_KEY]: mods });
  await syncContentScriptRegistration(mods);
}

function globToMatchPattern(pattern) {

  if (/^[a-z]+:\/\//.test(pattern)) {
    return pattern;
  }

  const p = pattern.includes('/') ? pattern : pattern + '/*';
  return `*://${p}`;
}

export async function syncContentScriptRegistration(mods) {
  if (!mods) {
    mods = await getMods();
  }

  const enabledPatterns = Object.entries(mods)
    .filter(([, mod]) => mod.enabled)
    .map(([pattern]) => globToMatchPattern(pattern));

  try {
    if (enabledPatterns.length === 0) {

      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      return;
    }

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: enabledPatterns,
      }]);
    } else {
      await chrome.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: enabledPatterns,
        js: ['site-mods.js'],
        runAt: 'document_start',
      }]);
    }
  } catch (err) {
    console.warn('[site-mods] Failed to sync content script registration:', err);
  }
}

export async function handleSiteModSet(command) {
  const { pattern, css, js, label } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_set');
  if (!css && !js) throw new Error('At least one of css or js is required');

  const mods = await getMods();
  const existing = mods[pattern] || {};

  mods[pattern] = {
    css: css !== undefined ? css : (existing.css || null),
    js: js !== undefined ? js : (existing.js || null),
    label: label !== undefined ? label : (existing.label || null),
    enabled: true,
    updatedAt: Date.now(),
  };

  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, mod: mods[pattern], total: Object.keys(mods).length },
  };
}

export async function handleSiteModList(command) {
  const mods = await getMods();

  const rules = Object.entries(mods).map(([pattern, mod]) => ({
    pattern,
    label: mod.label || null,
    hasCSS: !!mod.css,
    hasJS: !!mod.js,
    enabled: mod.enabled,
    updatedAt: mod.updatedAt || null,
  }));

  return {
    id: command.id,
    success: true,
    data: { rules, total: rules.length },
  };
}

export async function handleSiteModRemove(command) {
  const { pattern } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_remove');

  const mods = await getMods();
  const existed = pattern in mods;
  delete mods[pattern];
  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, removed: existed, total: Object.keys(mods).length },
  };
}

export async function handleSiteModToggle(command) {
  const { pattern, enabled } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_toggle');

  const mods = await getMods();
  if (!(pattern in mods)) throw new Error(`No site mod found for pattern: ${pattern}`);

  mods[pattern].enabled = enabled !== undefined ? enabled : !mods[pattern].enabled;
  mods[pattern].updatedAt = Date.now();
  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, enabled: mods[pattern].enabled },
  };
}
