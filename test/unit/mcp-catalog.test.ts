import { describe, it, expect } from "vitest";
import { CURATED_CATALOG, findCatalog } from "../../src/services/mcp/catalog.js";

describe("mcp catalog", () => {
  it("findCatalog returns the entry for a known id", () => {
    const first = CURATED_CATALOG[0];
    expect(findCatalog(first.id)).toBe(first);
  });

  it("findCatalog returns undefined for an unknown id", () => {
    expect(findCatalog("__definitely-not-a-connector__")).toBeUndefined();
  });

  it("has no duplicate connector ids", () => {
    const ids = CURATED_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses https endpoints for every connector", () => {
    for (const c of CURATED_CATALOG) {
      expect(c.url.startsWith("https://"), `${c.id} url should be https`).toBe(true);
    }
  });

  it("every entry has the required display fields", () => {
    for (const c of CURATED_CATALOG) {
      expect(c.id, "id").toBeTruthy();
      expect(c.name, `${c.id} name`).toBeTruthy();
      expect(c.transport === "streamable-http" || c.transport === "sse").toBe(true);
      expect(Array.isArray(c.categories)).toBe(true);
    }
  });

  it("derives transport consistently with the URL path (sse endpoints)", () => {
    for (const c of CURATED_CATALOG) {
      if (/\/sse$/i.test(new URL(c.url).pathname)) {
        expect(c.transport, `${c.id} ends in /sse`).toBe("sse");
      }
    }
  });
});
