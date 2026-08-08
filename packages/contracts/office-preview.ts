import { z } from "zod";

export type OfficePreviewStatus = "starting" | "ready" | "error" | "stopped";

export type OfficePreviewFormat = "docx" | "xlsx" | "pptx" | null;

export const officePreviewRefSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  sourcePath: z.string(),
});

export type OfficePreviewRef = z.infer<typeof officePreviewRefSchema>;

export type OfficePreviewSnapshot = {
  sessionId: string;
  title: string;
  sourcePath: string;
  format: OfficePreviewFormat;
  startedAt: number;
  updatedAt: number;
  status: OfficePreviewStatus;
  html: string;
  error?: string;
};

export const isOfficePreviewRef = (value: unknown): value is OfficePreviewRef =>
  officePreviewRefSchema.safeParse(value).success;
