// ─────────────────────────────────────────────────────────────
// FileDiffModal — modal that shows what changed for one file in a
// turn. Aggregates all Write / Edit / MultiEdit tool calls that
// targeted the same path and renders a unified diff per change.
//
// Visual layout:
//   ┌─────────────────────────────────────────────────┐
//   │  📄  app/foo / Bar.tsx       WROTE   +12 −3    │  ← sticky header
//   │  ~/proj/src/app/foo/Bar.tsx                     │
//   ├─────────────────────────────────────────────────┤
//   │  Write 1 / 2                  +120              │
//   │  1 + const dayjs = …                            │  ← diff body
//   │  2 + const …                                    │
//   └─────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Icon } from "../../design/icons";
import { send } from "../../lib/rpc";

export type FileChange =
  | { kind: "write"; newText: string }
  | { kind: "edit"; oldText: string; newText: string };

export interface FileEditEntry {
  id: string;
  path: string;
  /** "Created", "Edited", "Wrote" — displayed in the row & header. */
  action: "Created" | "Edited" | "Wrote" | "Updated";
  changes: FileChange[];
  /** True when any tool call for this path is still streaming/awaiting result. */
  pending?: boolean;
  /** True when any tool call for this path returned an error. */
  errored?: boolean;
}

export interface DiffLineNote {
  path: string;
  lineNo: number;
  text: string;
  context: string;
}

interface FileDiffModalProps {
  entry: FileEditEntry;
  onClose: () => void;
  /** Where on screen the click originated — modal will spring out of this rect. */
  originRect?: DOMRect | null;
  onAddNote?: (note: DiffLineNote) => void;
}

