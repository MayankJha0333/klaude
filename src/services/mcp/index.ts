// ─────────────────────────────────────────────────────────────
// MCP connector service.
//
// Public surface used by the chat panel:
//
//   listConnectors(ctx)         → merged catalog + custom + status
//   connect(ctx, id)            → run OAuth + MCP initialize/tools list
//   disconnect(ctx, id)         → wipe tokens + connection record
//   addCustom(ctx, draft)       → save a user-provided connector
//   removeCustom(ctx, id)       → delete a user-provided connector
//   callTool(ctx, id, name, in) → invoke a tool (used later when we wire
//                                 the bridge to the model)
//
// The shape returned to the webview is intentionally close to what
// claude.ai's connectors page renders: name, vendor, description,
// icon, status pill, and tool count when connected.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { CURATED_CATALOG, CatalogEntry } from "./catalog.js";
import {
  ConnectionRecord,
  ConnectorTool,
  CustomConnector,
  clearConnectionRecord,
  deleteTokens,
  loadConnections,
  loadCustomConnectors,
  loadTokens,
  removeCustomConnector,
  saveCustomConnector,
  saveTokens,
  setConnectionRecord
} from "./storage.js";
import { performOAuth, refreshAccessToken, OAuthCancelled } from "./oauth.js";
import { McpClient } from "./client.js";

export interface ConnectorView {
  id: string;
  name: string;
  vendor: string;
  description: string;
  url: string;
  transport: "streamable-http" | "sse";
  categories: string[];
  icon: string;
  homepage?: string;
  builtIn: boolean;
  status: "connected" | "disconnected" | "error";
  connectedAt?: number;
  toolCount: number;
  tools?: ConnectorTool[];
  lastError?: string;
}

/** Merge catalog + custom + saved state into a single list for the UI. */
export function listConnectors(ctx: vscode.ExtensionContext): ConnectorView[] {
  const conns = loadConnections(ctx);
  const customs = loadCustomConnectors(ctx);

  const fromCatalog: ConnectorView[] = CURATED_CATALOG.map((c) =>
    toView(c, conns[c.id], true)
  );
  const fromCustom: ConnectorView[] = customs.map((c) =>
    toView(customAsCatalog(c), conns[c.id], false)
  );
  return [...fromCatalog, ...fromCustom];
}

function toView(
  c: CatalogEntry,
  rec: ConnectionRecord | undefined,
  builtIn: boolean
): ConnectorView {
  return {
    id: c.id,
    name: c.name,
    vendor: c.vendor,
    description: c.description,
    url: c.url,
    transport: c.transport,
    categories: c.categories,
    icon: c.icon,
    homepage: c.homepage,
    builtIn,
    status: rec?.status ?? "disconnected",
    connectedAt: rec?.connectedAt,
    toolCount: rec?.tools?.length ?? 0,
    tools: rec?.tools,
    lastError: rec?.lastError
  };
}

function customAsCatalog(c: CustomConnector): CatalogEntry {
  return {
    id: c.id,
    name: c.name,
    vendor: new URL(c.url).host,
    description: c.description ?? `Custom MCP server at ${c.url}`,
    url: c.url,
    transport: c.transport,
    categories: ["custom"],
    icon: "cloud",
    builtIn: false
  };
}

// ── Add / remove custom ─────────────────────────────────────

export interface CustomDraft {
  name: string;
  url: string;
  /** Optional pre-registered OAuth client id. */
  clientId?: string;
  /** Optional pre-registered client secret. */
  clientSecret?: string;
}

export async function addCustom(
  ctx: vscode.ExtensionContext,
  draft: CustomDraft
): Promise<ConnectorView> {
  const name = draft.name.trim();
  const url = draft.url.trim();
  if (!name) throw new Error("Name is required.");
  if (!url) throw new Error("URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL is not valid.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("MCP server URLs must use HTTPS (except localhost).");
  }

  const id = slugify(name) + "-" + parsed.host.replace(/[^a-z0-9]/gi, "");
  const transport: "streamable-http" | "sse" = /sse$/i.test(parsed.pathname)
    ? "sse"
    : "streamable-http";

  const entry: CustomConnector = {
    id,
    name,
    url,
    transport,
    description: `Custom MCP server at ${parsed.host}`,
    clientId: draft.clientId?.trim() || undefined
  };
  await saveCustomConnector(ctx, entry);

  // Stash the client_secret separately if provided so it's not in plain JSON.
  if (draft.clientSecret) {
    await saveTokens(ctx, id, { clientSecret: draft.clientSecret.trim() });
  }

  const conns = loadConnections(ctx);
  return toView(customAsCatalog(entry), conns[id], false);
}

