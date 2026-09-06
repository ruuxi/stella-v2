import { describe, expect, test } from "bun:test";
import {
  placementAttachmentPaths,
  resolvePlacementAttachments,
  type DriveFileResolution,
} from "./placement-attachments.js";

const IMAGE = "uploads/2026-08-29/receipt.png";
const DOCUMENT = "uploads/2026-08-29/lease.pdf";

/** The exact payload a mobile unified-chat turn admits for these two files. */
const dispatchPayload = {
  prompt: "is this rent legal",
  attachments: [IMAGE, DOCUMENT],
};

const drive: Record<string, DriveFileResolution> = {
  [IMAGE]: {
    path: IMAGE,
    name: "receipt.png",
    sizeBytes: 24_512,
    contentType: "image/png",
    url: "https://r2.example/signed/receipt.png?sig=a",
  },
  [DOCUMENT]: {
    path: DOCUMENT,
    name: "lease.pdf",
    sizeBytes: 91_004,
    contentType: "application/pdf",
    url: "https://r2.example/signed/lease.pdf?sig=b",
  },
};

const resolveFromDrive = async (path: string) => {
  const file = drive[path];
  if (!file) throw new Error("That file is not in your drive.");
  return file;
};

describe("the paths a dispatch payload carries", () => {
  test("reads the array the placement service validated", () => {
    expect(placementAttachmentPaths(dispatchPayload)).toEqual([
      IMAGE,
      DOCUMENT,
    ]);
  });

  test("a text-only turn carries none", () => {
    expect(placementAttachmentPaths({ prompt: "what did I miss" })).toEqual([]);
  });

  test("drops entries that are not paths instead of failing the turn", () => {
    expect(
      placementAttachmentPaths({ attachments: [IMAGE, "", "  ", 7, null] }),
    ).toEqual([IMAGE]);
    expect(placementAttachmentPaths({ attachments: "nope" })).toEqual([]);
  });

  test("trims, so a path matches the drive row it names", () => {
    expect(placementAttachmentPaths({ attachments: [` ${IMAGE} `] })).toEqual([
      IMAGE,
    ]);
  });
});

describe("desktop-placed resolution", () => {
  test("an image becomes vision-eligible and a document stays a reference", async () => {
    const refs = await resolvePlacementAttachments({
      paths: placementAttachmentPaths(dispatchPayload),
      resolve: resolveFromDrive,
    });
    expect(refs).toEqual([
      {
        url: "https://r2.example/signed/receipt.png?sig=a",
        mimeType: "image/png",
        kind: "image",
        name: "receipt.png",
        size: 24_512,
      },
      {
        url: "https://r2.example/signed/lease.pdf?sig=b",
        mimeType: "application/pdf",
        kind: "file",
        name: "lease.pdf",
        size: 91_004,
      },
    ]);
    // The runtime materializes a remote image into a data URL only when it can
    // tell it is one, and it tells from exactly these two fields.
    const image = refs[0]!;
    expect(/^https?:\/\//i.test(image.url)).toBe(true);
    expect(image.mimeType?.startsWith("image/")).toBe(true);
  });

  test("sourcePath stays unset, because the model reads it as an absolute path", async () => {
    const refs = await resolvePlacementAttachments({
      paths: [IMAGE],
      resolve: resolveFromDrive,
    });
    expect(refs[0]).not.toHaveProperty("sourcePath");
  });

  test("normalizes a content type the drive row spelled loudly", async () => {
    const refs = await resolvePlacementAttachments({
      paths: [IMAGE],
      resolve: async (path) => ({
        ...drive[path]!,
        contentType: " IMAGE/PNG ",
      }),
    });
    expect(refs[0]?.mimeType).toBe("image/png");
    expect(refs[0]?.kind).toBe("image");
  });

  test("one unresolvable attachment does not cost the others", async () => {
    const skipped: string[] = [];
    const refs = await resolvePlacementAttachments({
      paths: ["uploads/deleted.png", DOCUMENT],
      resolve: resolveFromDrive,
      onSkipped: (path) => skipped.push(path),
    });
    expect(skipped).toEqual(["uploads/deleted.png"]);
    expect(refs.map((ref) => ref.name)).toEqual(["lease.pdf"]);
  });

  test("resolves every path the server admitted rather than capping again", async () => {
    const paths = Array.from(
      { length: 4 },
      (_, index) => `uploads/2026-08-29/p${index}.png`,
    );
    const refs = await resolvePlacementAttachments({
      paths,
      resolve: async (path) => ({
        path,
        name: path.split("/").pop()!,
        sizeBytes: 1,
        contentType: "image/png",
        url: `https://r2.example/signed/${path}`,
      }),
    });
    expect(refs).toHaveLength(paths.length);
  });
});

describe("both placements see the same references", () => {
  /**
   * Placement is invisible to the user, so the two executors must be handed the
   * same attachment identity from the same payload. The cloud executor reads
   * `turn.attachments`; the desktop reads it through `placementAttachmentPaths`
   * and resolves it. Anything that made these two lists differ would run a
   * materially different request depending on which computer happened to be
   * awake.
   */
  test("the cloud turn's paths and the desktop's resolved paths are the same list", async () => {
    const cloudTurnAttachments = dispatchPayload.attachments;
    const desktopPaths = placementAttachmentPaths(dispatchPayload);
    expect(desktopPaths).toEqual(cloudTurnAttachments);

    const resolvedOrder: string[] = [];
    await resolvePlacementAttachments({
      paths: desktopPaths,
      resolve: async (path) => {
        resolvedOrder.push(path);
        return await resolveFromDrive(path);
      },
    });
    expect(resolvedOrder).toEqual(cloudTurnAttachments);
  });

  test("a clean prompt needs no attachment preamble for computer resolution", async () => {
    expect(dispatchPayload.prompt).toBe("is this rent legal");
    const resolved = await resolvePlacementAttachments({
      paths: placementAttachmentPaths(dispatchPayload), resolve: resolveFromDrive,
    });
    const legacy = await resolvePlacementAttachments({
      paths: placementAttachmentPaths({ ...dispatchPayload,
        prompt: `${dispatchPayload.prompt}\n\nAttached in my drive:\n- ${IMAGE}\n- ${DOCUMENT}`,
      }), resolve: resolveFromDrive,
    });
    expect(resolved).toEqual(legacy);
    expect(resolved.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "receipt.png", kind: "image" }, { name: "lease.pdf", kind: "file" },
    ]);
  });
});
