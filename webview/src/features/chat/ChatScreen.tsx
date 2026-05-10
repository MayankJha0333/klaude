// ─────────────────────────────────────────────────────────────
// Chat screen — orchestrates timeline + composer + empty state.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import {
  send,
  TimelineEvent,
  EditorContext,
  AuthMode,
  PermissionMode,
  ModelInfo,
  SkillInfo,
  ConventionsSource
} from "../../lib/rpc";
import type { CodeInsert } from "../../design/primitives";
import { Header } from "./Header";
import { Composer } from "./Composer";
import { ContextStrip } from "./ContextStrip";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { RewindModal } from "./RewindModal";
import { EditConfirmModal } from "./EditConfirmModal";
import { HistoryDrawer } from "./HistoryDrawer";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ConventionsBanner } from "./ConventionsBanner";
import { SkillSuggestion } from "./SkillSuggestion";
import { ToolGroupCard, ToolGroupItem } from "./ToolGroupCard";
import { TurnHeader } from "./TurnHeader";
import { ThoughtBlock } from "./ThoughtBlock";
import { classifyTool, ToolBucket } from "./tool-buckets";
import { renderMarkdown } from "./markdown";
import { PlanCard, foldPlanState, looksLikePlanFile } from "../plan";
import type { PlanRevisionView } from "../plan";

