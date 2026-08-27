function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function getMatchTarget(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + path;
  } catch {
    return null;
  }
}

function injectCSS(css, pattern) {
  const style = document.createElement('style');
  style.setAttribute('data-stella-mod', pattern);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function injectJS(js, pattern) {
  const script = document.createElement('script');
  script.setAttribute('data-stella-mod', pattern);
  script.textContent = `try{${js}}catch(e){console.warn("[stella-mod] Error in mod \\""+${JSON.stringify(pattern)}+"\\":",e)}`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function removeAllMods() {
  document.querySelectorAll('[data-stella-mod]').forEach(el => el.remove());
}

async function applySiteMods() {
  const target = getMatchTarget(location.href);
  if (!target) return;

  let data;
  try {
    data = await chrome.storage.local.get('stella_site_mods');
  } catch {
    return;
  }

  const mods = data.stella_site_mods;
  if (!mods || typeof mods !== 'object') return;

  for (const [pattern, mod] of Object.entries(mods)) {
    if (!mod.enabled) continue;
    if (!patternToRegex(pattern).test(target)) continue;

    if (mod.css) {
      injectCSS(mod.css, pattern);
    }
    if (mod.js) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => injectJS(mod.js, pattern), { once: true });
      } else {
        injectJS(mod.js, pattern);
      }
    }
  }
}

let lastUrl = location.href;

function onUrlChange() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  removeAllMods();
  applySiteMods();
}

function hookHistoryNavigation() {
  try {
    chrome.runtime.sendMessage({ type: 'hookHistory', tabId: null });
  } catch {

  }
}

window.addEventListener('stella:urlchange', onUrlChange);
window.addEventListener('popstate', () => setTimeout(onUrlChange, 0));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stella_site_mods) {
    removeAllMods();
    applySiteMods();
  }
});

applySiteMods();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hookHistoryNavigation, { once: true });
} else {
  hookHistoryNavigation();
}
