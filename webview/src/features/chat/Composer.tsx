// ─────────────────────────────────────────────────────────────
// Composer — chat input. Uses a contenteditable RichEditor for
// inline rich content (no markdown markers visible to the user;
// code from Cmd+L lands as a styled, editable block). The mode
// picker, skills picker, and model picker live in the toolbar
// below.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../design/icons";
import {
  Dropdown,
  RichEditor,
  type CodeInsert,
  type RichEditorHandle
} from "../../design/primitives";
import {
  send,
  AuthMode,
  PermissionMode,
  ModelInfo,
  SkillInfo,
  FileSearchResult
} from "../../lib/rpc";
import { MODES, findMode } from "./constants";
import { MentionPopover } from "./MentionPopover";
import { SkillsPicker } from "./SkillsPicker";
import { ModelPicker } from "./ModelPicker";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  authMode: AuthMode | null;
  model: string;
  permissionMode: PermissionMode;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  /** External signal (from Cmd+L etc.) to focus the editor. */
  focusKey: number;
  /** When set, splice this code block at the caret then call onInserted. */
  pendingInsert: CodeInsert | null;
  onInserted: () => void;
  /** Compact in-message edit mode: hides the toolbar, swaps in a Cancel/Send footer. */
  inline?: boolean;
  /** Inline mode only — called when the user discards the edit. */
  onDiscard?: () => void;
}

interface MentionState {
  active: boolean;
  query: string;
}

const NO_MENTION: MentionState = { active: false, query: "" };

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  model,
  permissionMode,
  models,
  skills,
  focusKey,
  pendingInsert,
  onInserted,
  inline = false,
  onDiscard
}: ComposerProps) {
  const editorRef = useRef<RichEditorHandle | null>(null);
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionState>(NO_MENTION);
  // The editor is mounted once with its persisted text; React shouldn't keep
  // re-pushing `value` into it (it owns its DOM after mount). We freeze the
  // initial value to avoid remount churn.
  const initialTextRef = useRef(value);

  useEffect(() => {
    if (focusKey > 0) editorRef.current?.focus();
  }, [focusKey]);

  // Inline edit mode: focus on mount and let Escape discard.
  useEffect(() => {
    if (!inline) return;
    editorRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDiscard?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, onDiscard]);

  // Detect a mention query by inspecting the current selection. The popover
  // tracks the trailing `@<query>` chunk just before the caret in plain text.
  const refreshMention = useCallback(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      setMention(NO_MENTION);
      return;
    }
    const text = node.textContent ?? "";
    const offset = sel?.anchorOffset ?? 0;
    let i = offset - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    const tokenStart = i + 1;
    if (text[tokenStart] !== "@") {
      setMention(NO_MENTION);
      return;
    }
    const before = tokenStart === 0 ? " " : text[tokenStart - 1];
    if (!/\s/.test(before) && tokenStart !== 0) {
      setMention(NO_MENTION);
      return;
    }
    const query = text.slice(tokenStart + 1, offset);
    if (query.includes(" ")) {
      setMention(NO_MENTION);
      return;
    }
    setMention({ active: true, query });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshMention);
    return () => document.removeEventListener("selectionchange", refreshMention);
  }, [refreshMention]);

  const handleEditorChange = (text: string) => {
    onChange(text);
    refreshMention();
  };

  const handleSubmit = () => {
    if (busy) return;
    const text = (editorRef.current?.serialize() ?? "").trim();
    if (!text) return;
    onSubmit(text);
    editorRef.current?.clear();
    setMention(NO_MENTION);
  };

  const handleMentionPick = useCallback((result: FileSearchResult) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent ?? "";
    const offset = range.startOffset;
    let i = offset - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    const tokenStart = i + 1;
    if (text[tokenStart] !== "@") return;

    const basename = result.name || result.path.split("/").pop() || result.path;
    const replacement = `@${basename} `;
    const before = text.slice(0, tokenStart);
    const after = text.slice(offset);
    const newText = before + replacement + after;
    node.textContent = newText;

    // Place caret right after the inserted reference.
    const caretPos = (before + replacement).length;
    const r = document.createRange();
    r.setStart(node, caretPos);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    setMention(NO_MENTION);
    // Notify parent so persisted value updates.
    onChange(editorRef.current?.serialize() ?? "");
  }, [onChange]);

  const insertTokenAtCursor = (token: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      editorRef.current?.focus();
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(token));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    onChange(editorRef.current?.serialize() ?? "");
  };

  const canSend = !busy && value.trim().length > 0;
  const mode = findMode(permissionMode);

  return (
    <div
      className={`cmp${focused ? " focused" : ""}${busy ? " busy" : ""}${inline ? " cmp-inline" : ""}`}
    >
      <MentionPopover
        open={mention.active}
        query={mention.query}
        onPick={handleMentionPick}
        onClose={() => setMention(NO_MENTION)}
      />

      <div
        className="cmp-editor-wrap"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <RichEditor
          ref={editorRef}
          initialText={initialTextRef.current}
          pendingInsert={pendingInsert}
          onInserted={onInserted}
          onChange={handleEditorChange}
          onSubmit={handleSubmit}
          busy={busy}
        />
      </div>

      {inline ? (
        <div className="cmp-toolbar cmp-toolbar-inline">
          <div className="cmp-spacer" />
          <button
            type="button"
            className="modal-btn modal-btn-secondary cmp-inline-cancel"
            onClick={() => onDiscard?.()}
            title="Cancel edit (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            className="cmp-send"
            onClick={handleSubmit}
            disabled={!canSend}
            title="Send (↵)"
            aria-label="Send"
          >
            <Icon name="send" size={13} />
          </button>
        </div>
      ) : (
      <div className="cmp-toolbar">
        <Dropdown<PermissionMode>
          options={MODES.map((m) => ({
            value: m.value,
            label: m.label,
            note: m.note,
            icon: m.icon
          }))}
          value={permissionMode}
          onSelect={(v) => send({ type: "setPermissionMode", mode: v })}
          align="left"
          placement="above"
          ariaLabel="Permission mode"
          triggerClassName="cmp-mode"
          trigger={() => (
            <>
              <Icon name={mode.icon} size={12} />
              <span>{mode.short}</span>
              <Icon name="chevronD" size={9} />
            </>
          )}
        />

        <SkillsPicker skills={skills} />

        <div className="cmp-divider" />

        <button
          type="button"
          className="cmp-tool"
          title="Mention a file (@)"
          aria-label="Mention a file"
          onClick={() => insertTokenAtCursor("@")}
        >
          <Icon name="at" size={13} />
        </button>
        <button
          type="button"
          className="cmp-action"
          title="Insert editor selection (⌘L)"
          aria-label="Insert editor selection"
          onClick={() => send({ type: "captureSelection" })}
        >
          <Icon name="code" size={12} />
          <span className="cmp-action-label">Selection</span>
          <kbd className="kbd cmp-action-kbd">⌘L</kbd>
        </button>

        <div className="cmp-spacer" />

        <ModelPicker
          models={models}
          value={model}
          onSelect={(v) => send({ type: "setModel", model: v })}
        />

        {busy ? (
          <button
            type="button"
            className="cmp-send stop"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel"
          >
            <Icon name="stop" size={11} />
          </button>
        ) : (
          <button
            type="button"
            className="cmp-send"
            onClick={handleSubmit}
            disabled={!canSend}
            title="Send (↵)"
            aria-label="Send"
          >
            <Icon name="send" size={13} />
          </button>
        )}
      </div>
      )}
    </div>
  );
}
