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
  McpTransport,
  clearConnectionRecord,
  deleteTokens,
  deleteStdioEnv,
  loadConnections,
  loadCustomConnectors,
  loadStdioEnv,
  loadTokens,
  removeCustomConnector,
  saveCustomConnector,
  saveStdioEnv,
  saveTokens,
  setConnectionRecord
} from "./storage.js";
import { performOAuth, refreshAccessToken, OAuthCancelled } from "./oauth.js";
import { McpClient } from "./client.js";
import { StdioMcpClient } from "./stdio-client.js";
import { loadManagedServers, ManagedScope } from "./cli-config.js";

export interface ConnectorView {
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** Remote endpoint. Absent for stdio connectors. */
  url?: string;
  transport: McpTransport;
  categories: string[];
  icon: string;
  homepage?: string;
  builtIn: boolean;
  status: "connected" | "disconnected" | "error";
  connectedAt?: number;
  toolCount: number;
  tools?: ConnectorTool[];
  lastError?: string;
  /** stdio: the command line shown on the card (e.g. "npx -y @scope/server"). */
  command?: string;
  /** True for servers imported from Claude Code's own config (read-only). */
  managed?: boolean;
  /** For managed servers: which Claude Code scope they came from. */
  scope?: ManagedScope;
}

/** Merge catalog + custom + Claude-Code-managed servers into one UI list. */
export function listConnectors(ctx: vscode.ExtensionContext): ConnectorView[] {
  const conns = loadConnections(ctx);
  const customs = loadCustomConnectors(ctx);

  const fromCatalog: ConnectorView[] = CURATED_CATALOG.map((c) =>
    toView(c, conns[c.id], true)
  );
  const fromCustom: ConnectorView[] = customs.map((c) =>
    toView(customAsCatalog(c), conns[c.id], false)
  );

  // Servers the user already configured in Claude Code (read-only here). Skip
  // any whose name matches a connector Klaude itself connected, so the same
  // server doesn't show up twice. We compare on the human display name
  // (case-insensitively) rather than the CLI id — custom-connector ids are
  // hashed (`slug-<hash>`), so they'd never match a managed config key.
  const ownNames = new Set(
    [...CURATED_CATALOG, ...customs]
      .filter((c) => conns[c.id]?.status === "connected")
      .map((c) => c.name.toLowerCase())
  );
  const fromManaged: ConnectorView[] = listManagedViews().filter(
    (v) => !ownNames.has(v.name.toLowerCase())
  );

  return [...fromCatalog, ...fromCustom, ...fromManaged];
}

/** Map Claude Code's own MCP servers into read-only connector cards. */
function listManagedViews(): ConnectorView[] {
  const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  return loadManagedServers(cwd).map((s) => ({
    id: `managed:${s.scope}:${s.name}`,
    name: s.name,
    vendor: "Claude Code",
    description:
      s.transport === "stdio"
        ? `Local command managed by Claude Code (${s.scope}).`
        : `Remote MCP server managed by Claude Code (${s.scope}).`,
    url: s.url,
    transport: s.transport,
    categories: ["claude-code", s.scope],
    icon: s.transport === "stdio" ? "terminal" : "cloud",
    builtIn: true,
    // The CLI loads these for every turn, so from Klaude's vantage they're
    // effectively always "connected".
    status: "connected",
    toolCount: 0,
    command: s.transport === "stdio" ? commandLine(s.command, s.args) : undefined,
    managed: true,
    scope: s.scope
  }));
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
    lastError: rec?.lastError,
    command:
      c.transport === "stdio" ? commandLine(c.command, c.args) : undefined
  };
}

function customAsCatalog(c: CustomConnector): CatalogEntry {
  if (c.transport === "stdio") {
    return {
      id: c.id,
      name: c.name,
      vendor: "local",
      description: c.description ?? `Local MCP server: ${commandLine(c.command, c.args)}`,
      transport: "stdio",
      categories: ["custom", "local"],
      icon: "terminal",
      command: c.command,
      args: c.args,
      builtIn: false
    };
  }
  return {
    id: c.id,
    name: c.name,
    vendor: c.url ? new URL(c.url).host : "custom",
    description: c.description ?? `Custom MCP server at ${c.url ?? "?"}`,
    url: c.url,
    transport: c.transport,
    categories: ["custom"],
    icon: "cloud",
    builtIn: false
  };
}

