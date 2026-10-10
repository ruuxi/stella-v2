/**
 * The send boundary for inline images: before each model request, an image a
 * provider could not decode is replaced by a short note for that request
 * only (`withProcessableImages`). One such image in history would otherwise
 * fail every request of the conversation.
 */
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import { withProcessableImages } from "@stella/runtime/kernel/shared/image-payload";

export const processableImagesHook = hook(GenerationTask, {
  beforeRequest: (request) => {
    const messages = withProcessableImages(request.messages);
    return messages === request.messages ? undefined : { messages };
  },
});