export async function removeCustom(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  await deleteTokens(ctx, id);
  await clearConnectionRecord(ctx, id);
  await removeCustomConnector(ctx, id);
}

// ── Connect / disconnect ────────────────────────────────────

/**
 * Per-connector AbortControllers for in-flight Connect attempts. Lets the
 * UI's "Cancel" button stop a stuck OAuth flow (browser closed, user
 * walked away) instead of waiting on the 5-minute hard timeout.
 */
const inflightConnects = new Map<string, AbortController>();

/** Abort the in-flight Connect for `id`, if any. No-op when there isn't one. */
export function cancelConnect(id: string): boolean {
  const ctrl = inflightConnects.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  inflightConnects.delete(id);
  return true;
}

/**
 * Run the full Connect flow:
 *   1. Resolve the connector's URL + optional pre-registered client.
 *   2. Run OAuth (DCR + PKCE + browser loopback) → tokens.
 *   3. Initialize the MCP session and list its tools.
 *   4. Persist tokens, refresh metadata, and the connection record.
 *
 * Throws on any failure; the caller surfaces the message to the UI.
 * The OAuth step is cancellable via `cancelConnect(id)` — useful when
 * the user closes the browser without finishing OAuth.
 */
export async function connect(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<ConnectorView> {
  const config = resolveConfig(ctx, id);
  if (!config) throw new Error(`No connector with id "${id}".`);

  // If a prior attempt is still pending for this connector, replace it.
  inflightConnects.get(id)?.abort();
  const controller = new AbortController();
  inflightConnects.set(id, controller);

  // Check whether the user pre-registered an OAuth client (custom connectors).
  const existing = await loadTokens(ctx, id);
  const customs = loadCustomConnectors(ctx);
  const custom = customs.find((c) => c.id === id);

  let tokens;
  try {
    tokens = await performOAuth({
      serverUrl: config.url,
      preRegisteredClientId: custom?.clientId,
      preRegisteredClientSecret: existing.clientSecret,
      appName: "Klaude (VS Code)",
      signal: controller.signal
    });
  } catch (err) {
    inflightConnects.delete(id);
    // Cancellation is a normal user action — reset to disconnected instead
    // of leaving an "error" status banner behind on the card.
    if (err instanceof OAuthCancelled) {
      await clearConnectionRecord(ctx, id);
      throw err;
    }
    await setConnectionRecord(ctx, {
      id,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err)
    });
    throw err;
  }

  // Save secrets + cache refresh metadata.
  await saveTokens(ctx, id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientSecret: tokens.clientSecret
  });

  // Initialize + list tools so the UI can show a meaningful tool count.
  const client = new McpClient({
    url: config.url,
    transport: config.transport,
    accessToken: tokens.accessToken
  });

  let tools: ConnectorTool[] = [];
  try {
    const handshake = await client.connectAndList();
    tools = handshake.tools;
  } catch (err) {
    inflightConnects.delete(id);
    await setConnectionRecord(ctx, {
      id,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
      tokenEndpoint: tokens.tokenEndpoint,
      issuer: tokens.issuer,
      registeredClientId: tokens.clientId,
      expiresAt: tokens.expiresAt
    });
    throw err;
  }

  inflightConnects.delete(id);
  const rec: ConnectionRecord = {
    id,
    status: "connected",
    connectedAt: Date.now(),
    tools,
    issuer: tokens.issuer,
    tokenEndpoint: tokens.tokenEndpoint,
    registeredClientId: tokens.clientId,
    expiresAt: tokens.expiresAt
  };
  await setConnectionRecord(ctx, rec);
  return toView(config, rec, !!findCatalog(id));
}

export async function disconnect(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  await deleteTokens(ctx, id);
  await clearConnectionRecord(ctx, id);
}

// ── Tool invocation (for future bridge to the model) ────────

/**
 * Invoke a tool on a previously-connected server. Refreshes the access
 * token transparently if it's expired and a refresh token is on file.
 */
