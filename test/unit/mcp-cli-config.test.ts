import { describe, it, expect, vi } from "vitest";

// cli-config imports a type from storage.ts which imports `* as vscode`.
vi.mock("vscode", () => ({}));

import { parseManagedServers } from "../../src/services/mcp/cli-config.js";

describe("parseManagedServers (import Claude Code's own MCP servers)", () => {
  it("reads user (global), project (.mcp.json), and local (per-project) scopes", () => {
    const claudeJson = {
      mcpServers: {
        figma: {
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: { Authorization: "Bearer secret" }
        }
      },
      projects: {
        "/work/app": {
          mcpServers: { localdb: { command: "node", args: ["db.js"] } }
        }
      }
    };
    const projectMcpJson = {
      mcpServers: { team: { type: "sse", url: "https://team.example.com/sse" } }
    };

    const servers = parseManagedServers({ claudeJson, projectMcpJson, cwd: "/work/app" });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));

    expect(byName.figma).toMatchObject({
      transport: "streamable-http",
      scope: "user",
      url: "https://mcp.figma.com/mcp"
    });
    expect(byName.team).toMatchObject({ transport: "sse", scope: "project" });
    expect(byName.localdb).toMatchObject({
      transport: "stdio",
      scope: "local",
      command: "node",
      args: ["db.js"]
    });
  });

  it("maps explicit http / streamable-http / sse types", () => {
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: {
          a: { type: "http", url: "https://h.com/mcp" },
          b: { type: "streamable-http", url: "https://h.com/x" },
          c: { type: "sse", url: "https://h.com/s" }
        }
      }
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s.transport]));
    expect(byName).toEqual({ a: "streamable-http", b: "streamable-http", c: "sse" });
  });

  it("drops a remote entry with no explicit type (the CLI would reject it)", () => {
    // Url-only, no type — mirrors what `claude` v2.1.150 refuses to load, so we
    // don't surface a phantom 'connected' card for a server that won't run.
    expect(
      parseManagedServers({ claudeJson: { mcpServers: { x: { url: "https://h.com/sse" } } } })
    ).toEqual([]);
  });

  it("local scope overrides user scope on a name clash", () => {
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: { dup: { type: "http", url: "https://global.example.com/mcp" } },
        projects: { "/p": { mcpServers: { dup: { command: "local-cmd" } } } }
      },
      cwd: "/p"
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ scope: "local", transport: "stdio", command: "local-cmd" });
  });

  it("ignores unrecognized shapes and non-object input", () => {
    expect(parseManagedServers({})).toEqual([]);
    expect(parseManagedServers({ claudeJson: { mcpServers: { bad: {} } } })).toEqual([]);
    expect(parseManagedServers({ claudeJson: "garbage" as unknown })).toEqual([]);
    expect(parseManagedServers({ claudeJson: { mcpServers: null } })).toEqual([]);
  });
});
