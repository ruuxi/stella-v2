import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureDictationSuperFastWarm,
  InworldDictationSession,
  isDictationSuperFastEnabled,
  isLocalDictationEnabled,
  probeLocalDictationInstallable,
  warmLocalDictationModel,
  type DictationSessionState,
} from "@/features/dictation/services/inworld-dictation";
import { DOWNLOAD_LOCAL_DICTATION_ACTION } from "@/features/dictation/services/local-dictation-download";
import { appendRollingLevel } from "@/features/dictation/rolling-levels";
import { showToast } from "@/ui/toast";
import { SIGN_IN_TOAST_ACTION } from "@/shared/lib/auth-cta";
import { useT } from "@/shared/i18n";

export const DICTATION_TOGGLE_EVENT = "stella:dictation-toggle";

type DictationToggleEventDetail = {
  startId?: string;
  action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
};

const MAX_LEVEL_BARS = 256;

type Setter<T> = (next: T | ((prev: T) => T)) => void;

interface UseDictationOptions {
  setMessage: Setter<string>;
  message: string;
  disabled?: boolean;
  onError?: (error: string) => void;
  onTranscriptCommitted?: () => void;

  onCommit?: () => void;
}

interface UseDictationResult {
  isRecording: boolean;
  isRecordingVisible: boolean;
  isTranscribing: boolean;
  showControls: boolean;
  state: DictationSessionState;

  toggle: () => void;

  cancel: () => void;

  commitAndSend: () => void;

  levels: number[];

  elapsedMs: number;
  error: string | null;
}

const joinTranscriptOntoBase = (base: string, transcript: string): string => {
  if (!transcript) return base;
  if (!base) return transcript;
  const trimmedBase = base.replace(/\s+$/, "");
  return `${trimmedBase} ${transcript}`;
};

