// ─────────────────────────────────────────────────────────────
// EditedFilesCard — Cursor-style compact summary panel shown at
// the end of a turn that performed file writes/edits. Mimics the
// bottom "1 File … Undo Review" footer in Cursor:
//
//   ┌─────────────────────────────────────────────────┐
//   │ ▾ 1 File                          Undo  Review  │
//   ├─────────────────────────────────────────────────┤
//   │ JS budgetAdvisor.js                    +23 -1   │
//   └─────────────────────────────────────────────────┘
//
//   • Click the chevron to collapse/expand the file list.
//   • Click a row to open the full diff modal.
//   • "Undo" reverts every file in the bunch to its pre-turn
//     snapshot via the per-file revert RPC (two-click confirm).
//   • "Review" opens each file's diff modal sequentially (or just
//     the first one).
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { send, onMessage } from "../../lib/rpc";
import { Icon } from "../../design/icons";
import { FileDiffModal, FileEditEntry, DiffLineNote } from "./FileDiffModal";
import { FileBadge } from "./FileBadge";

interface EditedFilesCardProps {
  edits: FileEditEntry[];
  onAddDiffNote?: (note: DiffLineNote) => void;
}

type RevertState = "idle" | "confirming" | "reverting" | "done" | "failed";

export function EditedFilesCard({ edits, onAddDiffNote }: EditedFilesCardProps) {
  const [openState, setOpenState] = useState<{ entry: FileEditEntry; rect: DOMRect | null } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [undoConfirm, setUndoConfirm] = useState(false);
  const openEntry = openState?.entry ?? null;
  const [revertState, setRevertState] = useState<Map<string, RevertState>>(new Map());
  const [revertError, setRevertError] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    return onMessage((m) => {
      if (m.type !== "revertResult") return;
      setRevertState((prev) => {
        const next = new Map(prev);
        next.set(m.path, m.ok ? "done" : "failed");
        return next;
      });
      setRevertError((prev) => {
        const next = new Map(prev);
        if (!m.ok && m.error) next.set(m.path, m.error);
        else next.delete(m.path);
        return next;
      });
      if (!m.ok) {
        setTimeout(() => {
          setRevertState((prev) => {
            const next = new Map(prev);
            if (next.get(m.path) === "failed") next.delete(m.path);
            return next;
          });
          setRevertError((prev) => {
            const next = new Map(prev);
            next.delete(m.path);
            return next;
          });
        }, 5000);
      }
    });
  }, []);

  const stats = useMemo(() => computeStats(edits), [edits]);
  // True when every file in the bunch has been successfully reverted.
  // Drives the "all reverted" header treatment + hides the Undo button so
  // the user can't double-undo (which would just hit "no prior snapshot").
  const allReverted = useMemo(
    () => edits.length > 0 && edits.every((e) => revertState.get(e.path) === "done"),
    [edits, revertState]
  );
  const anyReverting = useMemo(
    () => edits.some((e) => revertState.get(e.path) === "reverting"),
    [edits, revertState]
  );

  const handleUndoAll = () => {
    if (!undoConfirm) {
      setUndoConfirm(true);
      setTimeout(() => setUndoConfirm(false), 2500);
      return;
    }
    setUndoConfirm(false);
    // Fire revertFile per file. Each one independently resolves with a
    // revertResult event; the per-file state will animate accordingly.
    for (const e of edits) {
      if (revertState.get(e.path) === "done") continue;
      setRevertState((prev) => {
        const next = new Map(prev);
        next.set(e.path, "reverting");
        return next;
      });
      send({ type: "revertFile", path: e.path });
    }
  };

  const handleReview = () => {
    // Open the first non-reverted file's diff modal as the review starting point.
    const first = edits.find((e) => revertState.get(e.path) !== "done");
    if (first) setOpenState({ entry: first, rect: null });
  };

  if (edits.length === 0) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="mt-2 rounded-md border border-b1 bg-[var(--s1)] overflow-hidden"
        style={{ boxShadow: "0 1px 0 var(--b1) inset" }}
      >
        {/* Header bar: chevron + file count, then Undo / Review */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-b1 bg-[var(--s2)]/40">
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="inline-flex items-center gap-1.5 bg-transparent border-0 cursor-pointer font-[inherit] text-t1 hover:text-t1 p-0"
          >
            <motion.span
              animate={{ rotate: expanded ? 0 : -90 }}
              transition={{ duration: 0.18 }}
              className="inline-flex text-t3"
            >
              <Icon name="chevronD" size={10} />
            </motion.span>
            <span className="text-[12px] font-semibold tracking-[-0.05px]">
              {edits.length} File{edits.length === 1 ? "" : "s"}
            </span>
            <span className="flex items-center gap-1.5 ml-1 text-[10.5px] font-mono font-semibold tabular-nums">
              {stats.added > 0 && (
                <span className="text-[var(--add-line)]">+{stats.added}</span>
              )}
              {stats.removed > 0 && (
                <span className="text-[var(--del-line)]">−{stats.removed}</span>
              )}
            </span>
          </button>
          <div className="flex items-center gap-1">
            {allReverted ? (
              // Terminal "all reverted" state — Undo is no longer applicable
              // (the file is already at its pre-turn snapshot). Show a single
              // status pill so the panel reads as resolved.
              <span
                className="inline-flex items-center gap-1 px-2 py-[3px] rounded text-[10.5px] font-bold uppercase tracking-[0.5px] border"
                style={{
                  background: "var(--ok-soft)",
                  borderColor: "rgba(74,222,128,0.4)",
                  color: "var(--ok)"
                }}
                title="Every file has been restored to its pre-turn state."
              >
                <Icon name="check" size={9} />
                Reverted
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleUndoAll}
                  disabled={anyReverting}
                  className={[
                    "inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer transition-colors font-[inherit] border",
                    undoConfirm
                      ? "bg-warn-soft border-[rgba(251,191,36,0.5)] text-warn"
                      : "bg-transparent border-transparent text-t2 hover:text-t1 hover:bg-[var(--s3)]/80",
                    anyReverting ? "opacity-60 cursor-wait" : ""
                  ].join(" ")}
                  title={
                    undoConfirm
                      ? "Click again to confirm — replaces every file with its pre-turn snapshot"
                      : "Revert every file in this turn to its pre-turn state"
                  }
                >
                  {anyReverting ? "Undoing…" : undoConfirm ? "Click again" : "Undo"}
                </button>
                <button
                  type="button"
                  onClick={handleReview}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer transition-colors font-[inherit] border bg-[var(--s3)] border-b2 text-t1 hover:bg-[var(--s3)]/70"
                  title="Review changes in a full diff view"
                >
                  Review
                </button>
              </>
            )}
          </div>
        </div>

        {/* File list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.ul
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="flex flex-col list-none p-0 m-0 overflow-hidden"
            >
              {edits.map((e, i) => (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.025 * i, duration: 0.18 }}
                  className="border-t border-b1 first:border-t-0"
                >
                  <FileRow
                    entry={e}
                    revertState={revertState.get(e.path) ?? "idle"}
                    revertError={revertError.get(e.path)}
                    onOpenDiff={(rect) => setOpenState({ entry: e, rect })}
                    onOpenInEditor={() => send({ type: "openFile", path: e.path })}
                  />
                </motion.li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {openEntry && (
          <FileDiffModal
            entry={openEntry}
            originRect={openState?.rect ?? null}
            onClose={() => setOpenState(null)}
            onAddNote={onAddDiffNote}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ─────────────────── Row ───────────────────

function FileRow({
  entry,
  revertState,
  revertError,
  onOpenDiff,
  onOpenInEditor
}: {
  entry: FileEditEntry;
  revertState: RevertState;
  revertError?: string;
  onOpenDiff: (rect: DOMRect | null) => void;
  onOpenInEditor: () => void;
}) {
  const name = baseName(entry.path);
  const counts = useMemo(() => countDelta(entry), [entry]);
  const isReverted = revertState === "done";
  const isReverting = revertState === "reverting";
  const isFailed = revertState === "failed";

  return (
    <div
      onClick={onOpenInEditor}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenInEditor();
        }
      }}
      className={[
        "group flex items-center gap-2 px-2.5 py-1.5 cursor-pointer transition-[background,opacity] duration-[140ms] hover:bg-[var(--s2)]/60 focus:outline-none focus-visible:bg-[var(--s2)]",
        isReverted ? "opacity-55 hover:opacity-80" : ""
      ].join(" ")}
      title={`Open ${entry.path}`}
    >
      <FileBadge path={entry.path} size={16} />
      <span
        className={[
          "flex-1 min-w-0 text-[12.5px] font-semibold truncate tracking-[-0.05px]",
          isReverted ? "text-t3 line-through decoration-t4/60" : "text-t1"
        ].join(" ")}
      >
        {name}
      </span>
      {isReverting ? (
        <span className="text-[9px] font-bold uppercase tracking-[0.5px] text-t3 flex items-center gap-1">
          <span className="spinner" />
          reverting
        </span>
      ) : isReverted ? (
        <span
          className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-[0.5px] flex-shrink-0 px-1 py-[1px] rounded-[3px] text-[var(--ok)]"
          style={{ background: "var(--ok-soft)" }}
        >
          <Icon name="check" size={8} />
          Reverted
        </span>
      ) : isFailed ? (
        <span
          className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-[0.5px] flex-shrink-0 px-1 py-[1px] rounded-[3px] text-err"
          style={{ background: "var(--err-soft)" }}
          title={revertError ?? "Revert failed"}
        >
          <Icon name="x" size={8} />
          Failed
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[11px] font-mono font-semibold tabular-nums flex-shrink-0">
          {counts.added > 0 && (
            <span className="text-[var(--add-line)]">+{counts.added}</span>
          )}
          {counts.removed > 0 && (
            <span className="text-[var(--del-line)]">−{counts.removed}</span>
          )}
        </span>
      )}
    </div>
  );
}

// ─────────────────── Helpers ───────────────────

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function computeStats(edits: FileEditEntry[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const c = countDelta(e);
    added += c.added;
    removed += c.removed;
  }
  return { added, removed };
}

function countDelta(entry: FileEditEntry): { added: number; removed: number } {
  if (entry.changes.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const c of entry.changes) {
    if (c.kind === "write") {
      added += c.newText.split("\n").length;
    } else if (c.kind === "edit") {
      const a = c.oldText.split("\n");
      const b = c.newText.split("\n");
      const { adds, dels } = lcsCounts(a, b);
      added += adds;
      removed += dels;
    }
  }
  return { added, removed };
}

function lcsCounts(a: string[], b: string[]): { adds: number; dels: number } {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let adds = 0;
  let dels = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels++;
      i++;
    } else {
      adds++;
      j++;
    }
  }
  dels += m - i;
  adds += n - j;
  return { adds, dels };
}
