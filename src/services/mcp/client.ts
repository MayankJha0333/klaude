// ─────────────────────────────────────────────────────────────
// Minimal MCP client — JSON-RPC 2.0 over Streamable HTTP (or
// legacy SSE). We only implement what Klaude needs today:
//
//   • initialize          — handshake + capability negotiation
//   • tools/list          — discover available tools
//   • tools/call          — invoke a tool with arguments
//
// We deliberately don't pull in @modelcontextprotocol/sdk: the
// extension already ships a Node bundle and the SDK adds a non-
// trivial dependency surface. The protocol shape we care about
// is small and stable.
//
// The server response can come back two ways depending on the
// `Accept` header and server behavior:
//
//   • application/json     — single JSON-RPC envelope (we use this)
//   • text/event-stream    — one envelope per `data:` line; we just
//                            read the first `event: message`'s data
// ─────────────────────────────────────────────────────────────

import * as crypto from "node:crypto";
import { ConnectorTool } from "./storage.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpClientOptions {
  /** The server's main MCP endpoint (the URL the user pastes / catalog ships). */
  url: string;
  /** Streamable-HTTP or legacy SSE. SSE servers usually still accept POSTs. */
  transport: "streamable-http" | "sse";
  /** Bearer token. Omit for servers that don't require auth. */
  accessToken?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}

export interface ToolsListResult {
  tools: ConnectorTool[];
}

export interface ToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: Record<string, unknown> }
  >;
  isError?: boolean;
}

// ── Public client ──────────────────────────────────────────

export class McpClient {
  private sessionId?: string;

  constructor(private readonly opts: McpClientOptions) {}

  /** Run the standard 3-call connection sweep: initialize + tools/list. */
  async connectAndList(): Promise<{
    info: InitializeResult;
    tools: ConnectorTool[];
  }> {
    const info = await this.initialize();
    let tools: ConnectorTool[] = [];
    if (info.capabilities && (info.capabilities as { tools?: unknown }).tools !== undefined) {
      const listed = await this.listTools();
      tools = listed.tools;
    }
    return { info, tools };
  }

  async initialize(): Promise<InitializeResult> {
    const result = await this.rpc<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "klaude-vscode", version: "0.1.0" }
    });
    // The server is meant to reply with its own session id in a header on
    // the response; we capture it in `rpc()` directly.
    // After initialize, the spec calls for a `notifications/initialized`
    // notification — fire it best-effort.
    void this.notify("notifications/initialized", {}).catch(() => undefined);
    return result;
  }

  async listTools(): Promise<ToolsListResult> {
    return this.rpc<ToolsListResult>("tools/list", {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return this.rpc<ToolCallResult>("tools/call", { name, arguments: args });
  }

  // ── Internals ─────────────────────────────────────────────

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = randomId();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? 30_000
    );

    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `MCP ${method} → HTTP ${res.status}: ${text || res.statusText}`
      );
    }

    // Capture the session id the server hands back on initialize. We send
    // it on every subsequent call so the server can route state.
    const sid = res.headers.get("mcp-session-id");
    if (sid && method === "initialize") this.sessionId = sid;

    const env = await parseEnvelope(res);
    if (env.error) {
      throw new Error(
        `MCP ${method} error ${env.error.code}: ${env.error.message}`
      );
    }
    return env.result as T;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    await fetch(this.opts.url, {
      method: "POST",
      headers: this.headers(),
      body
    }).catch(() => undefined);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "Klaude-VSCode/0.1.0"
    };
    if (this.opts.accessToken) {
      h.Authorization = `Bearer ${this.opts.accessToken}`;
    }
    if (this.sessionId) {
      h["Mcp-Session-Id"] = this.sessionId;
    }
    return h;
  }
}

// ── Envelope parsing ────────────────────────────────────────

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse either a JSON or SSE-formatted JSON-RPC response. SSE servers
 * stream `event: message\ndata: { ... }\n\n` blocks — we read the first
 * `data:` line whose JSON has `id` matching the request (or just the
 * first one we see if the server doesn't echo ids).
 */
async function parseEnvelope(res: Response): Promise<JsonRpcEnvelope> {
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (const d of dataLines) {
      try {
        const env = JSON.parse(d) as JsonRpcEnvelope;
        if (env.jsonrpc === "2.0" && (env.result !== undefined || env.error)) {
          return env;
        }
      } catch {
        // skip non-JSON events
      }
    }
    throw new Error("SSE stream contained no JSON-RPC envelope");
  }
  const text = await res.text();
  if (!text) throw new Error("Empty response body");
  return JSON.parse(text) as JsonRpcEnvelope;
}

function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
