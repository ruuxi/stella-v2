import { useSyncExternalStore } from "react";

export type DictationTranscriptSnapshot = {
  text: string;
  revision: number;
  stableWordCount: number;
};

export type DictationTranscriptPreview = {
  getSnapshot: () => DictationTranscriptSnapshot;
  reset: () => void;
  setText: (text: string) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createDictationTranscriptPreview =
  (): DictationTranscriptPreview => {
    let snapshot: DictationTranscriptSnapshot = {
      text: "",
      revision: 0,
      stableWordCount: 0,
    };
    const listeners = new Set<() => void>();

    const publish = (text: string): void => {
      const normalized = text.trim();
      if (normalized === snapshot.text) return;
      const previousWords = tokenizeDictationTranscript(snapshot.text);
      const nextWords = tokenizeDictationTranscript(normalized);
      let stableWordCount = 0;
      while (
        stableWordCount < previousWords.length &&
        stableWordCount < nextWords.length &&
        previousWords[stableWordCount] === nextWords[stableWordCount]
      ) {
        stableWordCount += 1;
      }
      snapshot = {
        text: normalized,
        revision: snapshot.revision + 1,
        stableWordCount,
      };
      for (const listener of listeners) listener();
    };

    return {
      getSnapshot: () => snapshot,
      reset: () => publish(""),
      setText: publish,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };

export const useDictationTranscriptPreview = (
  preview: DictationTranscriptPreview,
): DictationTranscriptSnapshot =>
  useSyncExternalStore(
    preview.subscribe,
    preview.getSnapshot,
    preview.getSnapshot,
  );

export const tokenizeDictationTranscript = (text: string): string[] =>
  text.match(/\S+/g) ?? [];
