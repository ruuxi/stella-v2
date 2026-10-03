import {
  backendClient,
  readBackendAccountEpoch,
  subscribeBackendAccount,
} from "@/platform/backend/backend-client";

/**
 * Website builds only. An owner who changed Stella's UI on desktop has their
 * own browser renderer at `/chat-app/u/<fork>/<tree>/` (same origin, so the
 * session and storage carry over). Once the backend knows the account, ask
 * which renderer is theirs, remember it for the website's next boot, and move
 * this frame there when it isn't already on it. No renderer of their own
 * means the shared `/chat-app/`.
 */

const STORAGE_KEY = "stella:web-renderer";
const SHARED_BASE = "/chat-app/";

const remember = (base: string | null) => {
  try {
    if (base) window.localStorage.setItem(STORAGE_KEY, base);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the website boots the shared build.
  }
};

const check = async () => {
  let result: { path: string } | null;
  try {
    result = await backendClient.call("appSource.webRenderer", {});
  } catch {
    return; // Not signed in yet, or offline: stay where we are.
  }
  const target = result ? `${SHARED_BASE}${result.path}` : SHARED_BASE;
  const current = new URL("./", window.location.href).pathname;
  if (!current.startsWith(SHARED_BASE)) return;
  if (target === current) {
    remember(result ? target : null);
    return;
  }
  // Only move to a renderer that is really there.
  const index = `${target}index.html`;
  const available = await fetch(index, { method: "HEAD", cache: "no-store" })
    .then((response) => response.ok)
    .catch(() => false);
  if (!available) return;
  remember(result ? target : null);
  window.location.replace(index);
};

export const startWebRendererSwitch = (): void => {
  subscribeBackendAccount(() => void check());
  // The account may have been set before this module loaded.
  if (readBackendAccountEpoch() > 0) void check();
};
