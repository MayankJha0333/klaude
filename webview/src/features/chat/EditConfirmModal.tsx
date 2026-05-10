// ─────────────────────────────────────────────────────────────
// Confirmation modal for edit-and-resubmit. Editing a past
// message ALWAYS discards everything that came after it (a
// fresh conversation branch starts from this point); the only
// question is whether the workspace files should also revert
// to the snapshot taken when this message was originally sent.
//
// Three outcomes:
//   • Cancel       (Esc)     — close the modal, keep editing
//   • Don't revert (⇧↵)      — discard messages, leave files
//   • Revert       (↵)       — discard messages AND restore files
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";

interface EditConfirmModalProps {
  messagesAfter: number;
  onCancel: () => void;
  onDontRevert: () => void;
  onRevert: () => void;
}

export function EditConfirmModal({
  messagesAfter,
  onCancel,
  onDontRevert,
  onRevert
}: EditConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onDontRevert();
        else onRevert();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onDontRevert, onRevert]);

  const clearedClause =
    messagesAfter > 0
      ? ` and clear the ${messagesAfter} message${messagesAfter !== 1 ? "s" : ""} after this one`
      : "";
  const body = `Submitting from a previous message will revert file changes to before this message${clearedClause}.`;

  return (
    <div
      className="modal-backdrop edit-modal-backdrop"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="modal edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Submit from a previous message?</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-actions edit-modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn-link"
            onClick={onCancel}
          >
            Cancel <span className="modal-kbd">(esc)</span>
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-secondary"
            onClick={onDontRevert}
          >
            Don't revert <span className="modal-kbd">⇧↵</span>
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-primary"
            onClick={onRevert}
            autoFocus
          >
            Revert <span className="modal-kbd">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
