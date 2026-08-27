import { z } from 'zod';

export const emailSchema = z.string().email('Invalid email format');

export const emailArraySchema = z.union([emailSchema, z.array(emailSchema)]);

export const iso8601DateTimeSchema = z.string().refine(
  (val) => {
    const iso8601Regex =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
    if (!iso8601Regex.test(val)) return false;

    const date = new Date(val);
    return !isNaN(date.getTime());
  },
  {
    message:
      'Invalid ISO 8601 datetime format. Expected format: YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]',
  },
);

export const googleDocumentIdSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Invalid document ID format. Document IDs should only contain letters, numbers, hyphens, and underscores',
  );

export const googleWorkspaceUrlSchema = z
  .string()
  .regex(
    /^https:\/\/(docs|drive|sheets|slides)\.google\.com\/.+\/d\/([a-zA-Z0-9_-]+)/,
    'Invalid Google Workspace URL format',
  );

export const folderNameSchema = z
  .string()
  .min(1, 'Folder name cannot be empty')
  .max(255, 'Folder name too long (max 255 characters)')
  .refine(

    (val) => !/[<>:"/\\|?*\x00-\x1F]/.test(val),
    'Folder name contains invalid characters',
  );

export const calendarIdSchema = z.union([z.literal('primary'), emailSchema]);

export const searchQuerySchema = z.string().transform((val) => {

  return val
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
});

export const pageSizeSchema = z
  .number()
  .int('Page size must be an integer')
  .min(1, 'Page size must be at least 1')
  .max(100, 'Page size cannot exceed 100');

function createValidator<T>(
  schema: z.ZodSchema<T>,
  fallbackErrorMessage: string,
) {
  return (value: unknown): { success: boolean; error?: string } => {
    try {
      schema.parse(value);
      return { success: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0].message };
      }
      return { success: false, error: fallbackErrorMessage };
    }
  };
}

export const validateEmail = createValidator(
  emailSchema,
  'Invalid email format',
);

export const validateDateTime = createValidator(
  iso8601DateTimeSchema,
  'Invalid datetime format',
);

export const validateDocumentId = createValidator(
  googleDocumentIdSchema,
  'Invalid document ID',
);

export function extractDocumentId(urlOrId: string): string {

  if (googleDocumentIdSchema.safeParse(urlOrId).success) {
    return urlOrId;
  }

  const urlMatch = urlOrId.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  throw new Error('Invalid document ID or URL');
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
