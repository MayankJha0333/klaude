// ─────────────────────────────────────────────────────────────
// Compact Plan Card — the chat-stream representation of a plan
// revision. Shows only the title and a short prose preview plus
// "Proceed" and "Open" actions. Clicking "Open" mounts a
// PlanFullView with the full markdown, task tree, comments, and
// question cards. Clicking "Proceed" sends an approval prompt
// so the agent moves out of plan mode and starts executing.
//
// All persistent state (comments, answers, revisions, rewind
// anchors) lives in the timeline events; this component is a
// pure projection of the matching PlanRevisionView.
// ─────────────────────────────────────────────────────────────

import { useMemo } from "react";
import { Icon } from "../../design/icons";
import { Chip } from "../../design/primitives";
import { send } from "../../lib/rpc";
import { unresolvedComments } from "./foldPlanState";
import { extractPlanSummary } from "./summary";
import type { PlanRevisionView } from "./types";

interface Props {
  view: PlanRevisionView;
  /** The previous revision in chronological order, used for diffing. */
  previous?: PlanRevisionView;
  /** This is the latest revision — input controls are live. */
  isLatest: boolean;
  /** Index in the revision list, 1-based. */
  ordinal: number;
}

export function PlanCard({ view, isLatest, ordinal }: Props) {
  const summary = useMemo(() => extractPlanSummary(view.meta.body), [view.meta.body]);
  const pending = unresolvedComments(view).length;
  const branched = !!view.meta.parentRevisionId;
  const proceeded = !!view.meta.proceeded;
  const taskCount = view.meta.tasks.length;
  const completed = view.meta.tasks.filter((t) => t.status === "completed").length;

  const proceed = () => {
    // Don't send a chat prompt directly — that would inject a "Plan approved"
    // user bubble while leaving the agent stuck in plan mode (which can't
    // write). The extension shows a permission popup, switches mode, and
    // continues the same conversation in one motion.
    send({ type: "planProceedRequest", revisionId: view.meta.revisionId });
  };

  const openInEditor = () => {
    // Open as a real editor tab — the artifact view lives in the main
    // editor area, not inline in the chat. Matches the Antigravity feel
    // where the plan is a first-class document the user navigates.
    send({ type: "planOpenInEditor", revisionId: view.meta.revisionId });
  };

  const tasksProgress = taskCount > 0 ? completed / taskCount : null;
  const revisionLabel =
    ordinal > 1 ? `Updated · v${ordinal}` : branched ? "Updated" : null;

  return (
    <div
      className={`plan-mini${!isLatest ? " locked" : ""}${branched ? " branched" : ""}`}
    >
      <div className="plan-mini-head">
        <span className="plan-mini-icon" aria-hidden>
          <Icon name="layers" size={14} />
        </span>
        <div className="plan-mini-titleblock">
          <span className="plan-mini-title">{summary.title}</span>
          {revisionLabel && (
            <span
              className="plan-mini-revtag"
              title={
                branched
                  ? "This plan was revised after a rewind."
                  : "This plan has been updated."
              }
            >
              <Icon name="refresh" size={9} />
              {revisionLabel}
            </span>
          )}
        </div>
        <span className="plan-mini-chips">
          {proceeded && (
            <Chip
              tone="info"
              title="Plan locked. Rewind to this revision's checkpoint to edit."
            >
              proceeded
            </Chip>
          )}
          {!isLatest && <Chip tone="default">superseded</Chip>}
        </span>
      </div>

      {summary.preview && (
        <p className="plan-mini-preview">{summary.preview}</p>
      )}

      {tasksProgress !== null && (
        <div className="plan-mini-progress">
          <div className="plan-mini-progress-label">
            <span>
              Tasks {completed}/{taskCount}
            </span>
          </div>
          <div className="plan-mini-progress-bar">
            <div
              className="plan-mini-progress-fill"
              style={{ width: `${Math.round(tasksProgress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {(pending > 0 || view.questions.length > view.answers.length) && (
        <div className="plan-mini-meta">
          {pending > 0 && (
            <span className="plan-mini-stat plan-mini-stat-warn">
              <Icon name="at" size={10} />
              {pending} unresolved comment{pending !== 1 ? "s" : ""}
            </span>
          )}
          {view.questions.length > view.answers.length && (
            <span className="plan-mini-stat plan-mini-stat-accent">
              <Icon name="bolt" size={10} />
              needs answer
            </span>
          )}
        </div>
      )}

      <div className="plan-mini-actions">
        <button
          type="button"
          className="plan-btn plan-btn-success"
          onClick={proceed}
          disabled={!isLatest || proceeded}
          title={
            proceeded
              ? "Plan locked. Rewind to this revision's checkpoint to edit."
              : undefined
          }
        >
          <Icon name="check" size={11} />
          Proceed
        </button>
        <button
          type="button"
          className="plan-btn plan-btn-ghost"
          onClick={openInEditor}
        >
          <Icon name="arrow" size={11} />
          Open in editor
        </button>
      </div>
    </div>
  );
}

