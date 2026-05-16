// ─────────────────────────────────────────────────────────────
// InlineEditPreview — Cursor-style compact diff card shown inline
// as the agent writes/edits a file.
//
// Visual contract (matches Cursor exactly):
//   ┌──────────────────────────────────────────────────────┐
//   │ [JS]  budgetAdvisor.js                    +21 -1     │
//   ├──────────────────────────────────────────────────────┤
//   │ const prioritizeRecommendations = (...) =             │ (dim)
//   │ if (!estimatedDailyBudget …) return recommendations;  │ (red bg)
//   │ if (!estimatedDailyBudget …) {                        │ (green bg)
//   │   cronLogger.debug(                                   │ (dim)
//   └──────────────────────────────────────────────────────┘
//
// The body has *no* `+` / `−` marker column — change type is
// conveyed solely by line background and unchanged context lines
// render dimmer.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FileEditEntry } from "./FileDiffModal";
import { FileBadge } from "./FileBadge";

interface InlineEditPreviewProps {
  entry: FileEditEntry;
  onOpenFull: (rect: DOMRect | null) => void;
}

const PREVIEW_LIMIT = 8;

export function InlineEditPreview({ entry, onOpenFull }: InlineEditPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const allRows = useMemo(() => buildRows(entry), [entry]);
  const stats = useMemo(() => countStats(allRows), [allRows]);

  const visibleRows = expanded
    ? allRows.slice(0, 200)
    : trimPreview(allRows, PREVIEW_LIMIT);
  const hiddenLines = Math.max(0, allRows.length - visibleRows.length);
  const name = baseName(entry.path);

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="rounded-md border border-b1 overflow-hidden"
    >
      <button
        type="button"
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement)
            .closest("[data-edit-preview]")
            ?.getBoundingClientRect() ?? null;
          onOpenFull(rect);
        }}
        data-edit-preview
        className="w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer font-[inherit] bg-transparent border-0 text-left hover:bg-[var(--s2)]/50 transition-colors"
      >
        <FileBadge path={entry.path} />
        <span className="flex-1 min-w-0 text-[12.5px] text-t1 font-semibold truncate tracking-[-0.05px]">
          {name}
        </span>
        {entry.pending && <PendingPill />}
        {!entry.pending && entry.errored && (
          <span className="text-[9px] font-bold uppercase tracking-[0.5px] text-[var(--del-line)]">
            failed
          </span>
        )}
        <span className="flex items-center gap-1.5 text-[11.5px] font-mono font-semibold tabular-nums flex-shrink-0">
          {stats.added > 0 && (
            <span className="text-[var(--add-line)]">+{stats.added}</span>
          )}
          {stats.removed > 0 && (
            <span className="text-[var(--del-line)]">−{stats.removed}</span>
          )}
        </span>
      </button>
      {visibleRows.length > 0 && (
        <div className="font-mono text-[11.5px] leading-[1.7] overflow-x-auto bg-[var(--s0)]/40 border-t border-b1">
          {visibleRows.map((r, i) => (
            <DiffRow key={i} row={r} />
          ))}
          {!expanded && hiddenLines > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className="w-full text-center py-1 text-[10.5px] text-t4 hover:text-t2 hover:bg-[var(--s2)]/40 bg-transparent border-0 border-t border-b1 cursor-pointer font-[inherit] transition-colors"
            >
              + {hiddenLines} more line{hiddenLines === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ─────────────────── Sub-components ───────────────────

function PendingPill() {
  return (
    <motion.span
      className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.5px] text-t3"
      animate={{ opacity: [0.55, 1, 0.55] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <span
        className="w-1 h-1 rounded-full bg-[var(--t3)]"
        style={{ boxShadow: "0 0 4px var(--t3)" }}
      />
      writing
    </motion.span>
  );
}

function DiffRow({ row }: { row: RawRow }) {
  const isAdd = row.kind === "add";
  const isDel = row.kind === "del";
  // Background-only signaling — no marker column. Context lines render at
  // a lower contrast so the eye snaps to the changed lines first.
  const bg = isAdd
    ? "bg-[var(--add-bg)]"
    : isDel
      ? "bg-[var(--del-bg)]"
      : "";
  const text = isAdd || isDel ? "text-t1" : "text-t3";
  return (
    <div className={`${bg}`}>
      <span
        className={`block px-3 py-[1px] whitespace-pre break-all ${text} overflow-hidden text-ellipsis`}
      >
        {row.text || " "}
      </span>
    </div>
  );
}

// ─────────────────── Diff math ───────────────────

type RawRow = { kind: "add" | "del" | "ctx"; text: string };

function buildRows(entry: FileEditEntry): RawRow[] {
  const rows: RawRow[] = [];
  for (const c of entry.changes) {
    if (c.kind === "write") {
      for (const line of c.newText.split("\n")) {
        rows.push({ kind: "add", text: line });
      }
    } else {
      rows.push(...diffLines(c.oldText, c.newText));
    }
  }
  return rows;
}

function diffLines(a: string, b: string): RawRow[] {
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
  const rows: RawRow[] = [];
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

function countStats(rows: RawRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

/** Trim the row list to the most-informative slice around the first change.
 *  Keeps one line of leading context so the diff doesn't feel groundless. */
function trimPreview(rows: RawRow[], limit: number): RawRow[] {
  if (rows.length <= limit) return rows;
  let firstChange = rows.findIndex((r) => r.kind !== "ctx");
  if (firstChange === -1) firstChange = 0;
  const start = Math.max(0, firstChange - 1);
  return rows.slice(start, start + limit);
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
