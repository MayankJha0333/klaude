import { describe, it, expect, vi } from "vitest";

// client.ts transitively imports storage.ts which imports `* as vscode`.
vi.mock("vscode", () => ({}));

import { parseEnvelope } from "../../src/services/mcp/client.js";

/** Build a minimal fetch Response double for parseEnvelope. */
function res(contentType: string, body: string): any {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body
  };
}

describe("parseEnvelope", () => {
  it("parses a plain JSON JSON-RPC result", async () => {
    const env = await parseEnvelope(
      res("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }))
    );
    expect(env.result).toEqual({ ok: true });
  });

  it("parses a JSON-RPC error envelope", async () => {
    const env = await parseEnvelope(
      res("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } }))
    );
    expect(env.error?.message).toBe("boom");
  });

  it("parses an SSE-framed JSON-RPC envelope", async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse));
    expect(env.result).toEqual({ x: 1 });
  });

  it("throws when an SSE stream has no JSON-RPC envelope", async () => {
    await expect(parseEnvelope(res("text/event-stream", "data: hello\n\n"))).rejects.toThrow(
      /no JSON-RPC envelope/
    );
  });

  it("throws on an empty JSON body", async () => {
    await expect(parseEnvelope(res("application/json", ""))).rejects.toThrow(/Empty response body/);
  });

  // Documents the audit finding: despite the doc comment claiming it matches
  // the request id, parseEnvelope's signature takes no id and simply returns
  // the FIRST envelope carrying a result/error. With multiplexed streams this
  // can return the wrong frame. (Contract/implementation mismatch — see
  // src/services/mcp/client.ts:179-205.)
  it("returns the FIRST valid envelope in an SSE stream, ignoring id", async () => {
    const sse =
      'data: {"jsonrpc":"2.0","id":99,"result":{"first":true}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"second":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse));
    expect(env.result).toEqual({ first: true });
  });
});