/** Render a stdio command + args into a single display string. */
function commandLine(command?: string, args?: string[]): string {
  return [command ?? "", ...(args ?? [])].join(" ").trim();
}

// ── Add / remove custom ─────────────────────────────────────

export interface CustomDraft {
  name: string;
  /** "remote" (http/sse via `url`) or "stdio" (local `command`). Defaults to
   *  "remote" for back-compat with callers that only send name + url. */
  kind?: "remote" | "stdio";
  /** Remote transports: the server URL. */
  url?: string;
  /** Optional pre-registered OAuth client id (remote). */
  clientId?: string;
  /** Optional pre-registered client secret (remote). */
  clientSecret?: string;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables. */
  env?: Record<string, string>;
}

export async function addCustom(
  ctx: vscode.ExtensionContext,
  draft: CustomDraft
): Promise<ConnectorView> {
  const name = draft.name.trim();
  if (!name) throw new Error("Name is required.");
  const kind = draft.kind ?? "remote";

  if (kind === "stdio") {
    return addCustomStdio(ctx, name, draft);
  }
  return addCustomRemote(ctx, name, draft);
}

async function addCustomRemote(
  ctx: vscode.ExtensionContext,
  name: string,
  draft: CustomDraft
): Promise<ConnectorView> {
  const url = (draft.url ?? "").trim();
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

  const transport: McpTransport = /sse$/i.test(parsed.pathname) ? "sse" : "streamable-http";
  // Fix (#6): fold the *full* URL (path included) into the id. The previous
  // `slugify(name)-<host>` ignored the path, so `…/mcp` and `…/sse` on the
  // same host collided and the second save silently overwrote the first.
  const id = deriveConnectorId(name, `${transport}:${parsed.toString()}`);

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

async function addCustomStdio(
  ctx: vscode.ExtensionContext,
  name: string,
  draft: CustomDraft
): Promise<ConnectorView> {
  const command = (draft.command ?? "").trim();
  if (!command) throw new Error("Command is required for a local (stdio) server.");
  const args = (draft.args ?? []).map((a) => a.trim()).filter(Boolean);
  const env =
    draft.env && Object.keys(draft.env).length ? draft.env : undefined;

  // Discriminate on command + args so two stdio servers that differ only by
  // arguments get distinct ids (same anti-collision rationale as #6).
  const id = deriveConnectorId(name, `stdio:${command} ${args.join(" ")}`);

  const entry: CustomConnector = {
    id,
    name,
    transport: "stdio",
    command,
    args: args.length ? args : undefined,
    // Keep the executable name (not the full arg list) out of the persisted
    // description, since args can carry secrets; the full command line is
    // shown on the card via the `command` field, not stored here.
    description: `Local MCP server: ${command}`
  };
  await saveCustomConnector(ctx, entry);
  // Env values may be credentials — store them in the keychain, not globalState.
  if (env) await saveStdioEnv(ctx, id, env);

  const conns = loadConnections(ctx);
  return toView(customAsCatalog(entry), conns[id], false);
}

/**
 * Derive a stable connector id from the display name plus a discriminator —
 * the full URL for remote servers, or `command + args` for stdio. Folding the
 * discriminator into a short hash (rather than just name + host) means two
 * servers that differ only by URL path or by command no longer collapse to
 * the same id and overwrite each other (audit finding #6).
 */
export function deriveConnectorId(name: string, discriminator: string): string {
  const hash = crypto.createHash("sha256").update(discriminator).digest("hex").slice(0, 8);
  return `${slugify(name)}-${hash}`;
}

export async function removeCustom(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  await deleteTokens(ctx, id);
  await deleteStdioEnv(ctx, id);
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
 * Connect a connector by id. Dispatches by transport: stdio servers spawn
 * locally (no auth), remote servers run the OAuth flow. Throws on any
 * failure; the caller surfaces the message to the UI.
 */
export async function connect(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<ConnectorView> {
  const config = resolveConfig(ctx, id);
  if (!config) throw new Error(`No connector with id "${id}".`);

  // stdio servers are local — no OAuth, no browser. Spawn + handshake only.
  if (config.transport === "stdio") {
    return connectStdio(ctx, id, config);
  }
  return connectRemote(ctx, id, config);
}

/** Spawn a local stdio server, handshake, list its tools, then tear it down. */
async function connectStdio(
  ctx: vscode.ExtensionContext,
  id: string,
  config: CatalogEntry
): Promise<ConnectorView> {
  if (!config.command) {
    throw new Error("This stdio connector has no command configured.");
  }
  const client = new StdioMcpClient({
    command: config.command,
    args: config.args,
    env: await loadStdioEnv(ctx, id),
    cwd: vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath
  });

  let tools: ConnectorTool[] = [];
  try {
    const handshake = await client.connectAndList();
    tools = handshake.tools;
  } catch (err) {
    await setConnectionRecord(ctx, {
      id,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err)
    });
    throw err;
  }

  const rec: ConnectionRecord = {
    id,
    status: "connected",
    connectedAt: Date.now(),
    tools
  };
  await setConnectionRecord(ctx, rec);
  return toView(config, rec, !!findCatalog(id));
}

/**
 * Remote connect flow:
 *   1. Run OAuth (DCR + PKCE + browser loopback) → tokens.
 *   2. Initialize the MCP session and list its tools.
 *   3. Persist tokens, refresh metadata, and the connection record.
 *
 * Cancellable via `cancelConnect(id)` — useful when the user closes the
 * browser without finishing OAuth.
 */
async function connectRemote(
  ctx: vscode.ExtensionContext,
  id: string,
  config: CatalogEntry
): Promise<ConnectorView> {
  if (!config.url) throw new Error("This connector has no URL configured.");

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
    transport: config.transport === "sse" ? "sse" : "streamable-http",
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

  // stdio: spawn the command, handshake, invoke, tear down. No tokens.
  if (config.transport === "stdio") {
    if (!config.command) return { ok: false, error: "No command configured." };
    const stdio = new StdioMcpClient({
      command: config.command,
      args: config.args,
      env: await loadStdioEnv(ctx, id),
      cwd: vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath
    });
    try {
      const res = await stdio.callTool(toolName, args);
      return { ok: true, content: res.content };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const conns = loadConnections(ctx);
  const rec = conns[id];
  let { accessToken, refreshToken, clientSecret } = await loadTokens(ctx, id);

  if (!accessToken) return { ok: false, error: "Not connected." };
  if (!config.url) return { ok: false, error: "No URL configured." };

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
    transport: config.transport === "sse" ? "sse" : "streamable-http",
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
// CLI bridge — write Klaude's own connected servers into a temp file
// the Claude Code CLI consumes via `--mcp-config <path>`.
//
// The CLI's MCP config format (identical to ~/.claude.json / .mcp.json):
//
//   { "mcpServers": {
//       "<name>": { "type":"http"|"sse", "url":"…", "headers":{…} }   // remote
//       "<name>": { "type":"stdio", "command":"…", "args":[…], "env":{…} } // local
//   } }
//
// We materialize ONLY Klaude's own connected connectors here. Servers the
// user already configured in Claude Code (~/.claude.json + .mcp.json) are
// NOT re-emitted — the CLI loads them itself (we don't pass
// `--strict-mcp-config`) and re-listing would double-register them. We do,
// however, return their names in `serverNames` so their tools get pre-allowed
// alongside ours. The file is written to OS temp with mode 0600 because it
// holds bearer tokens; the caller calls `cleanup()` after the CLI exits.
// ─────────────────────────────────────────────────────────────

/** A single server entry in the CLI's `mcpServers` map. */
export type CliServerEntry =
  | { type: "http" | "sse"; url: string; headers: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export interface CliMcpConfig {
  /** Absolute path to the JSON config; pass via `--mcp-config`. Undefined when
   *  Klaude has no own connectors to write (managed servers still pre-allowed). */
  path?: string;
  /** Server names to pre-allow as `mcp__<name>` — Klaude's own + Claude Code's. */
  serverNames: string[];
  /** Best-effort cleanup helper. */
  cleanup: () => Promise<void>;
}

/**
 * Map a resolved connector config + (for remote) its access token into the
 * CLI's server-entry shape. Pure — returns null for shapes we can't emit
 * (remote with no url, stdio with no command). Exported for unit tests.
 */
export function toCliServerEntry(
  config: {
    transport: McpTransport;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  },
  accessToken?: string
): CliServerEntry | null {
  if (config.transport === "stdio") {
    if (!config.command) return null;
    const entry: CliServerEntry = { type: "stdio", command: config.command };
    if (config.args && config.args.length) entry.args = config.args;
    if (config.env && Object.keys(config.env).length) entry.env = config.env;
    return entry;
  }
  if (!config.url) return null;
  return {
    type: config.transport === "sse" ? "sse" : "http",
    url: config.url,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  };
}

/**
 * Materialize a Claude-CLI-compatible `--mcp-config` file for Klaude's own
 * connected connectors, and gather the full pre-allow name list (own +
 * Claude-Code-managed). Returns `null` only when there's nothing at all —
 * no own connectors AND no managed servers.
 */
export async function writeCliMcpConfig(
  ctx: vscode.ExtensionContext
): Promise<CliMcpConfig | null> {
  const conns = loadConnections(ctx);
  const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;

  // Klaude's own connected connectors → file entries.
  const own: Array<{ name: string; entry: CliServerEntry }> = [];
  for (const rec of Object.values(conns)) {
    if (rec.status !== "connected") continue;
    const config = resolveConfig(ctx, rec.id);
    if (!config) continue;
    let accessToken: string | undefined;
    let env: Record<string, string> | undefined;
    if (config.transport === "stdio") {
      env = await loadStdioEnv(ctx, rec.id); // secrets, not globalState
    } else {
      const tokens = await loadTokens(ctx, rec.id);
      if (!tokens.accessToken) continue; // remote without a token — skip
      accessToken = tokens.accessToken;
    }
    const entry = toCliServerEntry({ ...config, env }, accessToken);
    if (entry) own.push({ name: cliServerName(rec.id), entry });
  }

  // Servers Claude Code already manages → names only (CLI loads them itself).
  // Sanitize through the same transform the CLI applies when it builds tool
  // ids (`mcp__<namespace>__<tool>`); otherwise a managed server whose config
  // key has a dot/space/etc. would be pre-allowed under the wrong name and its
  // tools would stay gated.
  const ownNames = new Set(own.map((o) => o.name));
  const managedNames = loadManagedServers(cwd)
    .map((s) => cliToolNamespace(s.name))
    .filter((n) => !ownNames.has(n));

  const serverNames = [...own.map((o) => o.name), ...managedNames];

  if (own.length === 0) {
    // Nothing to write, but managed names may still need pre-allowing.
    if (serverNames.length === 0) return null;
    return { serverNames, cleanup: async () => undefined };
  }

  const mcpServers: Record<string, CliServerEntry> = {};
  for (const o of own) mcpServers[o.name] = o.entry;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "klaude-mcp-"));
  const file = path.join(dir, "mcp.json");
  // Mode 0600 so the file with bearer tokens is readable only by us.
  await fs.writeFile(file, JSON.stringify({ mcpServers }, null, 2), {
    mode: 0o600
  });

  return {
    path: file,
    serverNames,
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
  const cleaned = cliToolNamespace(id).slice(0, 48);
  return cleaned || `connector_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * The exact transform the Claude Code CLI applies to a server name when it
 * derives tool ids `mcp__<namespace>__<tool>` (it replaces every char outside
 * `[A-Za-z0-9_-]` with `_`, with no truncation). We use this to sanitize the
 * names of *imported* servers so our `mcp__<name>` pre-allow patterns line up
 * with the ids the CLI actually generates. `cliServerName` adds a length cap
 * and random fallback on top, for names we materialize into the config file.
 */
export function cliToolNamespace(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
