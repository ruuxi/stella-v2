export const createMobileTranscriptionRequestId = (
  createEntropy: () => string = () =>
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
): string => `mobile-stt:${createEntropy()}`;
