import { formatMemoryForContext, type MemoryFact } from "./chat-memory";
import type { MobileChatStreamToolCall } from "./mobile-chat-stream";

export type MobileToolCall =
  | { id: string; tool: "remember"; key: string; value: string }
  | { id: string; tool: "forget"; key: string }
  | { id: string; tool: "recall"; query: string }
  | {
      id: string;
      tool: "map";
      places?: string[];
      origin?: string;
      destination?: string;
      mode?: string;
      title?: string;
    }
  | {
      id: string;
      tool: "pdf";
      title?: string;
      content: string;
      filename?: string;
    }
  | {
      id: string;
      tool: "web";
      query?: string;
      url?: string;
      category?: string;
      prompt?: string;
      format?: "text" | "markdown" | "html";
    }
  | {
      id: string;
      tool: "image_gen";
      prompt: string;
      aspectRatio?: string;
      numImages?: number;
    };

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(asString).filter((entry) => entry.length > 0)
    : [];

const asText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .join("\n")
      .trim();
  }
  return "";
};

export const normalizeMobileToolCall = (
  call: MobileChatStreamToolCall,
): MobileToolCall | null => {
  const id = call.id.trim();
  if (!id) return null;
  const args = call.arguments;

  switch (call.name) {
    case "remember": {
      const key = asString(args.key);
      const value = asString(args.value);
      return key && value ? { id, tool: "remember", key, value } : null;
    }
    case "forget": {
      const key = asString(args.key);
      return key ? { id, tool: "forget", key } : null;
    }
    case "recall": {
      const query = asString(args.query);
      return query ? { id, tool: "recall", query } : null;
    }
    case "map": {
      const places = asStringArray(args.places);
      const origin = asString(args.origin);
      const destination = asString(args.destination);
      if (places.length === 0 && !(origin && destination)) return null;
      return {
        id,
        tool: "map",
        ...(places.length > 0 ? { places } : {}),
        ...(origin ? { origin } : {}),
        ...(destination ? { destination } : {}),
        ...(asString(args.mode) ? { mode: asString(args.mode) } : {}),
        ...(asString(args.title) ? { title: asString(args.title) } : {}),
      };
    }
    case "pdf": {
      const content = asText(args.content ?? args.body ?? args.markdown);
      if (!content) return null;
      const title = asString(args.title);
      const filename = asString(args.filename);
      return {
        id,
        tool: "pdf",
        content,
        ...(title ? { title } : {}),
        ...(filename ? { filename } : {}),
      };
    }
    case "web": {
      const query = asString(args.query);
      const url = asString(args.url);
      if ((!query && !url) || (query && url)) return null;
      const category = asString(args.category);
      const prompt = asString(args.prompt);
      const requestedFormat = asString(args.format);
      const format =
        requestedFormat === "text" ||
        requestedFormat === "markdown" ||
        requestedFormat === "html"
          ? requestedFormat
          : "";
      return {
        id,
        tool: "web",
        ...(query ? { query } : {}),
        ...(url ? { url } : {}),
        ...(category ? { category } : {}),
        ...(prompt ? { prompt } : {}),
        ...(format ? { format } : {}),
      };
    }
    case "image_gen": {
      const prompt = asString(args.prompt);
      if (!prompt) return null;
      const aspectRatio = asString(args.aspectRatio ?? args.aspect_ratio);
      const requestedCount = Number(args.numImages ?? args.num_images ?? 1);
      const numImages = Number.isFinite(requestedCount)
        ? Math.max(1, Math.min(4, Math.floor(requestedCount)))
        : 1;
      return {
        id,
        tool: "image_gen",
        prompt,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(numImages > 1 ? { numImages } : {}),
      };
    }
    default:
      return null;
  }
};

export const buildMobileModelContext = (args: {
  memoryFacts: MemoryFact[];
  summary: string;
}): string => {
  const sections: string[] = [];
  const memory = formatMemoryForContext(args.memoryFacts);
  if (memory) sections.push(memory);
  if (args.summary.trim()) {
    sections.push(
      `Summary of earlier conversation (older turns were compacted to save space):\n${args.summary.trim()}`,
    );
  }
  return sections.join("\n\n");
};
