export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  content: string | Array<ContentBlock>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type PermissionMode = "default" | "plan" | "auto";

export type TaskType =
  | "backend"
  | "frontend"
  | "fullstack"
  | "devops"
  | "integration"
  | "docs-driven"
  | "refactor"
  | "bugfix"
  | "migration"
  | "new-impl"
  | "generic";

export interface TokenUsage {
  /** Tokens read from prompt (incl. cached). */
  inputTokens: number;
  /** Tokens emitted by the assistant in this message. */
  outputTokens: number;
  /** Cached prompt tokens served from a previously-written cache (cheap). */
  cacheReadTokens?: number;
  /** Prompt tokens written to a new cache entry (one-time cost). */
  cacheCreatedTokens?: number;
  /** Total cost in USD if the provider reports it. */
  costUsd?: number;
  /** Free-form session identifier the provider associates with this usage. */
  sessionId?: string;
  /**
   * Authoritative quota info from Anthropic's `anthropic-ratelimit-*`
   * response headers. Present on API-mode responses; absent for subscription
   * mode (Claude CLI doesn't expose the underlying HTTP headers).
   */
  rateLimit?: {
    tokens: RateLimitBucket;
    inputTokens: RateLimitBucket;
    outputTokens: RateLimitBucket;
    requests: RateLimitBucket;
  };
}

export interface RateLimitBucket {
  limit?: number;
  remaining?: number;
  /** ms epoch when this bucket resets. */
  resetsAt?: number;
}

export interface StreamDelta {
  type:
    | "text"
    | "tool_use_start"
    | "tool_use_input"
    | "tool_use_end"
    | "tool_result"
    | "usage"
    | "model"
    | "done"
    | "error";
  text?: string;
  tool?: { id: string; name: string };
  partialInput?: string;
  error?: string;
  toolUseId?: string;
  resultContent?: string;
  resultIsError?: boolean;
  usage?: TokenUsage;
  /** Resolved model id the CLI reports for the turn (e.g. an alias like
   *  `opus` resolving to `claude-opus-4-8`). Carried on `type: "model"`. */
  model?: string;
}

export interface TimelineEvent {
  id: string;
  ts: number;
  kind:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "error"
    | "checkpoint"
    | "plan_revision"
    | "plan_question"
    | "plan_comment"
    | "plan_answer";
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
}

export interface PlanTaskFileRef {
  /** Workspace-relative path. */
  path: string;
  /** 1-based line number where the relevant slice starts. */
  startLine: number;
  /** 1-based line number where it ends (inclusive). */
  endLine: number;
  /** Optional caption shown on the step row. */
  label?: string;
}

export type PlanTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "accepted";

export interface PlanTask {
  id: string;
  content: string;
  activeForm: string;
  status: PlanTaskStatus;
  /** Optional file/range references parsed from the task body. */
  fileRefs?: PlanTaskFileRef[];
  /** True while the agent is paused waiting for the user to Accept / Modify / Skip. */
  blocked?: boolean;
}

export interface PlanRevisionMeta {
  revisionId: string;
  parentRevisionId?: string;
  toolUseId?: string;
  body: string;
  tasks: PlanTask[];
  /** False when only tasks changed (TodoWrite-only update). */
  bodyChanged: boolean;
  /** Path of the plan markdown file (e.g. ~/.claude/plans/foo.md) the CLI wrote, when the plan body came from a file rather than ExitPlanMode.input.plan. */
  planFilePath?: string;
  /** Parsed H2 sections from the plan body. Drives the completeness badge in
   *  PlanCard. Each value is the section's body text (may be empty if the
   *  heading exists with no content). Undefined means parsing wasn't run
   *  (e.g. plan from before this feature shipped). */
  sections?: PlanSections;
  /** Set when the user clicks "Proceed" — the revision is locked from further
   *  comments / step mutations / re-proceed until the user rewinds to this
   *  revision's checkpoint. */
  proceeded?: boolean;
  /** Permission mode the user was in just before clicking "Proceed". Restored
   *  on rewind so the user lands back where they started. */
  prePermissionMode?: PermissionMode;
}

/** Required sections in plan-mode.md, in the order the prompt mandates. */
export interface PlanSections {
  context?: string;
  approach?: string;
  conventions?: string;
  risks?: string;
  verification?: string;
}

export const REQUIRED_PLAN_SECTIONS: ReadonlyArray<keyof PlanSections> = [
  "context",
  "approach",
  "conventions",
  "risks",
  "verification"
] as const;

export interface PlanQuestionOption {
  label: string;
  description?: string;
}

export interface PlanQuestionEntry {
  question: string;
  header?: string;
  options: PlanQuestionOption[];
  multiSelect?: boolean;
}

export interface PlanQuestionMeta {
  questionId: string;
  toolUseId: string;
  revisionId?: string;
  questions: PlanQuestionEntry[];
}

export interface PlanCommentMeta {
  commentId: string;
  revisionId: string;
  /**
   * Either a real task id from the plan, "__general__" for whole-plan comments
   * left in the header dropdown, or "__inline__" for comments anchored to a
   * specific text passage via the selection-+ trigger in the modal body.
   */
  taskId: string;
  body: string;
  /**
   * For inline comments, the exact substring of the plan body the user
   * selected before clicking "+". Used to render a "quoting" preview next
   * to the comment and to highlight the passage in the document on render.
   */
  quote?: string;
  /** Set once a follow-up revision lands after the comment was submitted. */
  resolvedInRevisionId?: string;
  /** Soft-delete: the event stays in the timeline (rewind safety) but is
   * hidden in the UI and excluded from feedback resubmits. */
  deleted?: boolean;
  /** Last-edited timestamp (only set after at least one edit). */
  editedAt?: number;
  /** Threading: when set, this comment is a reply to another. */
  parentCommentId?: string;
  /** Manual resolve toggle (separate from the auto resolvedInRevisionId
   * which fires when a follow-up plan revision lands). */
  resolvedAt?: number;
}

export interface PlanAnswerMeta {
  questionId: string;
  /** Per-question answer keyed by question index. */
  answers: Array<{ choice: string; note?: string }>;
}
