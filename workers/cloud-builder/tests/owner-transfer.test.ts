import { describe, expect, test } from "bun:test";
import {
  conversationArchivePrefix,
  parseOwnerTransferRequest,
  retainedTurnBlocksOwnerTransfer,
  rewriteSegmentOwnership,
  transferArchiveKey,
} from "../src/owner-transfer.js";

const gzip = async (text: string): Promise<ArrayBuffer> =>
  await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();

const gunzip = async (body: ArrayBuffer): Promise<string> =>
  await new Response(
    new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();

describe("conversation owner transfer", () => {
  test("accepts only an explicit source and destination owner", () => {
    expect(
      parseOwnerTransferRequest({
        fromOwnerId: " anonymous-owner ",
        toOwnerId: "connected-owner",
      }),
    ).toEqual({
      fromOwnerId: "anonymous-owner",
      toOwnerId: "connected-owner",
    });
    expect(
      parseOwnerTransferRequest({
        fromOwnerId: "same-owner",
        toOwnerId: "same-owner",
      }),
    ).toBeNull();
    expect(parseOwnerTransferRequest({ toOwnerId: "connected-owner" })).toBe(
      null,
    );
  });

  test("does not confuse a retained terminal turn with active work", () => {
    expect(retainedTurnBlocksOwnerTransfer(false, undefined)).toBe(false);
    expect(retainedTurnBlocksOwnerTransfer(true, undefined)).toBe(true);
    expect(retainedTurnBlocksOwnerTransfer(true, false)).toBe(true);
    expect(retainedTurnBlocksOwnerTransfer(true, true)).toBe(false);
  });

  test("rekeys only the exact conversation archive prefix", async () => {
    const from = await conversationArchivePrefix(
      "anonymous-owner",
      "conversation-1",
    );
    const to = await conversationArchivePrefix(
      "connected-owner",
      "conversation-1",
    );
    expect(transferArchiveKey(`${from}/spill/a.json.gz`, from, to)).toBe(
      `${to}/spill/a.json.gz`,
    );
    expect(
      transferArchiveKey(`${from}-different/spill/a.json.gz`, from, to),
    ).toBeNull();
  });

  test("rewrites archived owner metadata and spill references", async () => {
    const from = await conversationArchivePrefix(
      "anonymous-owner",
      "conversation-1",
    );
    const to = await conversationArchivePrefix(
      "connected-owner",
      "conversation-1",
    );
    const compressed = await gzip(
      [
        JSON.stringify({
          v: 1,
          conversationId: "conversation-1",
          ownerId: "anonymous-owner",
        }),
        JSON.stringify({
          seq: 1,
          spill_key: `${from}/spill/a.json.gz`,
        }),
        "",
      ].join("\n"),
    );
    const rewritten = await rewriteSegmentOwnership(
      compressed,
      "connected-owner",
      from,
      to,
    );
    const [headerJson, rowJson] = (await gunzip(rewritten)).split("\n");
    expect(JSON.parse(headerJson!)).toMatchObject({
      ownerId: "connected-owner",
    });
    expect(JSON.parse(rowJson!)).toMatchObject({
      spill_key: `${to}/spill/a.json.gz`,
    });
  });
});
