// ─────────────────────────────────────────────────────────────
// Curated MCP connector catalog.
//
// Mirrors the "Browse connectors" list claude.ai surfaces at
// https://claude.ai/customize/connectors. Anthropic's directory
// is hand-maintained — we do the same here, hard-coding the
// public Streamable-HTTP / SSE endpoints exposed by each vendor.
//
// All entries are *remote* MCP servers (URL-based). STDIO
// servers from the public MCP Registry aren't surfaced because
// they can't be configured purely through Claude.ai-style
// "Connect" + OAuth — they need local install + spawn.
//
// To add a connector:
//   1. Drop a new entry below with a stable id, the public URL,
//      and a short description.
//   2. If the vendor doesn't support Dynamic Client Registration
//      yet, expose `requiresManualClient: true` so the UI asks
//      the user to paste a pre-issued client_id / client_secret.
// ─────────────────────────────────────────────────────────────
import { IconName } from "./icons.js";

export interface CatalogEntry {
  /** Stable id used as the key in storage + secret keychain. */
  id: string;
  /** Display name (e.g. "Linear"). */
  name: string;
  /** Vendor / namespace (e.g. "linear.app"). */
  vendor: string;
  /** One-line description shown on the card. */
  description: string;
  /** Public MCP server URL — POST endpoint for Streamable-HTTP. Absent for
   *  stdio entries (custom connectors only; the curated catalog is all remote). */
  url?: string;
  /** Streamable-HTTP is the modern transport; SSE is legacy; stdio is a
   *  locally-spawned command (custom connectors only). */
  transport: "streamable-http" | "sse" | "stdio";
  /** Categorical tags used by the UI to filter. */
  categories: string[];
  /** Icon name from our local set. */
  icon: IconName;
  /** Marketing URL — opened from the card's "Learn more" link. */
  homepage?: string;
  /** If true, the server doesn't yet support RFC 7591 DCR and the
   *  user must paste a client_id / client_secret manually. */
  requiresManualClient?: boolean;
  /** OAuth scope hint passed to the authorize endpoint. */
  scope?: string;
  /** Whether this connector is built-in (cannot be removed). */
  builtIn?: boolean;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables merged into the child's env. */
  env?: Record<string, string>;
}

/**
 * Curated catalog. Source: claude.ai/customize/connectors plus the
 * publicly-documented remote MCP endpoints each vendor ships.
 *
 * URLs are the canonical "/mcp" or "/sse" endpoint each vendor
 * advertises in their MCP integration docs. We don't hit any of
 * these until the user clicks Connect.
 */
export const CURATED_CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    id: "linear",
    name: "Linear",
    vendor: "linear.app",
    description:
      "Read and update issues, projects, and cycles in your Linear workspace.",
    url: "https://mcp.linear.app/mcp",
    transport: "streamable-http",
    categories: ["productivity", "issues"],
    icon: "branch",
    homepage: "https://linear.app/docs/mcp",
    builtIn: true
  },
  {
    id: "notion",
    name: "Notion",
    vendor: "notion.com",
    description:
      "Search pages and databases, create or update notes in Notion.",
    url: "https://mcp.notion.com/mcp",
    transport: "streamable-http",
    categories: ["productivity", "docs"],
    icon: "book",
    homepage: "https://developers.notion.com/docs/mcp",
    builtIn: true
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira & Confluence)",
    vendor: "atlassian.com",
    description:
      "Query Jira issues and Confluence pages across your Atlassian Cloud sites.",
    url: "https://mcp.atlassian.com/v1/sse",
    transport: "sse",
    categories: ["productivity", "issues", "docs"],
    icon: "layers",
    homepage:
      "https://support.atlassian.com/rovo/docs/configure-mcp-server-for-rovo",
    builtIn: true
  },
  {
    id: "asana",
    name: "Asana",
    vendor: "asana.com",
    description: "Browse projects and tasks, post comments, mark work complete.",
    url: "https://mcp.asana.com/sse",
    transport: "sse",
    categories: ["productivity"],
    icon: "check",
    homepage: "https://developers.asana.com/docs/mcp",
    builtIn: true
  },
  {
    id: "intercom",
    name: "Intercom",
    vendor: "intercom.com",
    description: "Search conversations and contacts; draft Intercom replies.",
    url: "https://mcp.intercom.com/sse",
    transport: "sse",
    categories: ["support", "customer"],
    icon: "user",
    homepage: "https://developers.intercom.com/docs/mcp",
    builtIn: true
  },
  {
    id: "sentry",
    name: "Sentry",
    vendor: "sentry.io",
    description: "Pull issues, events, and releases from your Sentry org.",
    url: "https://mcp.sentry.dev/mcp",
    transport: "streamable-http",
    categories: ["observability", "errors"],
    icon: "shield",
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
    builtIn: true
  },
  {
    id: "paypal",
    name: "PayPal",
    vendor: "paypal.com",
    description: "Read transactions, refunds, and invoices in your PayPal account.",
    url: "https://mcp.paypal.com/sse",
    transport: "sse",
    categories: ["commerce", "finance"],
    icon: "cloud",
    homepage: "https://developer.paypal.com/docs/mcp/",
    builtIn: true
  },
  {
    id: "hubspot",
    name: "HubSpot",
    vendor: "hubspot.com",
    description:
      "Pull contacts, deals, and tickets from HubSpot; add notes and updates.",
    url: "https://mcp.hubspot.com/anthropic",
    transport: "streamable-http",
    categories: ["crm", "sales"],
    icon: "user",
    homepage: "https://developers.hubspot.com/docs/mcp",
    builtIn: true
  },
  {
    id: "stripe",
    name: "Stripe",
    vendor: "stripe.com",
    description: "Look up customers, charges, and invoices in your Stripe account.",
    url: "https://mcp.stripe.com/",
    transport: "streamable-http",
    categories: ["commerce", "finance"],
    icon: "cloud",
    homepage: "https://docs.stripe.com/agentic-payments",
    builtIn: true
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    vendor: "cloudflare.com",
    description: "Manage Workers, KV, and zones from your Cloudflare account.",
    url: "https://docs.mcp.cloudflare.com/sse",
    transport: "sse",
    categories: ["infra", "devops"],
    icon: "cloud",
    homepage: "https://developers.cloudflare.com/agents/model-context-protocol/",
    builtIn: true
  }
];

/**
 * Find a curated entry by id. Returns undefined if the id is for a
 * user-added custom connector.
 */
export function findCatalog(id: string): CatalogEntry | undefined {
  return CURATED_CATALOG.find((e) => e.id === id);
}
