// ─────────────────────────────────────────────────────────────
// Connectors modal — Klaude's analog of claude.ai/customize/connectors.
//
// Shows the curated catalog + user-added custom connectors, each
// with a Connect / Disconnect button that drives the host-side
// OAuth + MCP-initialize flow. Adds an "Add custom connector"
// form for URL-based servers that aren't in the curated list.
//
// All actual work (HTTP + OAuth + tool discovery) happens in the
// extension host. This component is a thin RPC client.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { Icon, IconName } from "../../design/icons";
import { send, onMessage, ConnectorView, CustomConnectorDraft } from "../../lib/rpc";

export interface ConnectorsModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "all" | "connected" | "custom";

type Toast = { ok: boolean; text: string } | null;

export function ConnectorsModal({ open, onClose }: ConnectorsModalProps) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  // Refresh + subscribe to server messages while open.
  useEffect(() => {
    if (!open) return;
    send({ type: "requestConnectors" });
    return onMessage((m) => {
      if (m.type === "connectorsList") {
        setConnectors(m.connectors);
      } else if (m.type === "connectorResult") {
        // "cancel" is an explicit user-initiated bail-out, not an error and
        // not a success worth toasting. Just clear the spinner.
        if (m.action === "cancel") {
          setBusyId(null);
          return;
        }
        setBusyId(null);
        if (m.cancelled) {
          // Connect threw OAuthCancelled — same story: silent unstuck.
          return;
        }
        if (m.ok) {
          const verb =
            m.action === "connect"
              ? "Connected"
              : m.action === "disconnect"
                ? "Disconnected"
                : m.action === "add"
                  ? "Added"
                  : "Removed";
          setToast({ ok: true, text: `${verb} ${m.connector?.name ?? m.id}.` });
          if (m.action === "add") setAddOpen(false);
        } else {
          setToast({ ok: false, text: m.error ?? "Something went wrong." });
        }
        window.setTimeout(() => setToast(null), 4500);
      }
    });
  }, [open]);

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => {
      // "Connected" means servers the user connected *in Klaude* — managed
      // (Claude Code) servers are always-active but live under their own pill.
      if (tab === "connected" && (c.status !== "connected" || c.managed)) return false;
      if (tab === "custom" && c.builtIn) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.vendor.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    });
  }, [connectors, query, tab]);

  const counts = useMemo(() => {
    const connected = connectors.filter(
      (c) => c.status === "connected" && !c.managed
    ).length;
    const custom = connectors.filter((c) => !c.builtIn).length;
    return { connected, custom };
  }, [connectors]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal market"
        role="dialog"
        aria-label="Connectors"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="market-head">
          <div className="market-head-titles">
            <h2 className="market-title">Connectors</h2>
            <p className="market-sub">
              Browse and connect to remote MCP servers. Authentication uses
              OAuth — your browser will open to authorize.
            </p>
          </div>
          <button
            type="button"
            className="market-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="market-toolbar">
          <div className="market-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              placeholder="Search connectors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </div>
          <div className="market-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "all"}
              className={`market-tab${tab === "all" ? " active" : ""}`}
              onClick={() => setTab("all")}
            >
              All
              <span className="market-tab-count">{connectors.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "connected"}
              className={`market-tab${tab === "connected" ? " active" : ""}`}
              onClick={() => setTab("connected")}
              disabled={counts.connected === 0}
            >
              Connected
              {counts.connected > 0 && (
                <span className="market-tab-count">{counts.connected}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "custom"}
              className={`market-tab${tab === "custom" ? " active" : ""}`}
              onClick={() => setTab("custom")}
              disabled={counts.custom === 0}
            >
              Custom
              {counts.custom > 0 && (
                <span className="market-tab-count">{counts.custom}</span>
              )}
            </button>
            <button
              type="button"
              className="market-card-btn primary"
              style={{ marginLeft: "auto", padding: "6px 12px" }}
              onClick={() => setAddOpen(true)}
            >
              <Icon name="plus" size={11} />
              Add custom
            </button>
          </div>
        </div>

        <div className="market-grid">
          {filtered.length === 0 ? (
            <div className="market-empty">
              <Icon name="search" size={20} />
              <span>
                {connectors.length === 0
                  ? "Loading connectors…"
                  : query
                    ? `No connectors match "${query}".`
                    : "No connectors in this tab yet."}
              </span>
            </div>
          ) : (
            filtered.map((c) => (
              <ConnectorCard
                key={c.id}
                connector={c}
                busy={busyId === c.id}
                onConnect={() => {
                  setBusyId(c.id);
                  send({ type: "connectorConnect", id: c.id });
                }}
                onCancelConnect={() => {
                  // Optimistic: drop the spinner now; the host echoes back
                  // a "cancel" result that confirms the abort.
                  send({ type: "connectorCancelConnect", id: c.id });
                  setBusyId(null);
                }}
                onDisconnect={() => {
                  setBusyId(c.id);
                  send({ type: "connectorDisconnect", id: c.id });
                }}
                onRemove={() => {
                  setBusyId(c.id);
                  send({ type: "connectorRemoveCustom", id: c.id });
                }}
              />
            ))
          )}
        </div>

        {addOpen && (
          <AddCustomForm
            onCancel={() => setAddOpen(false)}
            onSubmit={(draft) => {
              setBusyId("__add__");
              send({ type: "connectorAddCustom", draft });
            }}
          />
        )}

        {toast && (
          <div className={`market-toast${toast.ok ? " ok" : " err"}`}>
            <Icon name={toast.ok ? "check" : "x"} size={11} />
            <span>{toast.text}</span>
          </div>
        )}

        <footer className="market-foot">
          <span>
            Connectors authenticate via OAuth. Tokens are stored in VS Code's
            SecretStorage.
          </span>
        </footer>
      </div>
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────

function ConnectorCard({
  connector,
  busy,
  onConnect,
  onCancelConnect,
  onDisconnect,
  onRemove
}: {
  connector: ConnectorView;
  busy: boolean;
  onConnect: () => void;
  onCancelConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const connected = connector.status === "connected";
  const errored = connector.status === "error";
  const managed = !!connector.managed;
  const isStdio = connector.transport === "stdio";
  const iconName = (connector.icon as IconName) ?? "cloud";
  // The card's hover title + the mono subtitle point at the endpoint:
  // a URL for remote servers, the command line for stdio ones.
  const target = connector.url ?? connector.command ?? "";

  return (
    <article
      className={`market-card${connected ? " installed" : ""}`}
      title={target}
    >
      <div className="market-card-head">
        <span className="market-card-icon">
          <Icon name={iconName} size={14} />
        </span>
        <div className="market-card-titles">
          <span className="market-card-name">{connector.name}</span>
          <span className="market-card-pub">
            <span className="market-card-cat">{connector.vendor}</span>
            {managed ? (
              <>
                <span className="market-card-dot" />
                <span style={{ color: "var(--accent)" }}>
                  Claude Code{connector.scope ? ` · ${connector.scope}` : ""}
                </span>
              </>
            ) : !connector.builtIn ? (
              <>
                <span className="market-card-dot" />
                <span style={{ color: "var(--accent)" }}>
                  {isStdio ? "local" : "custom"}
                </span>
              </>
            ) : null}
            {connected && !managed && (
              <>
                <span className="market-card-dot" />
                <span style={{ color: "var(--ok)" }}>
                  {connector.toolCount} tool{connector.toolCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </span>
        </div>
      </div>
      <p className="market-card-desc">{connector.description}</p>

      {(isStdio || managed) && target && (
        <p
          className="market-card-desc"
          style={{
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: 11,
            color: "var(--t3)",
            wordBreak: "break-all"
          }}
        >
          {target}
        </p>
      )}

      {errored && connector.lastError && (
        <p
          className="market-card-desc"
          style={{
            color: "var(--err)",
            background: "var(--err-soft)",
            padding: "6px 8px",
            borderRadius: 6,
            fontSize: 11
          }}
        >
          {connector.lastError}
        </p>
      )}

      <div className="market-card-actions">
        {connector.homepage && (
          <button
            type="button"
            className="market-card-btn ghost"
            onClick={() =>
              send({ type: "openExternal", url: connector.homepage! })
            }
          >
            <Icon name="book" size={11} />
            Docs
          </button>
        )}

        {managed ? (
          // Read-only — these are configured in Claude Code's own config.
          // Manage them with the `claude mcp` CLI; Klaude just surfaces them
          // and pre-allows their tools.
          <span
            className="market-card-btn ghost"
            style={{ marginLeft: "auto", cursor: "default", opacity: 0.85 }}
            title="Configured in Claude Code — manage with the `claude mcp` CLI"
          >
            <Icon name="check" size={11} />
            Managed by Claude Code
          </span>
        ) : (
          <>
            {!connector.builtIn && !connected && (
              <button
                type="button"
                className="market-card-btn danger"
                onClick={onRemove}
                disabled={busy}
              >
                <Icon name="x" size={11} />
                Remove
              </button>
            )}
            {connected ? (
              <button
                type="button"
                className="market-card-btn ghost"
                onClick={onDisconnect}
                disabled={busy}
                style={{ marginLeft: "auto" }}
              >
                <Icon name="logout" size={11} />
                Disconnect
              </button>
            ) : busy ? (
              isStdio ? (
                // Local spawn — no browser round-trip, so just a spinner.
                <span
                  className="market-card-btn ghost"
                  style={{ marginLeft: "auto", cursor: "default" }}
                  aria-live="polite"
                >
                  <span className="market-search-spinner" />
                  Starting…
                </span>
              ) : (
                // While OAuth is in-flight, the spinner sits next to a real
                // Cancel button so a stuck browser tab never freezes the UI.
                <>
                  <span
                    className="market-card-btn ghost"
                    style={{ marginLeft: "auto", cursor: "default" }}
                    aria-live="polite"
                  >
                    <span className="market-search-spinner" />
                    Waiting for browser…
                  </span>
                  <button
                    type="button"
                    className="market-card-btn danger"
                    onClick={onCancelConnect}
                    title="Cancel and close the local OAuth listener"
                  >
                    <Icon name="x" size={11} />
                    Cancel
                  </button>
                </>
              )
            ) : (
              <button
                type="button"
                className="market-card-btn primary"
                onClick={onConnect}
              >
                <Icon name={isStdio ? "play" : "arrow"} size={11} />
                {isStdio ? "Start" : "Connect"}
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

// ── Add custom form ────────────────────────────────────────

function AddCustomForm({
  onCancel,
  onSubmit
}: {
  onCancel: () => void;
  onSubmit: (draft: CustomConnectorDraft) => void;
}) {
  const [kind, setKind] = useState<"remote" | "stdio">("remote");
  const [name, setName] = useState("");
  // remote
  const [url, setUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // stdio
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");

  const canSubmit =
    name.trim().length > 0 &&
    (kind === "remote" ? url.trim().length > 0 : command.trim().length > 0);

  const submit = () => {
    if (kind === "stdio") {
      onSubmit({
        name: name.trim(),
        kind: "stdio",
        command: command.trim(),
        args: parseLines(argsText),
        env: parseEnv(envText)
      });
    } else {
      onSubmit({
        name: name.trim(),
        kind: "remote",
        url: url.trim(),
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined
      });
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onCancel}
      style={{ background: "rgba(5,5,9,0.5)" }}
    >
      <div
        className="modal"
        role="dialog"
        aria-label="Add custom connector"
        style={{ maxWidth: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="market-head">
          <div className="market-head-titles">
            <h2 className="market-title">Add custom connector</h2>
            <p className="market-sub">
              {kind === "remote"
                ? "Paste the URL of a remote MCP server. We'll discover its auth metadata, register a client, and open your browser to authorize."
                : "Run a local MCP server as a command (stdio) — the same as `claude mcp add <name> -- <command>`."}
            </p>
          </div>
          <button
            type="button"
            className="market-close"
            onClick={onCancel}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div
          style={{
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12
          }}
        >
          {/* Transport toggle — remote (URL) vs local (stdio command). */}
          <div
            role="tablist"
            style={{
              display: "flex",
              gap: 4,
              padding: 3,
              background: "var(--s2)",
              borderRadius: 8,
              border: "1px solid var(--b2)"
            }}
          >
            {(["remote", "stdio"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  background: kind === k ? "var(--b2)" : "transparent",
                  color: kind === k ? "var(--t1)" : "var(--t3)"
                }}
              >
                <Icon
                  name={k === "remote" ? "cloud" : "terminal"}
                  size={11}
                  style={{ marginRight: 5 }}
                />
                {k === "remote" ? "Remote URL" : "Local command"}
              </button>
            ))}
          </div>

          <Field label="Name">
            <input
              type="text"
              className="market-search-input"
              placeholder={kind === "remote" ? "My MCP server" : "filesystem"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              style={inputStyle}
              autoFocus
            />
          </Field>

          {kind === "remote" ? (
            <>
              <Field label="Server URL" hint="HTTPS only (except localhost).">
                <input
                  type="text"
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                  style={inputStyle}
                />
              </Field>

              <button
                type="button"
                className="inline-btn"
                onClick={() => setAdvanced((v) => !v)}
              >
                {advanced ? "Hide" : "Show"} advanced options
                <Icon
                  name={advanced ? "chevronU" : "chevronD"}
                  size={11}
                  style={{ marginLeft: 4 }}
                />
              </button>

              {advanced && (
                <>
                  <Field
                    label="OAuth client_id"
                    hint="Leave blank to use Dynamic Client Registration."
                  >
                    <input
                      type="text"
                      placeholder="(optional)"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      spellCheck={false}
                      style={inputStyle}
                    />
                  </Field>
                  <Field
                    label="OAuth client_secret"
                    hint="Stored in SecretStorage. Optional."
                  >
                    <input
                      type="password"
                      placeholder="(optional)"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      spellCheck={false}
                      style={inputStyle}
                    />
                  </Field>
                </>
              )}
            </>
          ) : (
            <>
              <Field label="Command" hint="The executable to run.">
                <input
                  type="text"
                  placeholder="npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  spellCheck={false}
                  style={inputStyle}
                />
              </Field>
              <Field label="Arguments" hint="One per line.">
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/allowed/dir"}
                  spellCheck={false}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--mono, ui-monospace, monospace)" }}
                />
              </Field>
              <Field label="Environment" hint="KEY=VALUE, one per line. Optional.">
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={"API_KEY=…"}
                  spellCheck={false}
                  rows={2}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--mono, ui-monospace, monospace)" }}
                />
              </Field>
            </>
          )}

          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 4
            }}
          >
            <button
              type="button"
              className="market-card-btn ghost"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="market-card-btn primary"
              disabled={!canSubmit}
              onClick={submit}
            >
              <Icon name="plus" size={11} />
              Add connector
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Split a textarea into trimmed, non-empty lines (one stdio arg per line). */
function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Parse `KEY=VALUE` lines into an env record (undefined when empty). */
function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (key) out[key] = t.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
    >
      <span style={{ fontWeight: 600, color: "var(--t2)" }}>{label}</span>
      {children}
      {hint && (
        <span style={{ color: "var(--t4)", fontSize: 10.5 }}>{hint}</span>
      )}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--s2)",
  border: "1px solid var(--b2)",
  borderRadius: 7,
  color: "var(--t1)",
  fontFamily: "inherit",
  fontSize: 13,
  outline: "none"
};
