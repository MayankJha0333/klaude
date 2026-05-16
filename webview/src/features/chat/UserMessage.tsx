// ─────────────────────────────────────────────────────────────
// User message bubble. The wire body is plain markdown, but any
// `**file:lines**\n```lang\n…\n``` ` block was originally an
// inline code badge in the composer — so we re-collapse those
// patterns back into the same compact pill the user saw before
// they sent. Everything else passes through the markdown renderer.
//
// Copy behavior: badge pills hide the actual code behind a click-
// to-expand. A naive browser copy of a selection that includes a
// badge would grab only the visible button label (filename + chevron
// glyphs), not the underlying code. We intercept the `copy` event
// on the bubble and substitute each badge's full markdown body
// (`**file:lines**\n```lang\ncode\n```\n`) for its DOM contents in
// the clipboard payload — Cursor does the same thing. The visible
// UI is unaffected; only what lands in the clipboard changes.
// ─────────────────────────────────────────────────────────────

import {
  ClipboardEvent as ReactClipboardEvent,
  Fragment,
  MouseEvent,
  ReactNode,
  useMemo,
  useState
} from "react";
import { motion } from "framer-motion";
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
  const [copied, setCopied] = useState(false);

  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onEditRequest) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a")) return;
    // Don't enter edit mode if the user was selecting text or dragged.
    // A drag-to-select leaves a non-collapsed window selection at mouseup;
    // tearing down the message into the composer at that point would
    // destroy the selection before Cmd+C can fire. We let the click
    // through only when the user has not selected anything (single click).
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    onEditRequest(id);
  };

  const handleCopyButton = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // Build the clipboard payload from the parsed parts directly — this
    // works regardless of whether the user has any text selected.
    const out = parts
      .map((p) =>
        p.kind === "text"
          ? p.text
          : `**${p.label}**\n\`\`\`${p.lang}\n${p.code}\n\`\`\`\n`
      )
      .join("");
    try {
      await navigator.clipboard.writeText(out);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = out;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  /**
   * Replace any badge pill in the selection with its original markdown
   * (`**file:lines**\n```lang\ncode\n```\n`) before writing the clipboard
   * payload. We `cloneContents()` the selection (which gives us a detached
   * DocumentFragment we can mutate freely), swap every `[data-copy-text]`
   * element for a text node carrying the original markdown, then read the
   * fragment's textContent. If the selection contains no badge — there's
   * nothing to fix, so we let the browser handle copy natively.
   */
  const handleCopy = (e: ReactClipboardEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    const badges = fragment.querySelectorAll("[data-copy-text]");
    if (badges.length === 0) return;
    badges.forEach((b) => {
      const md = (b as HTMLElement).dataset.copyText ?? "";
      b.replaceWith(document.createTextNode(md));
    });
    const out = fragment.textContent ?? "";
    if (!out.trim()) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out);
  };

  const editable = !!onEditRequest;

  return (
    <motion.div
      className="msg msg-user flex items-start gap-2.5 group"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex-shrink-0 w-[26px] h-[26px] rounded-lg flex items-center justify-center text-[10.5px] font-bold tracking-[0.05em] mt-0.5 mr-1 bg-gradient-to-br from-s3 to-s2 border border-b2 text-t2">
        Y
      </div>
      <div
        className={`md flex-1 min-w-0 leading-[1.65] break-words text-[13.5px] py-1 pr-20 pl-4 text-t1 relative space-y-1.5 select-text [&>p]:my-0 [&>p+p]:mt-2${
          editable
            ? " cursor-text rounded-lg -ml-2.5 px-2.5 transition-[background,box-shadow] duration-[140ms] hover:bg-accent-soft hover:shadow-[inset_0_0_0_1px_var(--accent-mid)] focus-visible:outline-none focus-visible:bg-accent-soft focus-visible:shadow-[inset_0_0_0_1px_var(--accent-glow)]"
            : ""
        }`}
        onClick={handleBubbleClick}
        onCopy={handleCopy}
        role={editable ? "button" : undefined}
        tabIndex={editable ? 0 : undefined}
        title={editable ? "Click to edit and re-run from here" : undefined}
      >
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <Fragment key={i}>{renderTextPart(p.text, i)}</Fragment>
          ) : (
            <MsgBadge key={i} label={p.label} lang={p.lang} code={p.code} />
          )
        )}
        <div className="absolute top-1.5 right-0 inline-flex items-center gap-1 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            className="inline-flex items-center gap-1 bg-transparent border border-transparent text-t3 px-2 py-[3px] rounded-md cursor-pointer text-[11px] font-semibold font-[inherit] transition-colors duration-[140ms] hover:text-t1 hover:border-b2 hover:bg-s3"
            onClick={handleCopyButton}
            title="Copy message (including tagged code)"
            aria-label="Copy message"
          >
            <Icon name={copied ? "check" : "copy"} size={11} />
            {copied ? "Copied" : "Copy"}
          </button>
          {canRewind && (
            <button
              type="button"
              className="inline-flex items-center gap-1 bg-transparent border border-transparent text-t3 px-2 py-[3px] rounded-md cursor-pointer text-[11px] font-semibold font-[inherit] transition-colors duration-[140ms] hover:text-accent-glow hover:border-accent-mid hover:bg-accent-soft"
              onClick={(e) => {
                e.stopPropagation();
                onRewindRequest?.(id, messagesAfter);
              }}
              title="Rewind conversation to here"
            >
              <Icon name="history" size={11} />
              Rewind
            </button>
          )}
        </div>
      </div>
    </motion.div>
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
  // The original markdown the user typed/dragged. `onCopy` on the bubble
  // reads this attribute and substitutes it for the visible button text
  // so a copy of "the pill" yields the actual code, not just the filename.
  const copyText = `**${label}**\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  return (
    <span
      className={`inline-flex flex-col align-middle my-1${open ? " w-full" : ""}`}
      data-copy-text={copyText}
    >
      <button
        type="button"
        className={`re-badge inline-flex items-center gap-1.5 px-2 py-[3px] rounded-md bg-s2 border border-b2 text-t2 text-[11.5px] font-mono cursor-pointer align-middle transition-colors duration-[120ms] hover:bg-s3 hover:text-t1 hover:border-b3${
          open ? " bg-s3 text-t1 border-b3" : ""
        }`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={label}
      >
        <span className="re-badge-icon font-mono text-accent-glow text-[10px] font-bold">{"</>"}</span>
        <span className="re-badge-label">{label}</span>
        <Icon name={open ? "chevronU" : "chevronD"} size={9} />
      </button>
      {open && (
        <pre
          className="mt-1.5 mb-2 px-3 py-2 rounded-md bg-s2 border border-b1 text-[12px] font-mono text-t2 leading-[1.55] whitespace-pre-wrap break-words overflow-x-auto"
          data-lang={lang || "text"}
        >
          <code>{code}</code>
        </pre>
      )}
    </span>
  );
}
