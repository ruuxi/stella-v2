import {
  BoundedBodyError,
  readBoundedStreamBytes,
} from "./bounded-body.js";

export class R2TransferTransformTooLargeError extends Error {
  constructor() {
    super("The R2 object is too large for this metadata transform.");
    this.name = "R2TransferTransformTooLargeError";
  }
}

export type R2TransferTransform = (
  body: Uint8Array,
  destinationKey: string,
) => Promise<
  | {
      body: ReadableStream | ArrayBuffer | Uint8Array | string;
      contentType?: string;
    }
  | undefined
>;

/**
 * Unchanged objects remain streams end to end. A transform is an explicit
 * opt-in to buffering and must provide its own small source limit.
 */
export const r2TransferBody = async (args: {
  source: R2ObjectBody;
  destinationKey: string;
  transform?: R2TransferTransform;
  transformMaxBytes?: number;
}): Promise<{
  body: ReadableStream | ArrayBuffer | Uint8Array | string;
  contentType?: string;
}> => {
  if (!args.transform) return { body: args.source.body };
  const maxBytes = args.transformMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes ?? -1) < 0) {
    throw new Error("An R2 transform requires a valid byte limit.");
  }
  if (args.source.size > maxBytes!) {
    await args.source.body.cancel().catch(() => undefined);
    throw new R2TransferTransformTooLargeError();
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedStreamBytes(args.source.body, maxBytes!);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.reason === "too_large") {
      throw new R2TransferTransformTooLargeError();
    }
    throw error;
  }
  return (await args.transform(bytes, args.destinationKey)) ?? { body: bytes };
};
