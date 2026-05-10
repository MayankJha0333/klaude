// ─────────────────────────────────────────────────────────────
// Inline expanded plan view. Replaces the previous PlanModal —
// renders directly inside the chat stream where the compact
// PlanCard was, instead of as a fixed overlay covering the
// webview viewport.
//
// Single-column stack (chat sidebars get narrow):
//   ┌─ header (title · time · path · actions · close) ─┐
//   │  progress bar                                     │
//   │  rendered markdown body (selection-+ comments)    │
//   │  comments list                                    │
//   │  tasks                                            │
//   │  questions                                        │
//   │  footer actions                                   │
//   └───────────────────────────────────────────────────┘
//
// Highlight-click and selection-+ flows still mount their own
// floating popovers anchored to the click/selection position;
// those remain `position: fixed` because they need to track
// scroll independently of the chat stream.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../design/icons";
import { Chip, IconButton } from "../../design/primitives";
import { renderMarkdown } from "../chat/markdown";
import { send } from "../../lib/rpc";
import { PlanRevisionDiff } from "./PlanRevisionDiff";
import { PlanStepCard } from "./PlanStepCard";
import { QuestionCard } from "./QuestionCard";
import { SelectionCommentLayer } from "./SelectionCommentLayer";
import { PlanReviewDropdown } from "./PlanReviewDropdown";
import { SidebarCommentsList } from "./SidebarCommentsList";
import { InlineCommentThreads } from "./InlineCommentThreads";
import { unresolvedComments } from "./foldPlanState";
import { extractPlanSummary, formatRelativeTime } from "./summary";
import { useQuoteHighlights, QuoteEntry } from "./useQuoteHighlights";
import { compactPath } from "./utils";
import type { PlanCommentMeta, PlanRevisionView } from "./types";

interface Props {
  view: PlanRevisionView;
  previous?: PlanRevisionView;
  isLatest: boolean;
  ordinal: number;
  onCollapse: () => void;
}

