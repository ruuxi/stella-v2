export type TtsPlaylist = {
  status: "pending" | "synthesizing" | "done" | "error";
  done: boolean;
  segments: Array<{ seq: number; durationSec: number }>;
};

/** AVPlayer can fail permanently on an empty EVENT playlist. Hold the first
 * read until audio exists, but bound the wait so a failed producer cannot hold
 * HTTP actions open indefinitely. Later reads return immediately. */
export async function waitForPlayableTtsPlaylist(
  read: () => Promise<TtsPlaylist | null>,
): Promise<TtsPlaylist | null> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const playlist = await read();
    if (
      !playlist ||
      playlist.segments.length > 0 ||
      playlist.done ||
      playlist.status === "error" ||
      Date.now() >= deadline
    ) {
      return playlist;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