export async function callTool(
  ctx: vscode.ExtensionContext,
  id: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
  const config = resolveConfig(ctx, id);
  if (!config) return { ok: false, error: `No connector with id "${id}".` };
  const conns = loadConnections(ctx);
  const rec = conns[id];
  let { accessToken, refreshToken, clientSecret } = await loadTokens(ctx, id);

  if (!accessToken) return { ok: false, error: "Not connected." };

  // Best-effort refresh if the token is known to be expired.
  if (rec?.expiresAt && Date.now() > rec.expiresAt - 30_000 && refreshToken && rec.tokenEndpoint && rec.registeredClientId) {
    try {
      const refreshed = await refreshAccessToken({
        tokenEndpoint: rec.tokenEndpoint,
        refreshToken,
        clientId: rec.registeredClientId,
        clientSecret
      });
      accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) refreshToken = refreshed.refreshToken;
      await saveTokens(ctx, id, {
        accessToken,
        refreshToken
      });
      await setConnectionRecord(ctx, { ...rec, expiresAt: refreshed.expiresAt });
    } catch {
      // Fall through and try the call anyway — the server will 401 and we'll error out.
    }
  }

  const client = new McpClient({
    url: config.url,
    transport: config.transport,
    accessToken
  });
  try {
    // Initialize on every call — Streamable HTTP is stateless from our side.
    await client.initialize();
    const res = await client.callTool(toolName, args);
    return { ok: true, content: res.content };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Internals ───────────────────────────────────────────────

function findCatalog(id: string): CatalogEntry | undefined {
  return CURATED_CATALOG.find((c) => c.id === id);
}

function resolveConfig(
  ctx: vscode.ExtensionContext,
  id: string
): CatalogEntry | null {
  const builtin = findCatalog(id);
  if (builtin) return builtin;
  const custom = loadCustomConnectors(ctx).find((c) => c.id === id);
  if (!custom) return null;
  return customAsCatalog(custom);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "connector";
}

export type { ConnectorTool } from "./storage.js";
export { OAuthCancelled } from "./oauth.js";

// ─────────────────────────────────────────────────────────────
// CLI bridge — write connected servers into a temp file the
// Claude Code CLI can consume via `--mcp-config <path>`.
//
// The CLI's MCP config format is:
//
//   {
//     "mcpServers": {
//       "<name>": {
//         "type": "http" | "sse" | "stdio",
//         "url":  "<url>",
//         "headers": { "Authorization": "Bearer <token>" }
//       }
//     }
//   }
//
// We emit one entry per server whose status === "connected" with
// a valid access token. The file is written to the OS temp dir
// with mode 0600 so it isn't readable by other users on a shared
// machine, and the caller is expected to call `cleanupCliMcpConfig`
// after the CLI exits.
// ─────────────────────────────────────────────────────────────

export interface CliMcpConfig {
  /** Absolute path to the JSON config; pass via `--mcp-config`. */
  path: string;
  /** Names of the server entries written — useful for logging. */
  serverNames: string[];
  /** Best-effort cleanup helper. */
  cleanup: () => Promise<void>;
}

/**
 * Materialize a Claude-CLI-compatible `--mcp-config` file containing
 * every currently-connected MCP server with its access token. Returns
 * `null` when there are no connected servers (caller should skip the
 * flag in that case so the CLI doesn't get an empty config).
 */
export async function writeCliMcpConfig(
  ctx: vscode.ExtensionContext
): Promise<CliMcpConfig | null> {
  const conns = loadConnections(ctx);
  const customs = loadCustomConnectors(ctx);

  // Collect connected entries paired with their resolved config + token.
  const entries: Array<{
    name: string;
    type: "http" | "sse";
    url: string;
    accessToken: string;
  }> = [];

  for (const rec of Object.values(conns)) {
    if (rec.status !== "connected") continue;
    const config = resolveConfig(ctx, rec.id);
    if (!config) continue;
    const tokens = await loadTokens(ctx, rec.id);
    if (!tokens.accessToken) continue;
    entries.push({
      name: cliServerName(rec.id),
      type: config.transport === "sse" ? "sse" : "http",
      url: config.url,
      accessToken: tokens.accessToken
    });
  }

  if (entries.length === 0) {
    void customs; // silence unused-binding lint when no customs are connected
    return null;
  }

  const mcpServers: Record<
    string,
    {
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
    }
  > = {};
  for (const e of entries) {
    mcpServers[e.name] = {
      type: e.type,
      url: e.url,
      headers: { Authorization: `Bearer ${e.accessToken}` }
    };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "klaude-mcp-"));
  const file = path.join(dir, "mcp.json");
  // Mode 0600 so the file with bearer tokens is readable only by us.
  await fs.writeFile(file, JSON.stringify({ mcpServers }, null, 2), {
    mode: 0o600
  });

  return {
    path: file,
    serverNames: entries.map((e) => e.name),
    cleanup: async () => {
      try {
        await fs.unlink(file);
        await fs.rmdir(dir);
      } catch {
        // best-effort: tmpdir cleanup will handle stragglers
      }
    }
  };
}

/**
 * Sanitize a connector id into a CLI-safe server name. The Claude CLI
 * exposes tools as `mcp__<name>__<tool>`, so the name needs to round-trip
 * through that pattern cleanly.
 */
export function cliServerName(id: string): string {
  // Keep alphanum + underscore + hyphen; collapse everything else.
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return cleaned || `connector_${crypto.randomBytes(3).toString("hex")}`;
}