export function PlanFullView({ view, previous, isLatest, ordinal, onCollapse }: Props) {
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewAnchor, setReviewAnchor] = useState<{ right: number; top: number } | null>(null);
  const [, forceTick] = useState(0);
  const docRef = useRef<HTMLDivElement>(null);
  const reviewBtnRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const summary = useMemo(() => extractPlanSummary(view.meta.body), [view.meta.body]);
  const proceeded = !!view.meta.proceeded;
  // Treat a proceeded plan as locked for all editing surfaces — comments,
  // step controls, the Review dropdown, etc. The user can unlock it by
  // rewinding to this revision's checkpoint.
  const locked = !isLatest || proceeded;
  const pending = unresolvedComments(view).length;
  const tasks = view.meta.tasks;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const progressPct = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

  const liveComments = useMemo(
    () => view.comments.filter((c) => !c.deleted),
    [view.comments]
  );

  const quotedComments = useMemo<Array<PlanCommentMeta & { ts: number }>>(
    () => liveComments.filter((c) => !!c.quote),
    [liveComments]
  );

  const quoteEntries = useMemo<QuoteEntry[]>(
    () =>
      quotedComments.map((c, i) => ({
        commentId: c.commentId,
        quote: c.quote!,
        resolved: !!c.resolvedInRevisionId || !!c.resolvedAt,
        pinNumber: i + 1,
        preview: c.body
      })),
    [quotedComments]
  );

  // Refresh relative timestamps every 30 s.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Smoothly bring the expanded card into view when it first opens.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // No onClick callback needed — InlineCommentThreads owns the
  // click-to-pin interaction itself by listening on the doc container.
  useQuoteHighlights(docRef, view.meta.body, showDiff ? [] : quoteEntries);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.meta.body);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = view.meta.body;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const download = () => {
    const blob = new Blob([view.meta.body], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const fileName = view.meta.planFilePath
      ? view.meta.planFilePath.split("/").pop() || "plan.md"
      : `plan-revision-${ordinal}.md`;
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openReview = () => {
    const btn = reviewBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setReviewAnchor({
      right: Math.max(8, window.innerWidth - r.right),
      top: r.bottom + 6
    });
    setReviewOpen(true);
  };

  const proceed = () => {
    send({ type: "planProceedRequest", revisionId: view.meta.revisionId });
    onCollapse();
  };

  /**
   * Scroll the commented line matching `commentId` into view + flash it +
   * pin its inline thread open. Called when the user clicks a row in the
   * sidebar comments list (whole-plan comments still use the sidebar).
   */
  const jumpToHighlight = (commentId: string) => {
    const container = docRef.current;
    if (!container) return;
    const block = container.querySelector<HTMLElement>(
      `[data-plan-comment-id="${CSS.escape(commentId)}"]`
    );
    if (!block) return;
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    block.classList.remove("plan-line-flash");
    void block.offsetWidth;
    block.classList.add("plan-line-flash");
    setTimeout(() => block.classList.remove("plan-line-flash"), 1400);
    // Pin the matching slot open so the user can read/edit immediately
    // without having to hover.
    setTimeout(() => {
      container
        .querySelectorAll(".plan-inline-thread-slot.is-pinned")
        .forEach((el) => el.classList.remove("is-pinned"));
      const slot = container.querySelector(
        `.plan-inline-thread-slot[data-comment-id="${CSS.escape(commentId)}"]`
      );
      slot?.classList.add("is-pinned");
      block.classList.add("is-pinned");
    }, 320);
  };

  return (
    <div ref={rootRef} className="plan-inline">
      <header className="plan-inline-head">
        <div className="plan-inline-head-left">
          <span className="plan-inline-icon" aria-hidden>
            <Icon name="book" size={13} />
          </span>
          <div className="plan-inline-titles">
            <div className="plan-inline-title">{summary.title}</div>
            <div className="plan-inline-subtitle">
              <span>{formatRelativeTime(view.ts)}</span>
              {view.meta.planFilePath && (
                <>
                  <span className="plan-modal-dot">·</span>
                  <span className="plan-modal-path" title={view.meta.planFilePath}>
                    {compactPath(view.meta.planFilePath)}
                  </span>
                </>
              )}
              <span className="plan-modal-dot">·</span>
              <span>rev {ordinal}</span>
              {!isLatest && (
                <>
                  <span className="plan-modal-dot">·</span>
                  <span className="plan-modal-superseded">superseded</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="plan-inline-head-right">
          <IconButton
            icon="copy"
            title={copied ? "Copied!" : "Copy markdown"}
            size={26}
            onClick={copy}
          />
          <IconButton icon="arrow" title="Download .md" size={26} onClick={download} />
          {previous && view.meta.bodyChanged && (
            <IconButton
              icon="branch"
              title={showDiff ? "Show body" : "Show diff vs previous"}
              size={26}
              active={showDiff}
              onClick={() => setShowDiff((d) => !d)}
            />
          )}
          <button
            ref={reviewBtnRef}
            type="button"
            className={`plan-modal-toggle${reviewOpen ? " active" : ""}`}
            onClick={() => (reviewOpen ? setReviewOpen(false) : openReview())}
            disabled={locked}
          >
            Review
            <Icon name={reviewOpen ? "chevronU" : "chevronD"} size={9} />
          </button>
          <IconButton
            icon="chevronU"
            title="Collapse"
            size={26}
            onClick={onCollapse}
          />
        </div>
      </header>

      {proceeded && (
        <div
          className="plan-inline-banner"
          role="status"
          style={{
            padding: "8px 12px",
            margin: "0 0 8px",
            borderRadius: 6,
            background: "var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.08))",
            border: "1px solid var(--vscode-inputValidation-infoBorder, rgba(0, 122, 204, 0.4))",
            color: "var(--vscode-foreground)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6
          }}
        >
          <Icon name="check" size={11} />
          <span>Plan in progress — rewind to this revision to edit.</span>
        </div>
      )}

      {tasks.length > 0 && (
        <div
          className="plan-inline-progress"
          title={`${completed}/${tasks.length} tasks complete`}
        >
          <div
            className="plan-inline-progress-bar"
            style={{ width: `${progressPct}%` }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}

      <div className="plan-inline-doc">
        {showDiff && previous ? (
          <PlanRevisionDiff previous={previous.meta.body} current={view.meta.body} />
        ) : (
          <div className="plan-doc-stack">
            <div ref={docRef} className="md plan-inline-md">
              {renderMarkdown(view.meta.body)}
            </div>
            {/* Hydrate the rendered markdown with comment threads inline
                at each highlight's containing block. Uses React portals
                so the threads sit *between* paragraphs, not in a separate
                section pushed to the bottom of the doc. */}
            <InlineCommentThreads
              docRef={docRef}
              comments={view.rootComments}
              locked={locked}
              redrawKey={view.meta.body + ":" + view.comments.length}
            />
            <SelectionCommentLayer
              containerRef={docRef}
              revisionId={view.meta.revisionId}
              locked={locked}
            />
          </div>
        )}
      </div>

      <div className="plan-inline-sections">
        <SidebarCommentsList
          comments={view.rootComments}
          locked={locked}
          onJumpToHighlight={jumpToHighlight}
        />

        {tasks.length > 0 && (
          <section className="plan-modal-section">
            <div className="plan-modal-section-head">
              <Icon name="check" size={11} />
              <span>Plan steps</span>
              <Chip tone="default">
                {completed}/{tasks.length}
              </Chip>
            </div>
            <PlanStepList
              tasks={tasks}
              revisionId={view.meta.revisionId}
              comments={view.comments}
              locked={locked}
            />
          </section>
        )}

        {view.questions.length > 0 && (
          <section className="plan-modal-section">
            <div className="plan-modal-section-head">
              <Icon name="bolt" size={11} />
              <span>Questions</span>
            </div>
            {view.questions.map((q) => {
              const ans = view.answers.find((a) => a.questionId === q.questionId);
              return (
                <QuestionCard key={q.eventId} question={q} answer={ans} locked={locked} />
              );
            })}
          </section>
        )}

        <section className="plan-inline-footer">
          {isLatest && !proceeded && pending > 0 && (
            <button
              type="button"
              className="plan-btn plan-btn-primary plan-btn-block"
              onClick={() => {
                send({ type: "planResubmit", revisionId: view.meta.revisionId });
                onCollapse();
              }}
            >
              Update plan with feedback ({pending})
            </button>
          )}
          {isLatest && !proceeded && pending === 0 && (
            <button
              type="button"
              className="plan-btn plan-btn-success plan-btn-block"
              onClick={proceed}
            >
              <Icon name="check" size={11} />
              Proceed
            </button>
          )}
          <button
            type="button"
            className="plan-btn plan-btn-block"
            onClick={() => {
              send({ type: "planRewindTo", revisionId: view.eventId });
              onCollapse();
            }}
          >
            <Icon name="history" size={11} />
            Rewind to this revision
          </button>
        </section>
      </div>

      {reviewOpen && reviewAnchor && (
        <PlanReviewDropdown
          revisionId={view.meta.revisionId}
          locked={locked}
          anchor={reviewAnchor}
          onClose={() => setReviewOpen(false)}
        />
      )}

    </div>
  );
}

/**
 * Renders the plan tasks in three groups: completed/accepted/skipped above,
 * one active step in the middle (with full Accept/Modify/Skip controls),
 * and upcoming steps faded below. This is the Antigravity-style gating —
 * the user reviews and approves one step at a time instead of seeing the
 * whole plan as a flat to-do list.
 */
function PlanStepList({
  tasks,
  revisionId,
  comments,
  locked
}: {
  tasks: import("./types").PlanTask[];
  revisionId: string;
  comments: import("./types").PlanCommentMeta[];
  locked: boolean;
}) {
  // Active step = first in_progress, else first pending. Skipped/accepted/
  // completed never claim the active slot.
  const activeIdx = (() => {
    const inProg = tasks.findIndex((t) => t.status === "in_progress");
    if (inProg !== -1) return inProg;
    return tasks.findIndex((t) => t.status === "pending");
  })();

  return (
    <ol className="plan-step-list">
      {tasks.map((task, i) => {
        const mode: "active" | "completed" | "upcoming" =
          i === activeIdx ? "active" : i < activeIdx || activeIdx === -1 ? "completed" : "upcoming";
        // When activeIdx === -1 (everything is done/skipped), treat all as
        // completed so they all collapse into the read-only summary form.
        return (
          <li key={task.id} className={`plan-step-item plan-step-item-${mode}`}>
            <PlanStepCard
              task={task}
              index={i}
              total={tasks.length}
              revisionId={revisionId}
              mode={mode}
              comments={comments}
              locked={locked}
            />
          </li>
        );
      })}
    </ol>
  );
}