export interface ChatScreenProps {
  authMode: AuthMode | null;
  model: string;
  permissionMode: PermissionMode;
  events: TimelineEvent[];
  streaming: string;
  busy: boolean;
  input: string;
  error: string | null;
  editorContext: EditorContext | null;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  composerFocusKey: number;
  pendingInsert: CodeInsert | null;
  conventions: {
    source: ConventionsSource | null;
    path: string | null;
    relativePath: string | null;
  };
  bannerVisible: boolean;
  onHideBanner: () => void;
  skillSuggestion: {
    skillId: string;
    skillName: string;
    reason: string;
    taskType: string;
  } | null;
  onDismissSkillSuggestion: () => void;
  onInserted: () => void;
  onInput: (v: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onDismissError: () => void;
}

export function ChatScreen({
  authMode,
  model,
  permissionMode,
  events,
  streaming,
  busy,
  input,
  error,
  editorContext,
  models,
  skills,
  composerFocusKey,
  pendingInsert,
  conventions,
  bannerVisible,
  onHideBanner,
  skillSuggestion,
  onDismissSkillSuggestion,
  onInserted,
  onInput,
  onSubmit,
  onCancel,
  onDismissError
}: ChatScreenProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const [, force] = useState(0);
  const [pendingRewind, setPendingRewind] = useState<{
    turnId: string;
    messagesAfter: number;
  } | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{
    turnId: string;
    text: string;
    messagesAfter: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // If the timeline replaces (rewind / new session / load) and the message
  // being edited is gone, exit edit mode so we don't leave a dangling editor.
  useEffect(() => {
    if (editingTurnId && !events.some((e) => e.id === editingTurnId)) {
      setEditingTurnId(null);
    }
  }, [events, editingTurnId]);
  /** Per-turn user override. If absent, collapsed state is derived from the
   *  turn shape: completed turns auto-collapse, the active streaming turn
   *  stays expanded. User clicks set an explicit override that wins. */
  const [manualToggles, setManualToggles] = useState<Map<string, "expanded" | "collapsed">>(
    new Map()
  );
  const toggleTurn = (turnId: string, currentlyCollapsed: boolean): void => {
    setManualToggles((m) => {
      const next = new Map(m);
      next.set(turnId, currentlyCollapsed ? "expanded" : "collapsed");
      return next;
    });
  };
  const isTurnCollapsed = (
    turnId: string,
    hasWork: boolean,
    isLatestTurn: boolean
  ): boolean => {
    const override = manualToggles.get(turnId);
    if (override) return override === "collapsed";
    // Active streaming turn — keep expanded so the user sees live work.
    if (isLatestTurn && busy) return false;
    // Completed turns with any work to hide — collapse by default.
    return hasWork;
  };

  const grouped = useMemo(() => groupEvents(events), [events]);
  const planContext = useMemo(
    () => ({ views: grouped.views, ordered: grouped.ordered }),
    [grouped]
  );

  useEffect(() => {
    if (userScrolled.current) return;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [grouped, streaming]);


  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolled.current = !nearBottom;
    force((n) => n + 1);
  };

  return (
    <>
      <Header
        authMode={authMode}
        permissionMode={permissionMode}
        busy={busy}
        conventions={conventions}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      {bannerVisible && (
        <ConventionsBanner onHideForSession={onHideBanner} />
      )}

      {skillSuggestion && (
        <SkillSuggestion
          skillId={skillSuggestion.skillId}
          skillName={skillSuggestion.skillName}
          reason={skillSuggestion.reason}
          taskType={skillSuggestion.taskType}
          onDismiss={onDismissSkillSuggestion}
        />
      )}

      <div className="log" ref={logRef} onScroll={onScroll}>
        {grouped.groups.length === 0 && !streaming && <EmptyState />}
        {grouped.groups.map((g, i) => {
          const isLatestTurn =
            g.kind === "turn" &&
            !grouped.groups.slice(i + 1).some((x) => x.kind === "turn");
          const isEditing = g.kind === "user" && g.id === editingTurnId;
          if (isEditing && g.kind === "user") {
            const messagesAfter = grouped.groups.length - i - 1;
            return (
              <InlineMessageEditor
                key={g.id}
                initialText={g.text}
                busy={busy}
                model={model}
                permissionMode={permissionMode}
                models={models}
                skills={skills}
                authMode={authMode}
                onCancel={() => setEditingTurnId(null)}
                onSubmit={(text) => {
                  setPendingEdit({ turnId: g.id, text, messagesAfter });
                }}
              />
            );
          }
          return renderGroup(
            g,
            i,
            grouped.groups,
            planContext,
            (turnId, messagesAfter) =>
              setPendingRewind({ turnId, messagesAfter }),
            (turnId) => setEditingTurnId(turnId),
            isTurnCollapsed,
            toggleTurn,
            isLatestTurn
          );
        })}
        {streaming && <AssistantMessage text={streaming} streaming />}
        {error && <ErrorBanner text={error} onDismiss={onDismissError} />}
      </div>

      {pendingRewind && (
        <RewindModal
          messagesAfter={pendingRewind.messagesAfter}
          onCancel={() => setPendingRewind(null)}
          onConfirm={() => {
            send({ type: "rewindTo", turnId: pendingRewind.turnId });
            setPendingRewind(null);
          }}
        />
      )}

      {pendingEdit && (
        <EditConfirmModal
          messagesAfter={pendingEdit.messagesAfter}
          onCancel={() => setPendingEdit(null)}
          onDontRevert={() => {
            send({
              type: "editAt",
              turnId: pendingEdit.turnId,
              text: pendingEdit.text,
              revertFiles: false
            });
            setPendingEdit(null);
            setEditingTurnId(null);
          }}
          onRevert={() => {
            send({
              type: "editAt",
              turnId: pendingEdit.turnId,
              text: pendingEdit.text,
              revertFiles: true
            });
            setPendingEdit(null);
            setEditingTurnId(null);
          }}
        />
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={(id) => {
          send({ type: "loadSession", id });
          setHistoryOpen(false);
        }}
      />

      {userScrolled.current && (
        <button
          type="button"
          className="scroll-fab"
          aria-label="Scroll to bottom"
          onClick={() => {
            userScrolled.current = false;
            const el = logRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            force((n) => n + 1);
          }}
        >
          ↓
        </button>
      )}

      <div className="composer-shell">
        <ContextStrip context={editorContext} />
        <Composer
          value={input}
          onChange={onInput}
          onSubmit={(text) => {
            userScrolled.current = false;
            onSubmit(text);
          }}
          onCancel={onCancel}
          busy={busy}
          authMode={authMode}
          model={model}
          permissionMode={permissionMode}
          models={models}
          skills={skills}
          focusKey={composerFocusKey}
          pendingInsert={pendingInsert}
          onInserted={onInserted}
        />
      </div>
    </>
  );
}

// ── Timeline grouping ────────────────────────────────────────
//
// Events are bucketed into TURNS (one per user message). Inside each turn:
//
//  - "Thought" — assistant text emitted before any tool fires (preamble).
//  - Body blocks — interleaved tool groups, plan cards, and narrative text
//    (assistant text after at least one tool has fired). Consecutive
//    tool calls of the same semantic bucket merge into a single
//    ToolGroupCard, rendered Antigravity-style ("Read 3 files").
//
// Turn timing (workedMs / thoughtMs) uses the timestamps already on every
// TimelineEvent — no orchestrator changes needed.

type Group =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "turn";
      turnId: string;
      startedAt: number;
      endedAt?: number;
      thought: string;
      thoughtMs?: number;
      workedMs?: number;
      /** "Work" — tool groups (and any narrative interleaved between them).
       *  Hidden behind the "Worked for X" collapsible. */
      blocks: TurnBlock[];
      /** "Response" — everything after the last tool call (final answer text
       *  and trailing plan cards). Always rendered OUTSIDE the collapsible
       *  so the actual answer is never hidden. */
      responseBlocks: TurnBlock[];
    };

type TurnBlock =
  | { kind: "narrative"; text: string }
  | { kind: "toolGroup"; bucket: ToolBucket; items: ToolGroupItem[] }
  | { kind: "plan"; revisionId: string };

/**
 * Tool names whose tool_use blocks are rendered via PlanCard rather than
 * ToolCard. Filter applies even on historic sessions saved before plan
 * interception was wired (defensive — orchestrator already suppresses live).
 */
const PLAN_TOOL_NAMES = new Set(["ExitPlanMode", "TodoWrite", "AskUserQuestion"]);
const WRITE_TOOL_NAMES = new Set([
  "Write",
  "Create",
  "Edit",
  "MultiEdit",
  "fs_write",
  "str_replace_editor"
]);
const WRITE_TOOL_NAME_RE_PREFIX = /^(write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;
const WRITE_TOOL_NAME_RE_BOUNDARY = /[_-](write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;

function isPlanFileWriteEvent(name: string, body: string | undefined): boolean {
  if (
    !WRITE_TOOL_NAMES.has(name) &&
    !WRITE_TOOL_NAME_RE_PREFIX.test(name) &&
    !WRITE_TOOL_NAME_RE_BOUNDARY.test(name)
  ) {
    return false;
  }
  try {
    const input = JSON.parse(body ?? "{}") as Record<string, unknown>;
    const path = String(
      input.path ??
        input.file_path ??
        input.filePath ??
        input.target_file ??
        input.target ??
        input.destination ??
        input.uri ??
        ""
    );
    return looksLikePlanFile(path);
  } catch {
    return false;
  }
}

interface GroupingResult {
  groups: Group[];
  views: Map<string, PlanRevisionView>;
  ordered: PlanRevisionView[];
}

function groupEvents(events: TimelineEvent[]): GroupingResult {
  const ordered = foldPlanState(events);
  const views = new Map<string, PlanRevisionView>();
  for (const v of ordered) views.set(v.meta.revisionId, v);

  const groups: Group[] = [];
  const suppressedToolUseIds = new Set<string>();
  const toolItemsById = new Map<string, ToolGroupItem>();

  let currentTurn: Extract<Group, { kind: "turn" }> | null = null;
  let firstToolTsInTurn: number | undefined;
  let lastTsInTurn: number | undefined;

  const finalizeTurn = (): void => {
    if (!currentTurn) return;
    if (lastTsInTurn !== undefined) {
      currentTurn.endedAt = lastTsInTurn;
      currentTurn.workedMs = lastTsInTurn - currentTurn.startedAt;
    }
    if (firstToolTsInTurn !== undefined) {
      currentTurn.thoughtMs = firstToolTsInTurn - currentTurn.startedAt;
    } else if (lastTsInTurn !== undefined) {
      currentTurn.thoughtMs = lastTsInTurn - currentTurn.startedAt;
    }
    // Step 1: Move trailing non-toolGroup blocks (narrative + plan) into
    // responseBlocks. Anything after the last tool call is the assistant's
    // answer and shouldn't sit inside the "Worked for X" collapsible.
    while (currentTurn.blocks.length > 0) {
      const last = currentTurn.blocks[currentTurn.blocks.length - 1];
      if (last.kind === "toolGroup") break;
      currentTurn.responseBlocks.unshift(currentTurn.blocks.pop()!);
    }
    // Step 2: ALSO hoist any plan blocks that ended up in the middle of the
    // work area (e.g. when the model wrote the plan, then did more reads to
    // verify before calling ExitPlanMode). Plans are deliverables — they
    // should never be hidden behind the collapsible. Preserve chronological
    // order with any plans already in responseBlocks.
    const hoistedPlans: TurnBlock[] = [];
    const remainingBlocks: TurnBlock[] = [];
    for (const b of currentTurn.blocks) {
      if (b.kind === "plan") hoistedPlans.push(b);
      else remainingBlocks.push(b);
    }
    currentTurn.blocks = remainingBlocks;
    currentTurn.responseBlocks = [...hoistedPlans, ...currentTurn.responseBlocks];

    currentTurn = null;
    firstToolTsInTurn = undefined;
    lastTsInTurn = undefined;
  };

  const ensureTurn = (ts: number): Extract<Group, { kind: "turn" }> => {
    if (!currentTurn) {
      currentTurn = {
        kind: "turn",
        turnId: `t-${ts}`,
        startedAt: ts,
        thought: "",
        blocks: [],
        responseBlocks: []
      };
      groups.push(currentTurn);
    }
    lastTsInTurn = ts;
    return currentTurn;
  };

  for (const e of events) {
    if (e.kind === "user") {
      finalizeTurn();
      groups.push({ kind: "user", id: e.id, text: e.body ?? "" });
      continue;
    }

    const turn = ensureTurn(e.ts);

    if (e.kind === "assistant") {
      const text = e.body ?? "";
      if (firstToolTsInTurn === undefined) {
        // Pre-tool text becomes the turn's "Thought for Xs" preamble.
        turn.thought += (turn.thought ? "\n\n" : "") + text;
      } else {
        // Post-tool text interleaves between tool groups as narrative.
        const last = turn.blocks[turn.blocks.length - 1];
        if (last && last.kind === "narrative") {
          last.text += "\n\n" + text;
        } else {
          turn.blocks.push({ kind: "narrative", text });
        }
      }
      continue;
    }

    if (e.kind === "tool_call") {
      const name = e.title.replace(/^Tool:\s*/, "");
      if (PLAN_TOOL_NAMES.has(name)) continue;
      const synthId = `synth-${e.id}`;
      if (views.has(synthId)) {
        const tid = (e.meta as { id?: string } | undefined)?.id;
        if (tid) suppressedToolUseIds.add(tid);
        turn.blocks.push({ kind: "plan", revisionId: synthId });
        continue;
      }
      if (isPlanFileWriteEvent(name, e.body)) {
        const tid = (e.meta as { id?: string } | undefined)?.id;
        if (tid) suppressedToolUseIds.add(tid);
        continue;
      }

      if (firstToolTsInTurn === undefined) firstToolTsInTurn = e.ts;

      const bucket = classifyTool(name, e.body);
      const item: ToolGroupItem = {
        id: e.id,
        name,
        input: e.body ?? "{}"
      };
      const tid = (e.meta as { id?: string } | undefined)?.id;
      if (tid) toolItemsById.set(tid, item);

      const last = turn.blocks[turn.blocks.length - 1];
      if (last && last.kind === "toolGroup" && last.bucket === bucket) {
        last.items.push(item);
      } else {
        turn.blocks.push({ kind: "toolGroup", bucket, items: [item] });
      }
      continue;
    }

    if (e.kind === "tool_result") {
      const tid = (e.meta as { id?: string } | undefined)?.id;
      if (tid && suppressedToolUseIds.has(tid)) continue;
      const target = tid ? toolItemsById.get(tid) : undefined;
      if (target) {
        target.result = e.body ?? "";
        target.isError = e.title === "Tool Error";
      }
      continue;
    }

    if (e.kind === "plan_revision") {
      const meta = e.meta as { revisionId?: string } | undefined;
      if (meta?.revisionId) {
        turn.blocks.push({ kind: "plan", revisionId: meta.revisionId });
      }
    }
    // plan_question / plan_comment / plan_answer events do not produce
    // their own blocks — they are folded into the PlanRevisionView.
  }
  finalizeTurn();

  return { groups, views, ordered };
}

function renderGroup(
  g: Group,
  idx: number,
  all: Group[],
  ctx: { views: Map<string, PlanRevisionView>; ordered: PlanRevisionView[] },
  onRewindRequest: (turnId: string, messagesAfter: number) => void,
  onEditRequest: (turnId: string) => void,
  isTurnCollapsed: (turnId: string, hasWork: boolean, isLatest: boolean) => boolean,
  toggleTurn: (turnId: string, currentlyCollapsed: boolean) => void,
  isLatestTurn: boolean
) {
  if (g.kind === "user") {
    const messagesAfter = all.length - idx - 1;
    return (
      <UserMessage
        key={g.id}
        id={g.id}
        text={g.text}
        canRewind
        messagesAfter={messagesAfter}
        onRewindRequest={onRewindRequest}
        onEditRequest={onEditRequest}
      />
    );
  }
  // Turn — "Worked for Xs" header collapses ONLY the work (thought + tool
  // groups + interleaved narrative). The actual assistant response (final
  // text + plan cards) renders OUTSIDE the collapsible so it's never hidden.
  const hasWork = !!g.thought || g.blocks.length > 0;
  const collapsed = isTurnCollapsed(g.turnId, hasWork, isLatestTurn);
  return (
    <div key={g.turnId} className="turn">
      {hasWork && (
        <>
          <TurnHeader
            workedMs={g.workedMs}
            collapsed={collapsed}
            onToggle={() => toggleTurn(g.turnId, collapsed)}
          />
          {!collapsed && (
            <div className="turn-body">
              {g.thought && (
                <ThoughtBlock text={g.thought} durationMs={g.thoughtMs} />
              )}
              {g.blocks.map((b, i) => renderTurnBlock(b, i, ctx))}
            </div>
          )}
        </>
      )}
      {g.responseBlocks.length > 0 && (
        <div className="turn-response">
          {g.responseBlocks.map((b, i) => renderTurnBlock(b, i, ctx))}
        </div>
      )}
    </div>
  );
}

function renderTurnBlock(
  b: TurnBlock,
  i: number,
  ctx: { views: Map<string, PlanRevisionView>; ordered: PlanRevisionView[] }
) {
  if (b.kind === "narrative") {
    return (
      <div key={`n-${i}`} className="narrative">
        {renderMarkdown(b.text)}
      </div>
    );
  }
  if (b.kind === "toolGroup") {
    return (
      <ToolGroupCard
        key={`tg-${i}-${b.items[0].id}`}
        bucket={b.bucket}
        items={b.items}
      />
    );
  }
  // plan
  const view = ctx.views.get(b.revisionId);
  if (!view) return null;
  const ordinal = ctx.ordered.indexOf(view) + 1;
  const previous = ordinal > 1 ? ctx.ordered[ordinal - 2] : undefined;
  const isLatest = ordinal === ctx.ordered.length;
  return (
    <PlanCard
      key={`p-${b.revisionId}`}
      view={view}
      previous={previous}
      isLatest={isLatest}
      ordinal={ordinal}
    />
  );
}

// ── Inline message editor ───────────────────────────────────
//
// Replaces a user bubble in the timeline when the user clicks Edit.
// Wraps Composer in inline mode; local state owns the draft so the bottom
// composer's input is unaffected. RichEditor parses the original markdown
// (including code-pill blocks) on mount, so pills + the @ menu work
// identically to the main composer.
function InlineMessageEditor({
  initialText,
  busy,
  model,
  permissionMode,
  models,
  skills,
  authMode,
  onCancel,
  onSubmit
}: {
  initialText: string;
  busy: boolean;
  model: string;
  permissionMode: PermissionMode;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  authMode: AuthMode | null;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  return (
    <div className="msg msg-user msg-editing">
      <div className="msg-avatar">Y</div>
      <div className="msg-body">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={onSubmit}
          onCancel={onCancel}
          busy={busy}
          authMode={authMode}
          model={model}
          permissionMode={permissionMode}
          models={models}
          skills={skills}
          focusKey={0}
          pendingInsert={null}
          onInserted={() => {}}
          inline
          onDiscard={onCancel}
        />
      </div>
    </div>
  );
}
