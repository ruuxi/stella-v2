type StaticGreeting = { kind: "time" } | { kind: "fun"; text: string };

declare global {
  interface Window {
    __stellaStaticGreeting?: StaticGreeting;
    __stellaStaticHomeKeepInput?: (event: FocusEvent) => void;
    __stellaStaticHandoff?: {
      at: number;
      target: "home" | "chat" | "none";
      chars: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
    };
  }
}

const SHELL_ID = "stella-static-home";
const ROOT_SNAPSHOT_KEY = "stella:static-home:root";
const ROOT_ATTRIBUTES = ["class", "style", "dir", "data-theme", "data-base-theme", "data-shell-panel-chrome", "data-reduce-motion", "data-stella-locale", "data-stella-text-dir"];
const SNAPSHOT_DELAY_MS = 2000;

const saveRootSnapshot = () => {
  const root = document.documentElement;
  const snapshot: Record<string, string> = {};
  for (const name of ROOT_ATTRIBUTES) {
    const value = root.getAttribute(name);
    if (value !== null) snapshot[name] = value;
  }
  try {
    window.localStorage.setItem(ROOT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    return;
  }
};
const CHAT_FALLBACK_MS = 1500;
const GIVE_UP_MS = 20_000;
const GUARD_MS = 15_000;
const SETTLED_MS = 2000;
const LEAVE_MS = 200;

const setNativeValue = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

const usable = (field: HTMLTextAreaElement) =>
  !field.disabled && field.offsetParent !== null && !field.closest("[inert]");

const homeComposer = () =>
  [...document.querySelectorAll<HTMLTextAreaElement>("#root .full-body-main--home textarea.chat-composer-textarea")].find(usable) ??
  null;

const anyComposer = () =>
  homeComposer() ??
  [...document.querySelectorAll<HTMLTextAreaElement>("#root textarea.chat-composer-textarea")].find(usable) ??
  null;

export function adoptStaticHome(): void {
  const shell = document.getElementById(SHELL_ID);
  const draft = shell?.querySelector("textarea");
  if (!shell || !draft) return;
  const startedAt = performance.now();
  let chatSince: number | null = null;

  const stopKeepingInput = () => {
    const keepInput = window.__stellaStaticHomeKeepInput;
    if (keepInput) document.removeEventListener("focusin", keepInput, true);
    window.__stellaStaticHomeKeepInput = undefined;
  };

  const release = () => {
    stopKeepingInput();
    shell.dataset.leaving = "true";
    window.setTimeout(() => shell.remove(), LEAVE_MS);
  };

  const place = (field: HTMLTextAreaElement, text: string, focused: boolean, start: number, end: number) => {
    if (text && !field.value.startsWith(text)) setNativeValue(field, text + field.value);
    if (!focused) return;
    field.focus({ preventScroll: true });
    try {
      field.setSelectionRange(start, end);
    } catch {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  };

  const guard = (text: string, focused: boolean) => {
    let shadow = text;
    let lastWipe = performance.now();
    const until = performance.now() + GUARD_MS;
    const isComposer = (target: EventTarget | null): target is HTMLTextAreaElement =>
      target instanceof HTMLTextAreaElement && target.matches("#root textarea.chat-composer-textarea");
    const restore = (field: HTMLTextAreaElement) => {
      setNativeValue(field, shadow);
      lastWipe = performance.now();
      if (focused) {
        field.focus({ preventScroll: true });
        field.setSelectionRange(shadow.length, shadow.length);
      }
    };
    const onBeforeInput = (event: Event) => {
      if (isComposer(event.target) && shadow && event.target.value === "") restore(event.target);
    };
    const onInput = (event: Event) => {
      if (event.isTrusted && isComposer(event.target)) shadow = event.target.value;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isComposer(event.target) && event.key === "Enter" && !event.shiftKey && !event.isComposing) shadow = "";
    };
    const onSubmit = () => {
      shadow = "";
    };
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("submit", onSubmit, true);
    const check = () => {
      const field = anyComposer();
      if (field && shadow && field.value === "") restore(field);
      const active = document.activeElement;
      if (field && focused && (!active || active === document.body || (active instanceof HTMLTextAreaElement && !usable(active)))) {
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      }
      const settled = Boolean(field?.closest("form")?.dataset.conversationId) && performance.now() - lastWipe > SETTLED_MS;
      if (!shadow || settled || performance.now() > until) {
        document.removeEventListener("beforeinput", onBeforeInput, true);
        document.removeEventListener("input", onInput, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("submit", onSubmit, true);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };

  const handOff = (field: HTMLTextAreaElement, target: "home" | "chat") => {
    stopKeepingInput();
    const text = draft.value;
    const focused = document.activeElement === draft || shell.dataset.appFocused === "true";
    const start = draft.selectionStart;
    const end = draft.selectionEnd;
    const from = draft.getBoundingClientRect();
    const to = field.getBoundingClientRect();
    window.__stellaStaticHandoff = {
      at: performance.now(),
      target,
      chars: text.length,
      dx: to.x - from.x,
      dy: to.y - from.y,
      dw: to.width - from.width,
      dh: to.height - from.height,
    };
    place(field, text, focused, start, end);
    release();
    window.setTimeout(saveRootSnapshot, SNAPSHOT_DELAY_MS);
    window.addEventListener("pagehide", saveRootSnapshot);
    if (text) guard(text, focused);
  };

  const wait = () => {
    if (!shell.isConnected) return;
    const home = homeComposer();
    if (home) {
      handOff(home, "home");
      return;
    }
    const chat = anyComposer();
    chatSince = chat ? (chatSince ?? performance.now()) : null;
    if (chat && chatSince !== null && performance.now() - chatSince > CHAT_FALLBACK_MS) {
      handOff(chat, "chat");
      return;
    }
    if (performance.now() - startedAt > GIVE_UP_MS) {
      window.__stellaStaticHandoff = { at: performance.now(), target: "none", chars: draft.value.length, dx: 0, dy: 0, dw: 0, dh: 0 };
      release();
      return;
    }
    requestAnimationFrame(wait);
  };
  requestAnimationFrame(wait);
}
