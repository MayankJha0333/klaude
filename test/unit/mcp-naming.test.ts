import { describe, it, expect, vi } from "vitest";

// index.ts imports `* as vscode` (and transitively oauth/client/storage).
vi.mock("vscode", () => ({}));

import { slugify, cliServerName } from "../../src/services/mcp/index.js";

describe("slugify (custom connector id prefix)", () => {
  it("lowercases and hyphenates non-alphanumerics", () => {
    expect(slugify("My Server!!")).toBe("my-server");
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });
  it("falls back to 'connector' for an empty result", () => {
    expect(slugify("")).toBe("connector");
    expect(slugify("***")).toBe("connector");
  });
  it("caps the length at 24 chars", () => {
    expect(slugify("a".repeat(50)).length).toBe(24);
  });
});

describe("cliServerName (mcp__<name>__<tool> safety)", () => {
  it("passes through clean ids unchanged", () => {
    expect(cliServerName("linear")).toBe("linear");
    expect(cliServerName("my_server-1")).toBe("my_server-1");
  });
  it("replaces unsafe characters with underscores", () => {
    expect(cliServerName("a.b/c")).toBe("a_b_c");
  });
  it("caps the length at 48 chars", () => {
    expect(cliServerName("x".repeat(60)).length).toBe(48);
  });
});

// Documents the audit finding: addCustom derives a connector id as
//   slugify(name) + "-" + host.replace(/[^a-z0-9]/gi, "")
// which IGNORES the URL path. Two MCP servers with the same name + host but
// different paths collapse to the same id, and saveCustomConnector then
// silently overwrites the first. See src/services/mcp/index.ts:141.
describe("custom connector id derivation collides on same name+host", () => {
  const deriveId = (name: string, url: string) =>
    slugify(name) + "-" + new URL(url).host.replace(/[^a-z0-9]/gi, "");

  it("produces identical ids for different paths on the same host", () => {
    const a = deriveId("My Server", "https://example.com/mcp");
    const b = deriveId("My Server", "https://example.com/sse");
    expect(a).toBe(b); // collision — second save would overwrite the first
    expect(a).toBe("my-server-examplecom");
  });
});
