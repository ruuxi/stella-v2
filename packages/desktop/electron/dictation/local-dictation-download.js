const createLocalDictationDownloader = (dependencies) => {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const ready = await dependencies.downloadModel();
      if (!ready.available) {
        throw new Error(
          ready.reason ?? "The local dictation model is unavailable."
        );
      }
      return ready;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
};
export {
  createLocalDictationDownloader
};