export function FileDiffModal({ entry, onClose, originRect, onAddNote }: FileDiffModalProps) {
  const [copied, setCopied] = useState(false);
  const [noteFor, setNoteFor] = useState<{ lineNo: number; context: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // Derive initial translate/scale so the modal appears to morph out of the
  // row that was clicked. With no origin, fall back to a centered fade.
  const initialTransform = useMemo(() => {
    if (!originRect) return { x: 0, y: 18, scale: 0.96, opacity: 0 };
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const ox = originRect.left + originRect.width / 2;
    const oy = originRect.top + originRect.height / 2;
    return {
      x: (ox - cx) * 0.25,
      y: (oy - cy) * 0.25,
      scale: 0.94,
      opacity: 0
    };
  }, [originRect]);

  // ESC to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals = useMemo(() => computeTotals(entry), [entry]);
  const crumbs = useMemo(() => makeCrumbs(entry.path), [entry.path]);
  const ext = useMemo(() => extOf(entry.path), [entry.path]);

  const copyDiff = async () => {
    const text = entry.changes
      .map((c) => diffChange(c).map((r) => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`).join("\n"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-stretch justify-center p-3 sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onClick={onClose}
      style={{ backgroundColor: "rgba(8,8,12,0.65)", backdropFilter: "blur(4px)" }}
    >
      <motion.div
        initial={initialTransform}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.985, transition: { duration: 0.14, ease: "easeIn" } }}
        transition={{ type: "spring", stiffness: 280, damping: 28, mass: 0.9 }}
        className="my-auto w-full max-w-[920px] max-h-full flex flex-col bg-s1 border border-b2 rounded-2xl overflow-hidden"
        style={{
          boxShadow:
            "0 28px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset"
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${baseName(entry.path)}`}
      >
        {/* ─────────────────── Header ─────────────────── */}
        <div
          className="flex items-start justify-between gap-3 px-4 py-3 border-b border-b1 bg-gradient-to-b from-s1 to-s1/85 flex-shrink-0"
          style={{ boxShadow: "0 1px 0 var(--b1)" }}
        >
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.05, type: "spring", stiffness: 340, damping: 22 }}
              className="w-9 h-9 rounded-lg inline-flex items-center justify-center flex-shrink-0 border border-accent-mid"
              style={{
                background:
                  "linear-gradient(135deg, var(--accent-soft), rgba(99,102,241,0.05))",
                color: ext.color ?? "var(--accent-glow)",
                boxShadow: "0 2px 14px var(--accent-shadow)"
              }}
            >
              <Icon name="edit" size={14} />
            </motion.div>
            <div className="flex flex-col min-w-0 flex-1 gap-1">
              {/* Title row: filename + action + stats */}
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <span className="text-[14px] font-bold text-t1 tracking-[-0.2px] truncate">
                  {baseName(entry.path)}
                </span>
                <ActionPill action={entry.action} />
                {(totals.added > 0 || totals.removed > 0) && (
                  <span className="inline-flex items-center gap-2 text-[11px] font-mono font-bold tracking-[0.1px]">
                    {totals.added > 0 && (
                      <span className="text-[var(--add-line)]">+{totals.added}</span>
                    )}
                    {totals.removed > 0 && (
                      <span className="text-[var(--del-line)]">−{totals.removed}</span>
                    )}
                  </span>
                )}
              </div>
              {/* Breadcrumb row */}
              <BreadcrumbRow crumbs={crumbs} />
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <HeaderButton
              icon="copy"
              label={copied ? "Copied" : "Copy diff"}
              onClick={copyDiff}
              active={copied}
            />
            <HeaderButton
              icon="arrow"
              label="Open"
              onClick={() => send({ type: "openFile", path: entry.path })}
            />
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-md inline-flex items-center justify-center bg-transparent hover:bg-s2 text-t3 hover:text-t1 cursor-pointer border-0 font-[inherit] transition-colors"
              aria-label="Close"
              title="Close (Esc)"
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        </div>

        {/* ─────────────────── Body ─────────────────── */}
        <div className="flex-1 overflow-y-auto bg-s0 px-3.5 py-3.5">
          {entry.changes.length === 0 ? (
            <EmptyDiff path={entry.path} />
          ) : (
            <div className="flex flex-col gap-3">
              {entry.changes.map((c, i) => (
                <ChangeBlock
                  key={i}
                  change={c}
                  index={i}
                  total={entry.changes.length}
                  onLineClick={
                    onAddNote
                      ? (lineNo, context) => {
                          setNoteFor({ lineNo, context });
                          setNoteDraft("");
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>

        <AnimatePresence>
          {noteFor && (
            <motion.div
              key="note-popover"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}
              className="absolute left-1/2 -translate-x-1/2 bottom-12 z-10 w-[88%] max-w-[640px] rounded-xl border border-accent-mid bg-s2 p-3"
              style={{ boxShadow: "0 14px 36px rgba(0,0,0,0.5)" }}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="text-[11px] text-accent-glow font-semibold uppercase tracking-[0.5px]">
                  Comment on line {noteFor.lineNo}
                </div>
                <button
                  type="button"
                  onClick={() => setNoteFor(null)}
                  className="w-6 h-6 rounded-md bg-transparent hover:bg-s3 text-t3 hover:text-t1 cursor-pointer border-0 inline-flex items-center justify-center font-[inherit] transition-colors"
                  aria-label="Close note"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
              <pre className="text-[11px] text-t3 font-mono bg-s0 border border-b1 rounded-md px-2 py-1.5 mb-2 truncate">
                {noteFor.context}
              </pre>
              <textarea
                value={noteDraft}
                autoFocus
                rows={2}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Leave a note — it'll be added to your next prompt as context."
                className="w-full bg-s0 border border-b1 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] rounded-md px-2.5 py-1.5 text-[12px] text-t1 placeholder:text-t4 font-[inherit] resize-none outline-none transition-[border-color,box-shadow]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!noteDraft.trim() || !onAddNote) return;
                    onAddNote({
                      path: entry.path,
                      lineNo: noteFor.lineNo,
                      text: noteDraft.trim(),
                      context: noteFor.context
                    });
                    setNoteFor(null);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNoteFor(null);
                  }
                }}
              />
              <div className="flex items-center justify-between mt-2">
                <div className="text-[10px] text-t4">
                  <kbd className="font-mono text-[10px] px-1 py-[1px] rounded bg-s3 border border-b2 text-t3">↵</kbd>{" "}
                  to add ·{" "}
                  <kbd className="font-mono text-[10px] px-1 py-[1px] rounded bg-s3 border border-b2 text-t3">Esc</kbd>{" "}
                  to cancel
                </div>
                <button
                  type="button"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    if (!noteDraft.trim() || !onAddNote) return;
                    onAddNote({
                      path: entry.path,
                      lineNo: noteFor.lineNo,
                      text: noteDraft.trim(),
                      context: noteFor.context
                    });
                    setNoteFor(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent text-white border-0 cursor-pointer font-[inherit] text-[11px] font-semibold transition-colors hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add to next prompt
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─────────────────── Footer ─────────────────── */}
        <div className="px-4 py-2 border-t border-b1 bg-s1/60 flex items-center justify-between text-[11px] text-t4">
          <span>
            <kbd className="font-mono text-[10px] px-1.5 py-[2px] rounded bg-s2 border border-b2 text-t3">Esc</kbd>
            <span className="ml-1.5">to close</span>
          </span>
          <span className="font-mono">
            {entry.changes.length} {entry.changes.length === 1 ? "change" : "changes"}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────── Sub-components ───────────────────

function ActionPill({ action }: { action: FileEditEntry["action"] }) {
  const color = action === "Wrote" || action === "Created"
    ? { bg: "rgba(52, 211, 153, 0.14)", border: "rgba(52, 211, 153, 0.35)", text: "#34d399" }
    : { bg: "var(--accent-soft)", border: "var(--accent-mid)", text: "var(--accent-glow)" };
  return (
    <span
      className="inline-flex items-center px-1.5 py-[2px] rounded text-[9.5px] font-extrabold uppercase tracking-[0.7px] border"
      style={{ background: color.bg, borderColor: color.border, color: color.text }}
    >
      {action}
    </span>
  );
}

function BreadcrumbRow({ crumbs }: { crumbs: string[] }) {
  if (crumbs.length === 0) return null;
  return (
    <div className="flex items-center gap-1 text-[11px] text-t4 font-mono truncate min-w-0">
      {crumbs.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-t4/70">/</span>}
          <span className="truncate hover:text-t2 transition-colors">{c}</span>
        </span>
      ))}
    </div>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
  active
}: {
  icon: "copy" | "arrow";
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold cursor-pointer transition-colors font-[inherit] border",
        active
          ? "bg-accent-soft text-accent-glow border-accent-mid"
          : "bg-s2 hover:bg-s3 border-b1 hover:border-b2 text-t2 hover:text-t1"
      ].join(" ")}
      title={label}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
}

function EmptyDiff({ path }: { path: string }) {
  return (
    <div className="text-center py-16 px-6">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-s2 border border-b1 text-t4 mb-3">
        <Icon name="file" size={18} />
      </div>
      <div className="text-[13px] font-semibold text-t2 mb-1">No diff payload</div>
      <div className="text-[11.5px] text-t4 font-mono">{path}</div>
      <div className="text-[11.5px] text-t3 mt-3">
        Open the file in the editor to inspect its current state.
      </div>
      <button
        type="button"
        onClick={() => send({ type: "openFile", path })}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white border-0 cursor-pointer font-[inherit] text-[11.5px] font-semibold transition-colors hover:bg-accent-deep"
      >
        <Icon name="arrow" size={11} />
        Open file
      </button>
    </div>
  );
}

function ChangeBlock({
  change,
  index,
  total,
  onLineClick
}: {
  change: FileChange;
  index: number;
  total: number;
  onLineClick?: (lineNo: number, context: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(() => diffChange(change), [change]);
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  // Compute line-numbers for old/new sides like a real unified diff
  const numbered = useMemo(() => assignLineNumbers(rows), [rows]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 * index, duration: 0.22, ease: "easeOut" }}
      className="rounded-lg border border-b1 bg-s1 overflow-hidden"
      style={{ boxShadow: "0 1px 0 var(--b1) inset" }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-gradient-to-b from-s2 to-s2/70 border-b border-b1 cursor-pointer font-[inherit] hover:from-s3 hover:to-s2 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="inline-flex w-4 h-4 items-center justify-center text-t3">
            <Icon name={collapsed ? "chevronR" : "chevronD"} size={9} />
          </span>
          <span
            className={[
              "text-[10px] font-extrabold uppercase tracking-[0.7px] px-1.5 py-[2px] rounded",
              change.kind === "write"
                ? "bg-[rgba(52,211,153,0.14)] text-[#34d399] border border-[rgba(52,211,153,0.3)]"
                : "bg-accent-soft text-accent-glow border border-accent-mid"
            ].join(" ")}
          >
            {change.kind === "write" ? "Write" : "Edit"}
          </span>
          {total > 1 && (
            <span className="text-[10.5px] text-t4 font-mono">
              {index + 1} of {total}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 text-[10.5px] font-mono font-semibold">
          {added > 0 && <span className="text-[var(--add-line)]">+{added}</span>}
          {removed > 0 && <span className="text-[var(--del-line)]">−{removed}</span>}
        </span>
      </button>
      {!collapsed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="font-mono text-[11.75px] leading-[1.65] overflow-x-auto bg-s0/50"
        >
          {numbered.map((r, i) => (
            <DiffLine
              key={i}
              row={r}
              onClick={
                onLineClick && (r.kind === "add" || r.kind === "del")
                  ? () =>
                      onLineClick(r.newNo ?? r.oldNo ?? i + 1, r.text)
                  : undefined
              }
            />
          ))}
        </motion.div>
      )}
    </motion.div>
  );
}

interface NumberedRow {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

function assignLineNumbers(rows: ReadonlyArray<DiffRow>): NumberedRow[] {
  let o = 0;
  let n = 0;
  return rows.map((r) => {
    if (r.kind === "add") {
      n++;
      return { ...r, newNo: n };
    }
    if (r.kind === "del") {
      o++;
      return { ...r, oldNo: o };
    }
    o++;
    n++;
    return { ...r, oldNo: o, newNo: n };
  });
}

function DiffLine({ row, onClick }: { row: NumberedRow; onClick?: () => void }) {
  const isAdd = row.kind === "add";
  const isDel = row.kind === "del";
  const bg = isAdd
    ? "bg-[var(--add-bg)] hover:bg-[var(--add-bg)] hover:brightness-125"
    : isDel
      ? "bg-[var(--del-bg)] hover:bg-[var(--del-bg)] hover:brightness-125"
      : "hover:bg-s1/40";
  const marker = isAdd ? "+" : isDel ? "−" : " ";
  const markerColor = isAdd
    ? "text-[var(--add-line)]"
    : isDel
      ? "text-[var(--del-line)]"
      : "text-t4/50";
  const borderColor = isAdd
    ? "border-l-[var(--add-line)]/60"
    : isDel
      ? "border-l-[var(--del-line)]/60"
      : "border-l-transparent";
  return (
    <div
      className={`flex items-stretch group transition-[filter,background] ${bg} ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
      title={onClick ? "Click to comment on this line" : undefined}
    >
      <span className="w-10 flex-shrink-0 select-none text-right pr-2 text-t4/70 text-[10.5px] py-[2px] border-r border-b1/40">
        {row.oldNo ?? ""}
      </span>
      <span className="w-10 flex-shrink-0 select-none text-right pr-2 text-t4/70 text-[10.5px] py-[2px] border-r border-b1/40">
        {row.newNo ?? ""}
      </span>
      <span
        className={`w-5 flex-shrink-0 select-none text-center font-bold border-l-2 ${markerColor} ${borderColor}`}
      >
        {marker}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-all py-[2px] pl-2 pr-3 text-t1 relative">
        {row.text || " "}
        {onClick && (
          <span className="absolute right-1 top-[2px] opacity-0 group-hover:opacity-100 transition-opacity text-[9px] uppercase tracking-[0.4px] text-accent-glow font-bold bg-accent-soft border border-accent-mid px-1 py-[1px] rounded leading-none pointer-events-none">
            + note
          </span>
        )}
      </span>
    </div>
  );
}

// ─────────────────── Diff helpers ───────────────────

type DiffRow = { kind: "add" | "del" | "ctx"; text: string };

function diffChange(c: FileChange): DiffRow[] {
  if (c.kind === "write") {
    return c.newText.split("\n").map((line) => ({ kind: "add", text: line }));
  }
  return diffLines(c.oldText, c.newText);
}

function diffLines(a: string, b: string): DiffRow[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      rows.push({ kind: "ctx", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", text: aLines[i++] });
    } else {
      rows.push({ kind: "add", text: bLines[j++] });
    }
  }
  while (i < m) rows.push({ kind: "del", text: aLines[i++] });
  while (j < n) rows.push({ kind: "add", text: bLines[j++] });
  return rows;
}

function computeTotals(entry: FileEditEntry): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of entry.changes) {
    const rows = diffChange(c);
    for (const r of rows) {
      if (r.kind === "add") added++;
      else if (r.kind === "del") removed++;
    }
  }
  return { added, removed };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function makeCrumbs(path: string): string[] {
  const cleaned = path.replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = cleaned.split("/").filter(Boolean);
  // Drop the last part (filename) — already shown in the title row.
  const dir = parts.slice(0, -1);
  // Trim middle if it's very long
  if (dir.length <= 5) return dir;
  return [...dir.slice(0, 2), "…", ...dir.slice(-2)];
}

const EXT_COLORS: Record<string, string> = {
  ts: "#3b82f6", tsx: "#3b82f6",
  js: "#eab308", jsx: "#eab308",
  py: "#22c55e",
  rs: "#f97316",
  go: "#06b6d4",
  json: "#eab308",
  md: "#60a5fa",
  css: "#ec4899",
  html: "#ef4444",
  java: "#f97316",
  rb: "#ef4444"
};

function extOf(path: string): { color?: string } {
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return {};
  return { color: EXT_COLORS[m[1].toLowerCase()] };
}