export const useDictation = ({
  setMessage,
  message,
  disabled = false,
  onError,
  onTranscriptCommitted,
  onCommit,
}: UseDictationOptions): UseDictationResult => {
  const t = useT();
  const [state, setState] = useState<DictationSessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [showRecordingBar, setShowRecordingBar] = useState(false);

  const sessionRef = useRef<InworldDictationSession | null>(null);
  const baseTextRef = useRef("");
  const messageRef = useRef(message);
  const setMessageRef = useRef(setMessage);
  const onErrorRef = useRef(onError);
  const onTranscriptCommittedRef = useRef(onTranscriptCommitted);
  const onCommitRef = useRef(onCommit);
  const stateRef = useRef<DictationSessionState>("idle");

  const sendAfterCommitRef = useRef(false);

  const warmedRef = useRef(false);

  const localInstallableRef = useRef(false);

  messageRef.current = message;
  setMessageRef.current = setMessage;
  onErrorRef.current = onError;
  onTranscriptCommittedRef.current = onTranscriptCommitted;
  onCommitRef.current = onCommit;

  const fireCommitIfPending = useCallback(() => {
    if (!sendAfterCommitRef.current) return;
    sendAfterCommitRef.current = false;

    requestAnimationFrame(() => {
      onCommitRef.current?.();
    });
  }, []);

  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    void probeLocalDictationInstallable().then((installable) => {
      if (!cancelled) localInstallableRef.current = installable;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state !== "listening") return;
    const startedAt = performance.now();
    const id = setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.stop();
    } catch (err) {
      console.debug("[dictation] stop failed:", (err as Error).message);
    }
  }, []);

  const cancel = useCallback(() => {
    sendAfterCommitRef.current = false;
    const session = sessionRef.current;
    if (!session) return;
    setLevels([]);
    setShowControls(false);
    setShowRecordingBar(false);
    void session.cancel().catch((err: Error) => {
      console.debug("[dictation] cancel failed:", err.message);
    });
  }, []);

  const start = useCallback(
    async (source: "button" | "shortcut") => {
      if (sessionRef.current) return;
      if (disabled) return;

      if (!warmedRef.current) {
        warmedRef.current = true;
        void warmLocalDictationModel().catch(() => undefined);
        if (isDictationSuperFastEnabled()) {
          void ensureDictationSuperFastWarm().catch(() => undefined);
        }
      }
      const session = new InworldDictationSession();
      sessionRef.current = session;
      baseTextRef.current = messageRef.current;
      setError(null);
      setLevels([]);
      setElapsedMs(0);
      setShowControls(source === "button");
      setShowRecordingBar(source === "button");

      try {
        await session.start({
          onStateChange: (next, errMessage) => {
            setState(next);
            window.electronAPI?.dictation?.activeChanged({
              active: next === "listening" || next === "transcribing",
            });
            if (next === "error" && errMessage) {
              console.warn(
                "[dictation] session entered error state:",
                errMessage,
              );
              setError(errMessage);

              const normalized = errMessage.toLowerCase();
              const needsSignIn =
                /\b401\b|\b403\b|unauthor|unauthenticated|sign[\s-]?in|not signed in/.test(
                  normalized,
                );
              if (needsSignIn) {
                const canDownloadLocalDictation =
                  localInstallableRef.current && isLocalDictationEnabled();
                showToast(
                  canDownloadLocalDictation
                    ? {
                        title: t("features.dictation.localNotReadyTitle"),
                        description: t("features.dictation.localNotReadyBody"),
                        variant: "error",
                        duration: 10_000,
                        action: DOWNLOAD_LOCAL_DICTATION_ACTION,
                        secondaryAction: SIGN_IN_TOAST_ACTION,
                      }
                    : {
                        title: t("features.dictation.signInTitle"),
                        description: t("features.dictation.signInBody"),
                        variant: "error",
                        duration: 8000,
                        action: SIGN_IN_TOAST_ACTION,
                      },
                );
              } else {
                showToast({
                  title: t("features.dictation.failedTitle"),
                  description: t("features.dictation.failedBody"),
                  variant: "error",
                });
              }
              onErrorRef.current?.(errMessage);
            }
            if (next === "idle" || next === "error") {
              sessionRef.current = null;
              setLevels([]);
              setShowControls(false);
              setShowRecordingBar(false);

              queueMicrotask(fireCommitIfPending);
            }
          },
          onFinalTranscript: (transcript, meta) => {
            const next = joinTranscriptOntoBase(
              baseTextRef.current,
              transcript,
            );
            setMessageRef.current(next);
            onTranscriptCommittedRef.current?.();
            if (meta?.partial) {

              showToast({
                title: t("features.dictation.partialTitle"),
                description: t("features.dictation.partialBody"),
                variant: "error",
                duration: 8000,
              });
            }
          },
          onLevel: (level) => {
            setLevels((prev) =>
              appendRollingLevel(prev, level, MAX_LEVEL_BARS),
            );
          },
        });
      } catch (err) {
        const errMessage = (err as Error).message;
        setError(errMessage);
        onErrorRef.current?.(errMessage);
        window.electronAPI?.dictation?.activeChanged({ active: false });
        sessionRef.current = null;
        setLevels([]);
        setShowControls(false);
        setShowRecordingBar(false);
      }
    },
    [disabled, fireCommitIfPending, t],
  );

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current === "listening") {
      sendAfterCommitRef.current = false;
      window.electronAPI?.dictation?.playSound({ sound: "stopRecording" });
      void stop();
    } else if (current === "transcribing") {

      return;
    } else {
      sendAfterCommitRef.current = false;
      window.electronAPI?.dictation?.playSound({ sound: "startRecording" });
      void start("button");
    }
  }, [start, stop]);

  const commitAndSend = useCallback(() => {
    const current = stateRef.current;
    if (current === "listening") {
      sendAfterCommitRef.current = true;
      void stop();
      return;
    }
    if (current === "transcribing") {
      sendAfterCommitRef.current = true;
      return;
    }

    onCommitRef.current?.();
  }, [stop]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DictationToggleEventDetail>).detail;
      const startId = detail?.startId;
      const action = detail?.action ?? "toggle";
      const current = stateRef.current;
      const canHandle =
        !disabled || current === "listening" || current === "transcribing";
      if (!canHandle) return;
      window.electronAPI?.dictation?.inAppStarted({ startId });
      if (action === "start") {
        if (current !== "listening" && current !== "transcribing") {
          void start("shortcut");
        }
        return;
      }
      if (action === "reveal") {
        if (current === "listening") {
          setShowRecordingBar(true);
        }
        return;
      }
      if (action === "stop") {
        if (current === "listening") {
          sendAfterCommitRef.current = false;
          void stop();
        }
        return;
      }
      if (action === "cancel") {
        if (current === "listening" || current === "transcribing") {
          cancel();
        }
        return;
      }
      if (current === "listening") {
        sendAfterCommitRef.current = false;
        void stop();
      } else if (current !== "transcribing") {
        sendAfterCommitRef.current = false;
        void start("shortcut");
      }
    };
    window.addEventListener(DICTATION_TOGGLE_EVENT, handler);
    return () => window.removeEventListener(DICTATION_TOGGLE_EVENT, handler);
  }, [cancel, disabled, start, stop]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) {
        window.electronAPI?.dictation?.activeChanged({ active: false });
        void session.cancel().catch(() => undefined);
        sessionRef.current = null;
      }
    };
  }, []);

  return {
    isRecording: state === "listening",
    isRecordingVisible: state === "listening" && showRecordingBar,
    isTranscribing: state === "transcribing",
    showControls,
    state,
    toggle,
    cancel,
    commitAndSend,
    levels,
    elapsedMs,
    error,
  };
};
