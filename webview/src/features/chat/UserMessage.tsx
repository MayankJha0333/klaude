// ─────────────────────────────────────────────────────────────
// User message bubble. The wire body is plain markdown, but any
// `**file:lines**\n```lang\n…\n``` ` block was originally an
// inline code badge in the composer — so we re-collapse those
// patterns back into the same compact pill the user saw before
// they sent. Everything else passes through the markdown renderer.
// ─────────────────────────────────────────────────────────────

import { Fragment, MouseEvent, ReactNode, useMemo, useState } from "react";
import { Icon } from "../../design/icons";
import { renderMarkdown } from "./markdown";

interface UserMessageProps {
  id: string;
  text: string;
  canRewind?: boolean;
  messagesAfter?: number;
  onRewindRequest?: (turnId: string, messagesAfter: number) => void;
  onEditRequest?: (turnId: string) => void;
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "badge"; label: string; lang: string; code: string };

const BADGE_RE = /\*\*([^*\n]+)\*\*\n```([^\n]*)\n([\s\S]*?)\n```/g;

function parseBody(text: string): Part[] {
  const parts: Part[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  BADGE_RE.lastIndex = 0;
  while ((m = BADGE_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: "text", text: text.slice(lastIndex, m.index) });
    }
    parts.push({
      kind: "badge",
      label: m[1].trim(),
      lang: m[2].trim(),
      code: m[3]
    });
    lastIndex = BADGE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return parts;
}

export function UserMessage({
  id,
  text,
  canRewind,
  messagesAfter = 0,
  onRewindRequest,
  onEditRequest
}: UserMessageProps) {
  const parts = useMemo(() => parseBody(text), [text]);

  // Click anywhere on the bubble enters edit mode — but ignore clicks that
  // landed on an interactive child (badge expand button, the Rewind button,
  // a link, etc.) so those keep their own behavior.
  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onEditRequest) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a")) return;
    onEditRequest(id);
  };

  return (
    <div className="msg msg-user">
      <div className="msg-avatar">Y</div>
      <div
        className={`msg-body md${onEditRequest ? " msg-body-editable" : ""}`}
        onClick={handleBubbleClick}
        role={onEditRequest ? "button" : undefined}
        tabIndex={onEditRequest ? 0 : undefined}
        title={onEditRequest ? "Click to edit and re-run from here" : undefined}
      >
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <Fragment key={i}>{renderTextPart(p.text, i)}</Fragment>
          ) : (
            <MsgBadge key={i} label={p.label} lang={p.lang} code={p.code} />
          )
        )}
        {canRewind && (
          <div className="msg-actions">
            <button
              type="button"
              className="msg-action msg-rewind"
              onClick={(e) => {
                e.stopPropagation();
                onRewindRequest?.(id, messagesAfter);
              }}
              title="Rewind conversation to here"
            >
              <Icon name="history" size={11} />
              Rewind
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function renderTextPart(text: string, key: number): ReactNode {
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!trimmed) return null;
  return <Fragment key={key}>{renderMarkdown(trimmed)}</Fragment>;
}

function MsgBadge({
  label,
  lang,
  code
}: {
  label: string;
  lang: string;
  code: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`msg-badge-wrap${open ? " open" : ""}`}>
      <button
        type="button"
        className={`re-badge msg-badge${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={label}
      >
        <span className="re-badge-icon">{"</>"}</span>
        <span className="re-badge-label">{label}</span>
        <Icon name={open ? "chevronU" : "chevronD"} size={9} />
      </button>
      {open && (
        <pre className="msg-badge-code" data-lang={lang || "text"}>
          <code>{code}</code>
        </pre>
      )}
    </span>
  );
}
