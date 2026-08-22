import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthManager } from "@stella/runtime/kernel/google-workspace/AuthManager";
import { DocsService } from "@stella/runtime/kernel/google-workspace/DocsService";

const { batchUpdate, get, docs } = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
  get: vi.fn(),
  docs: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: { docs },
}));

describe("DocsService.writeText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdate.mockResolvedValue({ data: {} });
    docs.mockReturnValue({ documents: { batchUpdate, get } });
  });

  it("appends to the main body with a valid end location", async () => {
    const authManager = {
      getAuthenticatedClient: vi.fn().mockResolvedValue({}),
    } as unknown as AuthManager;
    const service = new DocsService(authManager);

    await service.writeText({
      documentId: "document-id",
      text: "Appended text",
      position: "end",
    });

    expect(get).not.toHaveBeenCalled();
    expect(batchUpdate).toHaveBeenCalledWith({
      documentId: "document-id",
      requestBody: {
        requests: [
          {
            insertText: {
              endOfSegmentLocation: {},
              text: "Appended text",
            },
          },
        ],
      },
    });
  });
});
