import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const usageSearchSchema = z.object({
  range: z.enum(["24h", "7d", "30d", "all"]).optional().catch("7d"),
  conversation: z.string().optional().catch(undefined),
  thread: z.string().optional().catch(undefined),
  agent: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/usage")({
  validateSearch: usageSearchSchema,
});
