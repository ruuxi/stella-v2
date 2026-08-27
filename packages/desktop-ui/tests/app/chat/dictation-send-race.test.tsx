import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";

const fake = vi.hoisted(() => {
  type FakeCallbacks = {
    onStateChange?: (state: string, error?: string) => void;
    onFinalTranscript?: (text: string, meta?: { partial?: boolean }) => void;
    onLevel?: (level: number) => void;
  };

  class FakeDictationSession {
    callbacks: FakeCallbacks = {};
    state = "idle";
    finishTranscription: ((text: string) => void) | null = null;

    constructor() {
      control.sessions.push(this);
    }

    async start(callbacks: FakeCallbacks) {
      this.callbacks = callbacks;
      this.state = "listening";
      callbacks.onStateChange?.("listening");
    }

    async stop() {
      if (this.state !== "listening") return;
      this.state = "transcribing";
      this.callbacks.onStateChange?.("transcribing");
      const text = await new Promise<string>((resolve) => {
        this.finishTranscription = resolve;
      });

      this.state = "idle";
      this.callbacks.onStateChange?.("idle");
      this.callbacks.onFinalTranscript?.(text);
    }

    async cancel() {
      this.state = "idle";
      this.callbacks.onStateChange?.("idle");
    }
  }

  const control: { sessions: FakeDictationSession[] } = { sessions: [] };
  return { control, FakeDictationSession };
});

vi.mock("@/features/dictation/services/inworld-dictation", () => ({
  InworldDictationSession: fake.FakeDictationSession,
  isDictationSuperFastEnabled: () => false,
  probeLocalDictationInstallable: async () => false,
  ensureDictationSuperFastWarm: async () => undefined,
  warmLocalDictationModel: async () => undefined,
}));

vi.mock("@/ui/toast", () => ({
  showToast: () => undefined,
}));

vi.mock("@/shared/lib/auth-cta", () => ({
  SIGN_IN_TOAST_ACTION: { label: "Sign in", onClick: () => undefined },
}));

import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const drainMicrotasks = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

type ProbeApi = {
  dictation: ReturnType<typeof useDictation>;
  getMessage: () => string;
  setMessage: (next: string) => void;
};

type ProbeProps = {
  api: { current: ProbeApi | null };
  sends: string[];
};

function FixedProbe({ api, sends }: ProbeProps) {
  const { message, setMessage, messageRef } = useComposerMessageState();
  const dictation = useDictation({
    message,
    setMessage,
    onCommit: () => {

      const text = messageRef.current;
      if (!text.trim()) return;
      sends.push(text);
      setMessage("");
    },
  });
  api.current = { dictation, getMessage: () => message, setMessage };
  return null;
}

function LegacyProbe({ api, sends }: ProbeProps) {
  const [message, setMessage] = useState("");
  const messageRef = useRef(message);
  messageRef.current = message;
  const dictation = useDictation({
    message,
    setMessage,
    onCommit: () => {
      const text = messageRef.current;
      if (!text.trim()) return;
      sends.push(text);
      setMessage("");
    },
  });
  api.current = { dictation, getMessage: () => message, setMessage };
  return null;
}

describe("dictation send race (commit fires before the transcript render)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fake.control.sessions.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback): number => {
        cb(performance.now());
        return 1;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = async (Probe: typeof FixedProbe) => {
    const api: { current: ProbeApi | null } = { current: null };
    const sends: string[] = [];
    await act(async () => {
      root.render(withI18n(<Probe api={api} sends={sends} />));
    });
    return { api, sends };
  };

  const startDictation = async (api: { current: ProbeApi | null }) => {
    await act(async () => {
      api.current!.dictation.toggle();
      await drainMicrotasks();
    });
    expect(api.current!.dictation.isRecording).toBe(true);
    return fake.control.sessions.at(-1)!;
  };

  it("send-during-recording delivers the full transcript even when the commit beats the render (fixed wiring)", async () => {
    const { api, sends } = await mount(FixedProbe);
    const session = await startDictation(api);

    await act(async () => {
      api.current!.dictation.commitAndSend();
      await drainMicrotasks();
    });
    expect(api.current!.dictation.isTranscribing).toBe(true);
    expect(sends).toEqual([]);

    await act(async () => {
      session.finishTranscription!("hello world");
      await drainMicrotasks();

      expect(sends).toEqual(["hello world"]);
    });

    expect(api.current!.getMessage()).toBe("");
    expect(api.current!.dictation.isRecording).toBe(false);
    expect(api.current!.dictation.isTranscribing).toBe(false);
  });

  it("reproduces the reported bug with the legacy render-synced ref: transcribes but never sends", async () => {
    const { api, sends } = await mount(LegacyProbe);
    const session = await startDictation(api);

    await act(async () => {
      api.current!.dictation.commitAndSend();
      await drainMicrotasks();
    });

    await act(async () => {
      session.finishTranscription!("hello world");
      await drainMicrotasks();
    });

    expect(sends).toEqual([]);
    expect(api.current!.getMessage()).toBe("hello world");
  });

  it("joins the transcript onto pre-typed text before sending", async () => {
    const { api, sends } = await mount(FixedProbe);
    await act(async () => {
      api.current!.setMessage("draft so far");
    });
    const session = await startDictation(api);

    await act(async () => {
      api.current!.dictation.commitAndSend();
      await drainMicrotasks();
    });
    await act(async () => {
      session.finishTranscription!("and the dictated part");
      await drainMicrotasks();
      expect(sends).toEqual(["draft so far and the dictated part"]);
    });
    expect(api.current!.getMessage()).toBe("");
  });

  it("send clicked while already transcribing still sends once the transcript lands", async () => {
    const { api, sends } = await mount(FixedProbe);
    const session = await startDictation(api);

    await act(async () => {
      api.current!.dictation.toggle();
      await drainMicrotasks();
    });
    expect(api.current!.dictation.isTranscribing).toBe(true);

    await act(async () => {
      api.current!.dictation.commitAndSend();
      await drainMicrotasks();
    });
    expect(sends).toEqual([]);

    await act(async () => {
      session.finishTranscription!("late transcript");
      await drainMicrotasks();
      expect(sends).toEqual(["late transcript"]);
    });
    expect(api.current!.getMessage()).toBe("");
  });

  it("stop-then-send (two separate clicks) does not double-send or drop text", async () => {
    const { api, sends } = await mount(FixedProbe);
    const session = await startDictation(api);

    await act(async () => {
      api.current!.dictation.toggle();
      await drainMicrotasks();
    });
    await act(async () => {
      session.finishTranscription!("dictated text");
      await drainMicrotasks();
    });
    expect(sends).toEqual([]);
    expect(api.current!.getMessage()).toBe("dictated text");

    await act(async () => {
      api.current!.dictation.commitAndSend();
      await drainMicrotasks();
    });
    expect(sends).toEqual(["dictated text"]);
    expect(api.current!.getMessage()).toBe("");
  });
});
