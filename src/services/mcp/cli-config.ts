// ─────────────────────────────────────────────────────────────
// Import MCP servers the user already configured in Claude Code.
//
// Claude Code keeps MCP servers in three places, all of which the CLI
// loads automatically for a given working directory:
//
//   • ~/.claude.json  → top-level `mcpServers`         (scope: user/global)
//   • ~/.claude.json  → `projects[<cwd>].mcpServers`   (scope: local)
//   • <cwd>/.mcp.json → `mcpServers`                   (scope: project)
//
// Because Klaude spawns the CLI *without* `--strict-mcp-config`, the CLI
// already merges these in on its own. So we don't re-emit them into our
// `--mcp-config` file (that would double-register them). We only:
//
//   1. surface them in the Connectors UI ("Managed by Claude Code") so the
//      user can see the full picture, and
//   2. hand their names to the pre-allow list (`mcp__<name>`) so their tools
//      don't trip a permission prompt in auto / default mode.
//
// The parsing half (`parseManagedServers`) is pure and unit-tested; the IO
// half (`loadManagedServers`) reads the files and delegates to it.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpTransport } from "./storage.js";

/** Where a managed server was configured — mirrors `claude mcp add --scope`. */
export type ManagedScope = "user" | "project" | "local";

/** A server Klaude found in Claude Code's own config (read-only here). */
export interface ManagedServer {
  /** Config key — this is the `<name>` in the CLI's `mcp__<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  /** Remote endpoint (http/sse). */
  url?: string;
  /** stdio command (display only). */
  command?: string;
  /** stdio args (display only). */
  args?: string[];
  scope: ManagedScope;
}

/** The raw per-server spec as it appears in Claude Code's JSON. */
interface RawServerSpec {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
}

/**
 * Normalize Claude Code's three config sources into a deduped list. Higher
 * specificity wins on a name clash: local (project-local in ~/.claude.json)
 * > project (.mcp.json) > user (global). Pure — feed it parsed JSON.
 */
export function parseManagedServers(input: {
  /** Parsed contents of ~/.claude.json (or null/undefined if absent). */
  claudeJson?: unknown;
  /** Parsed contents of <cwd>/.mcp.json (or null/undefined if absent). */
  projectMcpJson?: unknown;
  /** Absolute workspace path, used to key into `projects` in ~/.claude.json. */
  cwd?: string;
}): ManagedServer[] {
  const { claudeJson, projectMcpJson, cwd } = input;
  // Lowest precedence first; later writes overwrite earlier on the same name.
  const byName = new Map<string, ManagedServer>();

  const ingest = (servers: unknown, scope: ManagedScope) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      const server = normalizeServer(name, raw as RawServerSpec, scope);
      if (server) byName.set(name, server);
    }
  };

  const cj = asObject(claudeJson);
  // 1. user / global
  ingest(cj?.mcpServers, "user");
  // 2. project (.mcp.json)
  ingest(asObject(projectMcpJson)?.mcpServers, "project");
  // 3. local (this project's entry inside ~/.claude.json)
  if (cwd) {
    const projects = asObject(cj?.projects);
    const entry = asObject(projects?.[cwd]);
    ingest(entry?.mcpServers, "local");
  }

  return [...byName.values()];
}

function normalizeServer(
  name: string,
  raw: RawServerSpec,
  scope: ManagedScope
): ManagedServer | null {
  if (!name || !raw || typeof raw !== "object") return null;

  // stdio: identified by a `command`.
  if (typeof raw.command === "string" && raw.command) {
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      scope
    };
  }

  // remote: needs a url AND an explicit transport. The Claude Code CLI's config
  // schema requires `type` on every remote entry (only stdio infers it from
  // `command`), so a url-only entry is one the CLI itself would reject — we
  // skip it rather than surface a phantom "connected" card the CLI won't load.
  if (typeof raw.url === "string" && raw.url) {
    const declared = (raw.type ?? raw.transport ?? "").toLowerCase();
    if (declared === "sse") {
      return { name, transport: "sse", url: raw.url, scope };
    }
    if (declared === "http" || declared === "streamable-http" || declared === "streamablehttp") {
      return { name, transport: "streamable-http", url: raw.url, scope };
    }
    return null; // no recognized type — CLI wouldn't load it
  }

  return null; // unrecognized shape — skip rather than guess
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Read Claude Code's config files and return the managed servers for `cwd`.
 * Never throws — a missing/garbage file yields an empty list.
 */
export function loadManagedServers(cwd?: string): ManagedServer[] {
  const claudeJson = readJsonSafe(path.join(os.homedir(), ".claude.json"));
  const projectMcpJson = cwd ? readJsonSafe(path.join(cwd, ".mcp.json")) : undefined;
  return parseManagedServers({ claudeJson, projectMcpJson, cwd });
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
