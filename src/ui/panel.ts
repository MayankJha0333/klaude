import * as vscode from "vscode";
import { Session } from "../core/session.js";
import { Orchestrator } from "../core/orchestrator.js";
import { PermissionMode, StreamDelta, PlanRevisionMeta } from "../core/types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createProvider } from "../providers/factory.js";
import { getToken, setToken, deleteToken, classifyToken } from "../secrets.js";
import { CheckpointService } from "../services/checkpoint.js";
import { HistoryService, deriveTitle } from "../services/history.js";
import { PlanDecorationService } from "../services/plan-decorations.js";
import { PlanArtifactManager } from "./plan-artifact-panel.js";
import { discoverClaudeSkills } from "../services/claude-skills.js";
import {
  loadConventions,
  disposeConventionsWatchers,
  ConventionsFile
} from "../services/conventions.js";
import { classifyTask } from "../core/task-classifier.js";
import { getSkillSuggestion } from "../services/skill-suggestions.js";
import {
  fetchMarketplace,
  installSkill as installMarketplaceSkill,
  uninstallSkill as uninstallMarketplaceSkill,
  InstallScope,
  InstallTarget
} from "../services/marketplace.js";
import { aggregateClaudeCodeUsage } from "../services/claude-code-usage.js";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "iridescent.chat";

  private view?: vscode.WebviewView;
  private session!: Session;
  private orchestrator?: Orchestrator;
  private resumeId?: string;
  private checkpoints?: CheckpointService;
  private history: HistoryService;
  private decorations: PlanDecorationService;
  private artifacts: PlanArtifactManager;
  private saveTimer?: NodeJS.Timeout;
  /** Sticky flag set when the user has clicked Logout this session.
   *  `broadcastAuthState` ORs this with "no token in SecretStorage" to
   *  decide whether the webview should show the welcome screen — so even
   *  if SecretStorage somehow returns a stale token, the explicit logout
   *  takes precedence until the user signs back in. */
  private signedOut = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.history = new HistoryService(ctx);
    this.decorations = new PlanDecorationService(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
    this.artifacts = new PlanArtifactManager(ctx);
    // Artifact panels share the chat panel's RPC handler so any user action
    // (comment, accept, reply, …) reaches the same session no matter which
    // surface fired it.
    this.artifacts.setMessageHandler((msg) => this.onMessage(msg));
    ctx.subscriptions.push({
      dispose: () => {
        this.decorations.dispose();
        this.artifacts.closeAll();
        disposeConventionsWatchers();
      }
    });
    this.initSession();
  }

  private initSession() {
    this.session = new Session();
    this.attachSessionListeners();
  }

  /**
   * Wire timeline + per-turn + per-plan-revision hooks onto the current
   * session. Factored out so it can be reused after `loadHistorySession`
   * and `restoreLatestSession` swap the session instance.
   */
  private attachSessionListeners() {
    this.session.onEvent((e) => {
      this.post({ type: "timeline", event: e });
      this.trackFileForCheckpoint(e);
      // Each plan revision is its own restore point so rewind can land on
      // any revision and bring file state + comment threads with it.
      if (e.kind === "plan_revision" && this.checkpoints) {
        void this.checkpoints.captureBeforePlanRevision(e.id);
      }
      // Mirror plan changes into editor decorations so comments + active
      // step are visible inline next to the source.
      if (
        e.kind === "plan_revision" ||
        e.kind === "plan_comment"
      ) {
        this.decorations.syncFromTimeline(this.session.timeline);
      }
      this.scheduleSave();
    });
    this.session.onUserTurn(async (eventId) => {
      if (this.checkpoints) {
        await this.checkpoints.captureBefore(eventId);
      }
    });
  }

  /** Debounced save — coalesces bursts of timeline events into one write. */
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.history.save({
        id: this.session.id,
        title: deriveTitle(this.session.timeline),
        createdAt: this.session.createdAt,
        updatedAt: Date.now(),
        messages: this.session.messages,
        timeline: this.session.timeline,
        resumeId: this.resumeId
      });
    }, 400);
  }

  /**
   * When the agent (or the Claude CLI agent) calls a write/edit tool, snapshot
   * the file's *current* content into the latest checkpoint so rewind can
   * restore it. This fires synchronously before the tool actually runs (we
   * see the tool_call event right before fs.writeFile / CLI Write executes).
   */
  private trackFileForCheckpoint(e: { kind: string; body?: string; meta?: Record<string, unknown> }) {
    if (!this.checkpoints) return;
    if (e.kind !== "tool_call") return;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(e.body ?? "{}");
    } catch {
      return;
    }
    const rel = String(input.path ?? input.file_path ?? input.filePath ?? "");
    if (!rel) return;
    const name = String(e.meta?.name ?? "").toLowerCase();
    // Claude CLI's Write / Edit / MultiEdit / NotebookEdit / Update tools.
    if (/^(write|edit|multiedit|notebookedit|update|create|str_replace_editor)/.test(name)) {
      void this.checkpoints.addFileToLatest(rel);
    }
  }

  private ensureCheckpoints(workspaceRoot: string) {
    if (!this.checkpoints) {
      this.checkpoints = new CheckpointService(workspaceRoot, this.session.id);
    }
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "webview", "dist")]
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.post({ type: "hello", sessionId: this.session.id });
    void this.broadcastAuthState();
    // Try to pick up the most recently used chat instead of starting fresh.
    // Without this, every VS Code reload / extension activation would create
    // a new Session id and the user's "one chat" would split across
    // history entries on each reload. The restore is best-effort: if there's
    // no prior session (or none with user content) we just keep the empty
    // session that the constructor created.
    void this.restoreLatestSession().then(() => {
      this.replayTimeline();
      void this.broadcastClaudeCodeUsage();
    });
    this.wireEditorContext();
    // Refresh aggregated Claude Code usage every 60s while the panel is
    // open. Cheap on disk (a few JSONL files per workspace) and keeps the
    // meter honest if the user runs `claude` from a terminal.
    const timer = setInterval(() => {
      void this.broadcastClaudeCodeUsage();
    }, 60_000);
    this.ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  /** Aggregate authoritative usage from Claude Code's per-workspace JSONL
   *  files and push it to the webview. No-op if no workspace is open. */
  private async broadcastClaudeCodeUsage(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    try {
      const agg = await aggregateClaudeCodeUsage(root);
      this.post({
        type: "claudeCodeUsage",
        session: agg.session,
        today: agg.today,
        week: agg.week,
        weekSonnet: agg.weekSonnet,
        total: agg.total,
        generatedAt: agg.generatedAt,
        available: agg.available
      });
    } catch {
      // best-effort; the chip falls back to its estimate
    }
  }

  /**
   * On startup, list saved sessions and adopt the most recently updated one
   * as the current session. The user can still click "New Chat" to start a
   * fresh one explicitly.
   */
  private async restoreLatestSession(): Promise<void> {
    // Only restore if our in-memory session is still empty — otherwise we'd
    // clobber a user that's already typing. (Ordinarily the constructor's
    // fresh session is empty until the first prompt.)
    if (this.session.timeline.length > 0) return;
    try {
      const list = await this.history.list();
      if (list.length === 0) return;
      const latest = list[0]; // already sorted by updatedAt desc
      const stored = await this.history.load(latest.id);
      if (!stored || stored.timeline.length === 0) return;

      this.session = new Session(stored.title);
      Object.defineProperty(this.session, "id", { value: stored.id });
      Object.defineProperty(this.session, "createdAt", { value: stored.createdAt });
      this.session.messages = stored.messages;
      this.session.timeline = stored.timeline;
      this.session.title = stored.title;
      this.resumeId = stored.resumeId;

      // Re-attach the same listener wiring `initSession` would have set.
      // (We replaced this.session, so the prior closure now points at a
      // dead Session object.)
      this.attachSessionListeners();
    } catch {
      // Restore is best-effort; on any failure we fall through to the
      // empty session created by the constructor.
    }
  }

  private wireEditorContext() {
    const broadcast = () => this.broadcastEditorContext();
    this.ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        broadcast();
        if (ed) this.decorations.refreshEditor(ed, this.session.timeline);
      }),
      vscode.window.onDidChangeTextEditorSelection(broadcast)
    );
    broadcast();
  }

  private broadcastEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      this.post({ type: "editorContext", context: null });
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection;
    this.post({
      type: "editorContext",
      context: {
        file: rel,
        language: ed.document.languageId,
        selection: sel.isEmpty
          ? null
          : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 }
      }
    });
  }

  /**
   * Compute the authoritative auth status by inspecting SecretStorage.
   * `authed` is true when a token is present AND the user hasn't actively
   * signed out this session. We broadcast both the auth status and the
   * model / permission-mode so the webview can hydrate ChatScreen state.
   */
  async broadcastAuthState() {
    const cfg = vscode.workspace.getConfiguration("iridescent");
    const model = cfg.get<string>("model", "claude-sonnet-4-6");
    const permissionMode = cfg.get<PermissionMode>("permissionMode", "default");
    const token = await getToken(this.ctx);
    const authed = !this.signedOut && !!token;
    this.post({
      type: "auth",
      authed,
      model,
      permissionMode
    });
    if (authed) {
      await this.broadcastModels();
      await this.broadcastSkills();
    }
  }

  /**
   * Sign out. Iridescent owns auth state entirely (token in SecretStorage),
   * so logout is a single durable operation: confirm → cancel any in-flight
   * stream → delete the secret → flip the webview to the welcome screen.
   * No CLI invocation, no `~/.claude/` file manipulation. The user can sign
   * back in by pasting a fresh token on the welcome screen.
   */
  /**
   * Run a shell command in a fresh, integrated terminal.
   *
   * IMPORTANT: we always dispose any existing "Iridescent Setup" terminal
   * before creating a new one. Re-using a terminal that previously hosted
   * `claude` (or any other interactive command) would cause `sendText` to
   * type the new command **as input into the still-running process**
   * rather than execute it as a shell command. Disposing first guarantees
   * a clean shell prompt.
   *
   * `sendText` is also deferred to the next tick so the new terminal's
   * shell has time to print its initial prompt — without that, on some
   * shells (zsh with slow init) the keystrokes can interleave with the
   * shell startup output.
   */
  private runTerminalCommand(command: string): void {
    const existing = vscode.window.terminals.find(
      (t) => t.name === "Iridescent Setup"
    );
    existing?.dispose();
    const term = vscode.window.createTerminal({ name: "Iridescent Setup" });
    term.show(true);
    setTimeout(() => {
      term.sendText(command, true);
    }, 250);
  }

  private async handleClaudeLogout(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      "Sign out of Claude?",
      {
        modal: true,
        detail:
          "Removes the auth token stored in VS Code's SecretStorage and returns you to the welcome screen. Chat history, checkpoints, and pinned files are preserved."
      },
      "Sign out"
    );
    if (pick !== "Sign out") return;
    this.orchestrator?.cancel();
    this.orchestrator = undefined;
    this.resumeId = undefined;
    await deleteToken(this.ctx);
    this.signedOut = true;
    await this.broadcastAuthState();
  }

  /**
   * Accept a user-pasted token from the welcome screen. We do a
   * format-only check (no network round-trip — the actual validation
   * happens when the user's first prompt streams through the CLI). Posts
   * `tokenResult` back for the form to show success/failure inline.
   */
  private async handleSubmitToken(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!token) {
      this.post({ type: "tokenResult", ok: false, error: "Token is empty." });
      return;
    }
    const kind = classifyToken(token);
    if (kind === "unknown") {
      this.post({
        type: "tokenResult",
        ok: false,
        error:
          "Unrecognized token format. Use a Claude Code OAuth token (sk-ant-oat…) or an Anthropic Console API key (sk-ant-api…)."
      });
      return;
    }
    await setToken(this.ctx, token);
    this.signedOut = false;
    this.post({ type: "tokenResult", ok: true });
    await this.broadcastAuthState();
  }

  reveal() {
    this.view?.show?.(true);
  }

  newSession() {
    this.artifacts.closeAll();
    this.initSession();
    this.resumeId = undefined;
    this.checkpoints?.clear();
    this.checkpoints = undefined;
    this.orchestrator?.cancel();
    this.orchestrator = undefined;
    this.post({ type: "reset", sessionId: this.session.id });
  }

  async sendUserMessage(text: string) {
    this.reveal();
    await this.handlePrompt(text);
  }

  /**
   * Cmd+L: pull the active editor's selection (or current line if no
   * selection) and surface it inside the composer as a clean attachment.
   * Strips stray slash prefixes and other formatting artifacts.
   */
  /**
   * Right-click → "Iridescent: Comment on selection". Anchors a plan_comment
   * to the active editor's current selection on the latest plan revision.
   * The comment carries `quote` = the selected text so the existing
   * highlight + jump-to-passage flow lights up in the chat panel.
   */
  commentOnEditorSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showInformationMessage("Iridescent: open a file first.");
      return;
    }
    const sel = ed.selection;
    if (sel.isEmpty) {
      vscode.window.showInformationMessage("Iridescent: select some code first.");
      return;
    }
    const latest = [...this.session.timeline]
      .reverse()
      .find((e) => e.kind === "plan_revision");
    if (!latest) {
      vscode.window.showInformationMessage(
        "Iridescent: no active plan to comment on. Run a /plan turn first."
      );
      return;
    }
    const revisionId = (latest.meta as { revisionId?: string }).revisionId ?? "";
    const quote = ed.document.getText(sel);
    void vscode.window
      .showInputBox({
        prompt: "Comment on selection",
        placeHolder: "Leave a comment for the agent…"
      })
      .then((body) => {
        if (!body || !body.trim()) return;
        this.handlePlanComment(revisionId, "__inline__", body, quote);
        this.reveal();
      });
  }

  sendSelectionToChat() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showInformationMessage("Iridescent: open a file first.");
      return;
    }
    const sel = ed.selection;
    const range = sel.isEmpty ? ed.document.lineAt(sel.active.line).range : sel;
    const raw = ed.document.getText(range);
    const cleaned = cleanSelection(raw);
    if (!cleaned) {
      vscode.window.showInformationMessage("Iridescent: selection is empty.");
      return;
    }
    this.reveal();
    this.post({
      type: "insertSelection",
      file: vscode.workspace.asRelativePath(ed.document.uri),
      language: ed.document.languageId,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      text: cleaned
    });
  }

  private replayTimeline() {
    for (const e of this.session.timeline) this.post({ type: "timeline", event: e });
    this.decorations.syncFromTimeline(this.session.timeline);
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "prompt":
        await this.handlePrompt(String(msg.text ?? ""));
        break;
      case "cancel":
        this.orchestrator?.cancel();
        break;
      case "newSession":
        this.newSession();
        break;
      case "refreshAuth":
        await this.broadcastAuthState();
        break;
      case "openExternal":
        if (typeof msg.url === "string") await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "openFile":
        if (typeof msg.path === "string") {
          await this.handleOpenFile(
            msg.path,
            typeof msg.startLine === "number" ? msg.startLine : 0,
            typeof msg.endLine === "number" ? msg.endLine : 0
          );
        }
        break;
      case "revertFile":
        if (typeof msg.path === "string") {
          await this.handleRevertFile(msg.path);
        }
        break;
      case "refreshUsage":
        await this.broadcastClaudeCodeUsage();
        break;
      case "runTerminalCommand":
        if (typeof msg.command === "string") {
          this.runTerminalCommand(msg.command);
        }
        break;
      case "claudeLogout":
        await this.handleClaudeLogout();
        break;
      case "submitToken":
        if (typeof msg.token === "string") {
          await this.handleSubmitToken(msg.token);
        }
        break;
      case "setModel":
        if (typeof msg.model === "string") {
          await vscode.workspace
            .getConfiguration("iridescent")
            .update("model", msg.model, vscode.ConfigurationTarget.Global);
          await this.broadcastAuthState();
        }
        break;
      case "setPermissionMode":
        if (typeof msg.mode === "string") {
          await vscode.workspace
            .getConfiguration("iridescent")
            .update("permissionMode", msg.mode, vscode.ConfigurationTarget.Global);
          await this.broadcastAuthState();
        }
        break;
      case "rewindTo":
        if (typeof msg.turnId === "string") {
          await this.rewindTo(msg.turnId);
        }
        break;
      case "editAt":
        if (typeof msg.turnId === "string" && typeof msg.text === "string") {
          await this.editAt(msg.turnId, msg.text, msg.revertFiles === true);
        }
        break;
      case "refreshEditorContext":
        this.broadcastEditorContext();
        break;
      case "requestModels":
        await this.broadcastModels();
        break;
      case "requestSkills":
        await this.broadcastSkills();
        break;
      case "setSkillEnabled":
        if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
          await this.setSkillEnabled(msg.id, msg.enabled);
        }
        break;
      case "requestMarketplace":
        await this.handleRequestMarketplace(
          typeof msg.offset === "number" ? msg.offset : 0,
          typeof msg.limit === "number" ? msg.limit : 24,
          typeof msg.query === "string" ? msg.query : undefined
        );
        break;
      case "installMarketplaceSkill":
        if (
          msg.target &&
          typeof msg.target === "object" &&
          (msg.scope === "user" || msg.scope === "project")
        ) {
          await this.handleInstallMarketplaceSkill(
            msg.target as InstallTarget,
            msg.scope
          );
        }
        break;
      case "uninstallMarketplaceSkill":
        if (
          typeof msg.name === "string" &&
          (msg.scope === "user" || msg.scope === "project")
        ) {
          await this.handleUninstallMarketplaceSkill(msg.name, msg.scope);
        }
        break;
      case "requestFileSearch":
        await this.handleFileSearch(
          String(msg.query ?? ""),
          typeof msg.id === "string" ? msg.id : ""
        );
        break;
      case "captureSelection":
        this.sendSelectionToChat();
        break;
      case "requestHistory":
        await this.broadcastHistory();
        break;
      case "loadSession":
        if (typeof msg.id === "string") await this.loadHistorySession(msg.id);
        break;
      case "deleteHistoryEntry":
        if (typeof msg.id === "string") {
          await this.history.delete(msg.id);
          await this.broadcastHistory();
        }
        break;
      case "planComment":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string" &&
          typeof msg.body === "string"
        ) {
          this.handlePlanComment(
            msg.revisionId,
            msg.taskId,
            msg.body,
            typeof msg.quote === "string" ? msg.quote : undefined
          );
        }
        break;
      case "planEditComment":
        if (typeof msg.commentId === "string" && typeof msg.body === "string") {
          this.handlePlanEditComment(msg.commentId, msg.body);
        }
        break;
      case "planDeleteComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanDeleteComment(msg.commentId);
        }
        break;
      case "planReplyComment":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.parentCommentId === "string" &&
          typeof msg.body === "string"
        ) {
          this.handlePlanReplyComment(
            msg.revisionId,
            msg.parentCommentId,
            msg.body
          );
        }
        break;
      case "planResolveComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanResolveComment(msg.commentId, true);
        }
        break;
      case "planReopenComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanResolveComment(msg.commentId, false);
        }
        break;
      case "planOpenFileRef":
        if (
          typeof msg.path === "string" &&
          typeof msg.startLine === "number" &&
          typeof msg.endLine === "number"
        ) {
          await this.handlePlanOpenFileRef(msg.path, msg.startLine, msg.endLine);
        }
        break;
      case "planAcceptStep":
        if (typeof msg.revisionId === "string" && typeof msg.taskId === "string") {
          await this.handlePlanAcceptStep(msg.revisionId, msg.taskId);
        }
        break;
      case "planModifyStep":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string" &&
          typeof msg.instruction === "string"
        ) {
          await this.handlePlanModifyStep(
            msg.revisionId,
            msg.taskId,
            msg.instruction
          );
        }
        break;
      case "planSkipStep":
        if (typeof msg.revisionId === "string" && typeof msg.taskId === "string") {
          this.handlePlanSkipStep(msg.revisionId, msg.taskId);
        }
        break;
      case "planOpenInEditor":
        if (typeof msg.revisionId === "string") {
          this.handlePlanOpenInEditor(msg.revisionId);
        }
        break;
      case "requestArtifactState":
        // Webview-side handshake: the artifact panel mounts, asks for
        // current state, and the host posts it back to that specific
        // panel only. Avoids the race where the post fires before the
        // webview's message listener is wired up.
        if (typeof msg.revisionId === "string") {
          this.artifacts.postToPanel(msg.revisionId, {
            type: "loadedSession",
            events: this.session.timeline,
            title: ""
          });
        }
        break;
      case "planResubmit":
        if (typeof msg.revisionId === "string") {
          await this.handlePlanResubmit(msg.revisionId);
        }
        break;
      case "planAnswer":
        if (
          typeof msg.questionId === "string" &&
          typeof msg.toolUseId === "string" &&
          Array.isArray(msg.answers)
        ) {
          await this.handlePlanAnswer(
            msg.questionId,
            msg.toolUseId,
            msg.answers as Array<{ choice: string; note?: string }>
          );
        }
        break;
      case "planRewindTo":
        if (typeof msg.revisionId === "string") {
          await this.rewindTo(msg.revisionId);
        }
        break;
      case "planProceedRequest":
        if (typeof msg.revisionId === "string") {
          await this.handlePlanProceed(msg.revisionId);
        }
        break;
      case "dismissConventionsBanner":
        await this.ctx.workspaceState.update(
          "iridescent.conventionsBannerDismissed.v1",
          true
        );
        break;
      case "openConventionsFile":
        if (typeof msg.path === "string") {
          await vscode.window.showTextDocument(vscode.Uri.file(msg.path));
        }
        break;
      case "generateConventions":
        await vscode.commands.executeCommand("iridescent.generateConventions");
        break;
      case "dismissSkillSuggestion":
        if (typeof msg.skillId === "string") {
          const list = this.ctx.workspaceState.get<string[]>(
            "iridescent.skillSuggestionDismissed.v1",
            []
          );
          if (!list.includes(msg.skillId)) {
            await this.ctx.workspaceState.update(
              "iridescent.skillSuggestionDismissed.v1",
              [...list, msg.skillId]
            );
          }
        }
        break;
    }
  }

  /** Tell the webview which conventions file is loaded so the status pill can
   *  render. Posts even when null so the pill can clear. */
  private broadcastConventionsStatus(c: ConventionsFile | null): void {
    this.post({
      type: "conventionsStatus",
      source: c?.source ?? null,
      path: c?.absolutePath ?? null,
      relativePath: c?.workspaceRelativePath ?? null,
      hasAlternative: c?.hasAlternative ?? false
    });
  }

  /** Plan mode only: if the classifier picked a task type with a known
   *  marketplace skill recommendation and that skill isn't installed, post a
   *  one-line suggestion to the webview. Reuses the existing
   *  `installMarketplaceSkill` flow when the user clicks Install. */
  private async maybeSuggestSkill(
    taskType: import("../core/types.js").TaskType,
    workspaceRoot: string
  ): Promise<void> {
    const dismissed = this.ctx.workspaceState.get<string[]>(
      "iridescent.skillSuggestionDismissed.v1",
      []
    );
    const suggestion = await getSkillSuggestion(taskType, workspaceRoot);
    if (!suggestion) return;
    if (dismissed.includes(suggestion.skillId)) return;
    this.post({
      type: "skillSuggestion",
      skillId: suggestion.skillId,
      skillName: suggestion.skillName,
      reason: suggestion.reason,
      taskType: suggestion.taskType
    });
  }

  /** After 3+ turns in a workspace with no conventions file, show a one-time
   *  banner suggesting the user generate one. Dismissal is workspace-scoped. */
  private maybeShowConventionsBanner(c: ConventionsFile | null): void {
    if (c) return;
    const dismissed = this.ctx.workspaceState.get<boolean>(
      "iridescent.conventionsBannerDismissed.v1",
      false
    );
    if (dismissed) return;
    const turnCount = this.ctx.workspaceState.get<number>(
      "iridescent.turnCount.v1",
      0
    );
    const next = turnCount + 1;
    this.ctx.workspaceState.update("iridescent.turnCount.v1", next);
    if (next >= 3) {
      this.post({ type: "conventionsBanner" });
    }
  }

  /** Append a plan_comment event tied to a (revisionId, taskId). No round-trip yet. */
  private handlePlanComment(
    revisionId: string,
    taskId: string,
    body: string,
    quote?: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId,
      body: trimmed,
      quote: quote && quote.trim() ? quote.trim() : undefined
    });
  }

  /**
   * Edit an existing comment in place. We mutate the timeline event's meta
   * rather than emitting a superseding event so the rewind/truncate logic
   * stays simple — the comment remains anchored at its original position
   * for restore purposes.
   */
  private handlePlanEditComment(commentId: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.body = trimmed;
    meta.editedAt = Date.now();
    ev.body = trimmed;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Soft-delete: flag the comment as deleted but leave the event in the
   * timeline so any rewind to a checkpoint older than this delete restores
   * the comment intact. The webview filters deleted comments out at fold
   * time.
   */
  private handlePlanDeleteComment(commentId: string) {
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.deleted = true;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  private findCommentEvent(commentId: string) {
    return this.session.timeline.find(
      (e) =>
        e.kind === "plan_comment" &&
        (e.meta as { commentId?: string } | undefined)?.commentId === commentId
    );
  }

  private findRevisionEvent(revisionId: string) {
    return this.session.timeline.find(
      (e) =>
        e.kind === "plan_revision" &&
        (e.meta as { revisionId?: string } | undefined)?.revisionId === revisionId
    );
  }

  /**
   * True when the plan revision has been "proceeded" by the user — the
   * revision is locked from further comments / step mutations / re-Proceed
   * until the user rewinds to its checkpoint, which clears the flag.
   */
  private isRevisionProceeded(revisionId: string): boolean {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return false;
    return (ev.meta as { proceeded?: boolean } | undefined)?.proceeded === true;
  }

  private isCommentRevisionProceeded(commentId: string): boolean {
    const ev = this.findCommentEvent(commentId);
    if (!ev) return false;
    const revId = (ev.meta as { revisionId?: string } | undefined)?.revisionId;
    return revId ? this.isRevisionProceeded(revId) : false;
  }

  private postLockedError(): void {
    this.post({
      type: "error",
      message: "Plan is locked. Rewind to this revision's checkpoint to edit."
    });
  }

  /** Append a reply: a new plan_comment whose `parentCommentId` points at `parent`. */
  private handlePlanReplyComment(
    revisionId: string,
    parentCommentId: string,
    body: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const parent = this.findCommentEvent(parentCommentId);
    const parentMeta = parent?.meta as
      | { taskId?: string; quote?: string }
      | undefined;
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId: parentMeta?.taskId ?? "__general__",
      body: trimmed,
      // Inherit the parent's quote so the reply still renders in the
      // sidebar with a "jump to passage" affordance.
      quote: parentMeta?.quote,
      parentCommentId
    });
  }

  /** Toggle a comment's manual resolved state. */
  private handlePlanResolveComment(commentId: string, resolve: boolean) {
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    if (resolve) meta.resolvedAt = Date.now();
    else delete meta.resolvedAt;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Reveal a workspace-relative path at the given range and select that
   * range so the user sees the slice the plan step is talking about.
   */
  /**
   * Restore a single file from the most recent checkpoint that snapshotted
   * it. Used by the per-file "Revert" affordance on the EditedFilesCard.
   *
   * `pathOrRel` may be absolute or workspace-relative; `CheckpointService`
   * normalizes both forms internally so the lookup matches regardless of
   * which form the agent's tool input used.
   *
   * Posts a `revertResult` back to the webview with one of three shapes:
   *   - ok: true                          — file overwritten or removed
   *   - ok: false, error: "<no snapshot>" — no checkpoint contains this file
   *   - ok: false, error: <other>         — IO failure
   */
  private async handleRevertFile(pathOrRel: string): Promise<void> {
    if (!this.checkpoints) {
      this.post({
        type: "revertResult",
        path: pathOrRel,
        ok: false,
        error:
          "Checkpoints aren't initialized yet — run at least one prompt first."
      });
      return;
    }
    try {
      const result = await this.checkpoints.restoreFile(pathOrRel);
      if (!result) {
        this.post({
          type: "revertResult",
          path: pathOrRel,
          ok: false,
          error:
            "No prior snapshot for this file (the agent created it before checkpointing started, or it's outside the workspace)."
        });
        return;
      }
      // Synchronize the VS Code buffer with the restored file on disk.
      // Without this, an editor that already had this file open keeps the
      // stale in-memory version and the user can't see the rollback. Two
      // cases:
      //   • File was deleted (existed:false snapshot): close the editor.
      //   • File was overwritten: revert the buffer to disk via the
      //     workbench command. This works even if the user had unsaved
      //     edits (those edits would have been the agent's post-write
      //     content anyway, so dropping them is correct).
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const isAbs =
          pathOrRel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathOrRel);
        const uri = isAbs
          ? vscode.Uri.file(pathOrRel)
          : root
            ? vscode.Uri.joinPath(root, pathOrRel)
            : null;
        if (uri) {
          if (result.deleted) {
            // Try to close the now-deleted file's tab.
            await vscode.commands.executeCommand(
              "vscode.removeFromRecentlyOpened",
              uri
            );
          } else {
            // Force-refresh: show the file and revert its buffer to disk.
            await vscode.window.showTextDocument(uri, {
              preview: false,
              preserveFocus: false
            });
            await vscode.commands.executeCommand(
              "workbench.action.files.revert"
            );
          }
        }
      } catch {
        // best-effort refresh; failure here doesn't change the revert outcome
      }
      this.post({ type: "revertResult", path: pathOrRel, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "revertResult", path: pathOrRel, ok: false, error: msg });
    }
  }

  /**
   * Reveal a file in the editor. Accepts either an absolute path or a path
   * relative to the workspace root. When a line range is given, the editor
   * scrolls to it and selects that span; otherwise it just opens the file.
   */
  private async handleOpenFile(
    pathOrRel: string,
    startLine: number,
    endLine: number
  ): Promise<void> {
    let target: vscode.Uri;
    if (pathOrRel.startsWith("/") || /^[A-Za-z]:\\/.test(pathOrRel)) {
      target = vscode.Uri.file(pathOrRel);
    } else {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        this.post({ type: "error", message: "Open a workspace folder first." });
        return;
      }
      target = vscode.Uri.joinPath(root, pathOrRel);
    }
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      const options: vscode.TextDocumentShowOptions = { preview: false };
      if (startLine > 0) {
        const start = new vscode.Position(Math.max(0, startLine - 1), 0);
        const endIdx = Math.max(start.line, (endLine || startLine) - 1);
        const lineLen = doc.lineAt(Math.min(endIdx, doc.lineCount - 1)).text.length;
        options.selection = new vscode.Range(
          start,
          new vscode.Position(endIdx, lineLen)
        );
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `Could not open ${pathOrRel}: ${msg}` });
    }
  }

  private async handlePlanOpenFileRef(
    relPath: string,
    startLine: number,
    endLine: number
  ) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: "error", message: "Open a workspace folder to navigate plan steps." });
      return;
    }
    const target = vscode.Uri.joinPath(root, relPath);
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      const start = new vscode.Position(Math.max(0, startLine - 1), 0);
      const endLineIdx = Math.max(start.line, endLine - 1);
      const lineLen = doc.lineAt(Math.min(endLineIdx, doc.lineCount - 1)).text.length;
      const end = new vscode.Position(endLineIdx, lineLen);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(start, end),
        preview: false
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `Could not open ${relPath}: ${msg}` });
    }
  }

  /**
   * Mutate a single task's status on its plan_revision and re-post the event.
   * Returns the updated revision event (or null if it doesn't exist) so callers
   * can chain a follow-up agent prompt.
   */
  private mutateTaskStatus(
    revisionId: string,
    taskId: string,
    nextStatus: "accepted" | "skipped" | "in_progress"
  ) {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return null;
    const meta = ev.meta as { tasks?: Array<{ id: string; status: string }> } & Record<
      string,
      unknown
    >;
    const tasks = meta.tasks ?? [];
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;
    tasks[idx] = { ...tasks[idx], status: nextStatus };
    meta.tasks = tasks;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
    return { ev, task: tasks[idx] };
  }

  /**
   * Plan "Proceed" pressed. Show a permission popup, switch out of plan mode
   * if needed, then send the continuation prompt — all in one step so the
   * agent can start writing without the user having to manually flip mode.
   */
  private async handlePlanProceed(revisionId: string): Promise<void> {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }

    const cfg = vscode.workspace.getConfiguration("iridescent");
    const currentMode = cfg.get<PermissionMode>("permissionMode", "default");

    const choice = await vscode.window.showInformationMessage(
      "Iridescent has a plan ready. Allow it to start implementing?",
      {
        modal: true,
        detail:
          currentMode === "plan"
            ? "Plan mode blocks edits. Approving switches into Agent mode so the agent can carry out the plan autonomously."
            : "The agent will continue with file edits and any necessary commands."
      },
      "Allow & continue"
    );

    if (!choice) return; // user cancelled / closed modal

    // Out of plan, go straight into Agent mode (auto). Anywhere else, leave
    // the user's chosen mode alone.
    const targetMode: PermissionMode =
      currentMode === "plan" ? "auto" : currentMode;

    if (targetMode !== currentMode) {
      await cfg.update(
        "permissionMode",
        targetMode,
        vscode.ConfigurationTarget.Global
      );
      // Mirror the change back to the webview so the mode pill updates
      // before the next turn begins.
      await this.broadcastAuthState();
      // Drop the prior CLI resume id. Without this, the next claude-cli
      // invocation passes --resume <plan-mode-session> and the resumed
      // session's stored permission posture (plan = no edits) sticks even
      // though we passed a new --permission-mode flag, so writes keep
      // getting denied with "It seems write permissions need to be
      // granted." A fresh session honors the new mode cleanly. We hand
      // the plan file path back to the agent in the continuation prompt
      // below so the lost conversation context is recovered.
      this.resumeId = undefined;
    }

    // Lock the revision: no more comments / step mutations / re-Proceed
    // until the user rewinds to this revision's checkpoint. Capture the
    // pre-Proceed mode so rewind can restore it.
    const ev = this.findRevisionEvent(revisionId);
    const planFilePath =
      ev && ((ev.meta as { planFilePath?: string } | undefined)?.planFilePath ?? undefined);
    if (ev) {
      const meta = ev.meta as Record<string, unknown>;
      meta.proceeded = true;
      meta.prePermissionMode = currentMode;
      this.post({ type: "timeline", event: ev });
      this.scheduleSave();
    }

    // Continue the conversation. If we cleared resumeId above, the agent
    // is in a fresh session with no planning context — so we hand it the
    // plan file path to re-read. The "permission mode has changed" line
    // is load-bearing: without it the model occasionally remembers being
    // told (in the prior plan-mode prompt) to refuse edits and gets stuck
    // even though the gate is open.
    const continuation = [
      "Plan approved. The permission mode has been switched out of plan mode — you now have permission to make file edits and run the commands the plan requires.",
      planFilePath
        ? `Re-read the plan at \`${planFilePath}\` and carry out each step in order.`
        : "Carry out each step of the plan in order.",
      "Stop only if you hit a blocker that requires user input."
    ].join("\n\n");
    void this.handlePrompt(continuation);
  }

  private async handlePlanAcceptStep(revisionId: string, taskId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const result = this.mutateTaskStatus(revisionId, taskId, "accepted");
    if (!result) return;
    const taskMeta = result.task as { content?: string };
    const content = taskMeta.content ?? "this step";
    await this.handlePrompt(
      `Step approved — proceed with: "${content}".\n\n` +
        "Execute only this step, then stop and wait for the next instruction. " +
        "When done, emit a TodoWrite that marks this step's status as " +
        "\"completed\" and leaves later steps untouched."
    );
  }

  private async handlePlanModifyStep(
    revisionId: string,
    taskId: string,
    instruction: string
  ) {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return;
    const meta = ev.meta as { tasks?: Array<{ id: string; content?: string; status: string }> };
    const task = meta.tasks?.find((t) => t.id === taskId);
    const content = task?.content ?? "the step";
    await this.handlePrompt(
      `Modify the plan step: "${content}".\n\n` +
        `Change requested: ${trimmed}\n\n` +
        "Preserve every step that is already marked accepted or completed. " +
        "Regenerate downstream steps as needed and emit a fresh ExitPlanMode " +
        "(plus TodoWrite) reflecting the updated plan."
    );
  }

  private handlePlanSkipStep(revisionId: string, taskId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    this.mutateTaskStatus(revisionId, taskId, "skipped");
  }

  /**
   * Reveal the plan as a real editor tab. The artifact webview shares the
   * same compiled bundle as the chat panel; it loads `ArtifactApp` instead
   * of the chat shell because the host injects window globals that the
   * webview entry reads at boot.
   */
  private handlePlanOpenInEditor(revisionId: string) {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) {
      this.post({ type: "error", message: "That plan revision is no longer available." });
      return;
    }
    const meta = ev.meta as unknown as PlanRevisionMeta;
    this.artifacts.open(meta);
  }

  /**
   * Bundle all unresolved plan_comment events for `revisionId` into a single
   * structured user turn and feed it back through the regular handlePrompt
   * pipeline. The orchestrator's PlanInterceptor will turn the response into
   * a fresh plan_revision with parentRevisionId pointing at the old one.
   */
  private async handlePlanResubmit(revisionId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const comments = this.session.timeline.filter(
      (e) =>
        e.kind === "plan_comment" &&
        (e.meta as { revisionId?: string } | undefined)?.revisionId === revisionId &&
        !(e.meta as { resolvedInRevisionId?: string } | undefined)?.resolvedInRevisionId
    );
    if (comments.length === 0) return;

    const tasksById = new Map<string, string>();
    const revEvent = this.session.timeline.find(
      (e) => e.kind === "plan_revision" && (e.meta as { revisionId?: string })?.revisionId === revisionId
    );
    const tasks = (revEvent?.meta as { tasks?: Array<{ id: string; content: string }> } | undefined)?.tasks ?? [];
    for (const t of tasks) tasksById.set(t.id, t.content);

    interface CommentEntry { body: string; quote?: string }
    const grouped = new Map<string, CommentEntry[]>();
    for (const c of comments) {
      const meta = c.meta as { taskId: string; body: string; quote?: string };
      const list = grouped.get(meta.taskId) ?? [];
      list.push({ body: meta.body, quote: meta.quote });
      grouped.set(meta.taskId, list);
    }

    const lines = ["The plan needs revision based on this feedback:", ""];
    for (const [taskId, entries] of grouped) {
      const label =
        taskId === "__general__"
          ? "Whole-plan feedback"
          : taskId === "__inline__"
            ? "Inline feedback"
            : (tasksById.get(taskId) ?? `(task ${taskId})`);
      lines.push(`**${label}**`);
      for (const e of entries) {
        if (e.quote) {
          // Truncate long quotes — the agent doesn't need the whole passage,
          // just enough to relocate what the user was reacting to.
          const snippet = e.quote.length > 240 ? `${e.quote.slice(0, 237)}…` : e.quote;
          lines.push(`- (re: "${snippet.replace(/\s+/g, " ").trim()}") ${e.body}`);
        } else {
          lines.push(`- ${e.body}`);
        }
      }
      lines.push("");
    }
    lines.push("Produce an updated plan via ExitPlanMode that addresses each comment.");
    await this.handlePrompt(lines.join("\n"));
  }

  /**
   * Record the user's question-card answers in the timeline, then forward
   * them as a synthetic user turn so the model knows how to proceed.
   */
  private async handlePlanAnswer(
    questionId: string,
    _toolUseId: string,
    answers: Array<{ choice: string; note?: string }>
  ) {
    this.session.emitPlanAnswer({ questionId, answers });
    const summary = answers
      .map((a, i) => `Q${i + 1}: ${a.choice}${a.note ? ` (${a.note})` : ""}`)
      .join("; ");
    await this.handlePrompt(`Answer to your question — ${summary}`);
  }

  private async broadcastHistory() {
    const sessions = await this.history.list();
    this.post({ type: "historyList", sessions });
  }

  private async loadHistorySession(id: string) {
    const stored = await this.history.load(id);
    if (!stored) {
      this.post({ type: "error", message: "Session not found." });
      return;
    }
    // Replace the in-memory session with the stored one. We don't construct a
    // brand-new Session() because we need the id/createdAt to match for
    // subsequent saves to overwrite the same file.
    this.artifacts.closeAll();
    this.orchestrator?.cancel();
    this.orchestrator = undefined;
    this.checkpoints?.clear();
    this.checkpoints = undefined;
    this.resumeId = stored.resumeId;

    this.session = new Session(stored.title);
    // Splice in the persisted state. (The Session constructor already set a
    // fresh id/createdAt — overwrite via Object.defineProperty since they're
    // declared readonly. Cleaner than reworking Session's API for one site.)
    Object.defineProperty(this.session, "id", { value: stored.id });
    Object.defineProperty(this.session, "createdAt", { value: stored.createdAt });
    this.session.messages = stored.messages;
    this.session.timeline = stored.timeline;
    this.session.title = stored.title;

    this.attachSessionListeners();

    this.post({ type: "loadedSession", events: stored.timeline, title: stored.title });
  }

  // ── Models / skills / search ─────────────────────────────────

  private async broadcastModels() {
    this.post({ type: "models", models: availableModels() });
  }

  private static readonly DISABLED_SKILLS_KEY = "iridescent.disabledSkills.v1";

  private async broadcastSkills() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const disabled = new Set(
      this.ctx.globalState.get<string[]>(ChatPanelProvider.DISABLED_SKILLS_KEY, [])
    );
    const skills = await availableSkills(workspaceRoot, disabled);
    this.post({ type: "skills", skills });
  }

  private async setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    const list = this.ctx.globalState.get<string[]>(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      []
    );
    const set = new Set(list);
    if (enabled) set.delete(id);
    else set.add(id);
    await this.ctx.globalState.update(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      Array.from(set)
    );
    await this.broadcastSkills();
  }

  // ── Marketplace handlers ────────────────────────────────────

  private async handleRequestMarketplace(
    offset: number,
    limit: number,
    query: string | undefined
  ): Promise<void> {
    try {
      const result = await fetchMarketplace({ offset, limit, query });
      this.post({
        type: "marketplaceList",
        skills: result.skills.map((s) => ({
          id: s.id,
          name: s.name,
          namespace: s.namespace,
          description: s.description,
          author: s.author,
          stars: s.stars,
          installs: s.installs,
          sourceUrl: s.sourceUrl,
          repoOwner: s.repoOwner,
          repoName: s.repoName,
          directoryPath: s.directoryPath
        })),
        total: result.total,
        offset: result.offset,
        limit: result.limit
      });
    } catch (err) {
      this.post({
        type: "marketplaceError",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async handleInstallMarketplaceSkill(
    target: InstallTarget,
    scope: InstallScope
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await installMarketplaceSkill(target, scope, cwd);
    this.post({
      type: "marketplaceInstallResult",
      action: "install",
      name: target.name,
      ok: result.ok,
      scope: result.scope,
      installPath: result.installPath,
      filesWritten: result.filesWritten,
      error: result.error
    });
    // Re-broadcast so the picker picks up the new skill in its on-disk source.
    if (result.ok) {
      await this.broadcastSkills();
    }
  }

  private async handleUninstallMarketplaceSkill(
    name: string,
    scope: InstallScope
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await uninstallMarketplaceSkill(name, scope, cwd);
    this.post({
      type: "marketplaceInstallResult",
      action: "uninstall",
      name,
      ok: result.ok,
      scope: result.scope,
      error: result.error
    });
    if (result.ok) {
      await this.broadcastSkills();
    }
  }

  private async handleFileSearch(query: string, id: string) {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.post({ type: "fileSearchResults", id, results: [] });
      return;
    }
    const glob = query ? `**/*${escapeGlob(query)}*` : "**/*";
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, glob),
      "**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__}/**",
      40
    );
    const q = query.toLowerCase();
    const results = found
      .map((u) => ({
        path: vscode.workspace.asRelativePath(u),
        name: u.path.split("/").pop() ?? ""
      }))
      .sort((a, b) => {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        if (q) {
          const aMatch = an.startsWith(q) ? 0 : an.includes(q) ? 1 : 2;
          const bMatch = bn.startsWith(q) ? 0 : bn.includes(q) ? 1 : 2;
          if (aMatch !== bMatch) return aMatch - bMatch;
        }
        return a.path.localeCompare(b.path);
      })
      .slice(0, 12);
    this.post({ type: "fileSearchResults", id, results });
  }

  private async rewindTo(turnId: string) {
    if (!this.checkpoints) {
      this.post({ type: "error", message: "No checkpoint for this message." });
      return;
    }
    if (!this.checkpoints.hasCheckpoint(turnId)) {
      this.post({ type: "error", message: "No checkpoint for this message." });
      return;
    }
    this.orchestrator?.cancel();
    await this.checkpoints.restore(turnId);
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;

    // If the user is rewinding to a proceeded plan revision, unlock it so
    // they can comment / modify steps / re-Proceed, and restore the
    // permission mode that was active just before they pressed Proceed.
    const target = surviving.find((e) => e.id === turnId);
    if (target && target.kind === "plan_revision") {
      const meta = target.meta as {
        proceeded?: boolean;
        prePermissionMode?: PermissionMode;
      } | undefined;
      if (meta?.proceeded) {
        const prevMode = meta.prePermissionMode;
        delete meta.proceeded;
        delete meta.prePermissionMode;
        if (prevMode) {
          const cfg = vscode.workspace.getConfiguration("iridescent");
          const currentMode = cfg.get<PermissionMode>("permissionMode", "default");
          if (currentMode !== prevMode) {
            await cfg.update(
              "permissionMode",
              prevMode,
              vscode.ConfigurationTarget.Global
            );
            await this.broadcastAuthState();
          }
        }
        this.scheduleSave();
      }
    }

    this.post({ type: "rewind", events: surviving });
  }

  private async editAt(turnId: string, text: string, revertFiles: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.orchestrator?.cancel();
    if (revertFiles && this.checkpoints?.hasCheckpoint(turnId)) {
      await this.checkpoints.restore(turnId);
    }
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;
    this.post({ type: "rewind", events: surviving });
    await this.handlePrompt(trimmed);
  }

  private async handlePrompt(text: string) {
    if (!text.trim()) return;
    const cfg = vscode.workspace.getConfiguration("iridescent");
    const model = cfg.get<string>("model", "claude-sonnet-4-6");
    const maxTokens = cfg.get<number>("maxTokens", 4096);
    const permMode = cfg.get<PermissionMode>("permissionMode", "default");
    const bashAllowlist = cfg.get<string[]>("allowedBashPatterns", []);
    // Skills the user toggled off in the picker. Passed through to the CLI
    // so it actually skips them at invocation time, not just visually.
    const disabledSkills = this.ctx.globalState.get<string[]>(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      []
    );

    // Refuse to start a turn when no token is stored — defends against
    // race conditions where the user clicks Send during the brief window
    // between rendering the chat and a sign-out event landing.
    const token = await getToken(this.ctx);
    if (!token || this.signedOut) {
      this.signedOut = !token;
      await this.broadcastAuthState();
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.post({ type: "error", message: "Open a folder to use Iridescent." });
      return;
    }

    this.ensureCheckpoints(workspaceRoot);

    // Per-turn prompt context: classify the task and discover project
    // conventions so the CLI gets the same grounding info every time.
    // Conventions are cached per-workspace and invalidated by file watcher.
    const activeFile = vscode.window.activeTextEditor
      ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const taskType = classifyTask(text, activeFile);
    const conventions = await loadConventions(workspaceRoot);
    this.broadcastConventionsStatus(conventions);

    let providerInstance;
    try {
      providerInstance = createProvider({
        cwd: workspaceRoot,
        permissionMode: permMode,
        allowedBashPatterns: bashAllowlist,
        disabledSkills,
        taskType,
        conventions,
        getResumeSessionId: () => this.resumeId,
        setResumeSessionId: (id) => {
          this.resumeId = id;
        },
        token
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: msg });
      return;
    }

    // The CLI provider exposes its own permission UI + handles approvals
    // internally via `--permission-mode`; we just compose the system
    // prompt with the same per-mode / per-task / conventions content the
    // user expects.
    const systemPrompt = buildSystemPrompt({
      workspaceRoot,
      activeFile,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      permissionMode: permMode,
      taskType,
      conventions,
      isClaudeCli: true
    });

    this.maybeShowConventionsBanner(conventions);
    if (permMode === "plan") {
      void this.maybeSuggestSkill(taskType, workspaceRoot);
    }

    this.orchestrator = new Orchestrator(this.session, {
      provider: providerInstance,
      model,
      maxTokens,
      systemPrompt,
      onDelta: (d: StreamDelta) => {
        // Forward stream deltas to the webview verbatim (text, tool_use_*, etc.).
        this.post({ type: "delta", delta: d });
        // Usage deltas are the authoritative token counts reported by the
        // CLI. Re-publish them as a typed `tokenUsage` event so the
        // TokenMeter doesn't need to parse the raw delta envelope.
        if (d.type === "usage" && d.usage) {
          this.post({
            type: "tokenUsage",
            inputTokens: d.usage.inputTokens,
            outputTokens: d.usage.outputTokens,
            cacheReadTokens: d.usage.cacheReadTokens,
            cacheCreatedTokens: d.usage.cacheCreatedTokens,
            costUsd: d.usage.costUsd,
            sessionId: d.usage.sessionId,
            source: "claude-cli",
            rateLimit: d.usage.rateLimit
          });
        }
      }
    });

    this.post({ type: "turnStart" });
    try {
      await this.orchestrator.turn(text);
    } finally {
      this.post({ type: "turnEnd" });
      // Refresh authoritative usage after every turn — Claude Code writes
      // its session JSONL synchronously, so by this point the new tokens
      // are on disk and the aggregator will pick them up.
      void this.broadcastClaudeCodeUsage();
    }
  }

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
    // Mirror to any open artifact editor tabs so they stay in sync with the
    // chat — comment edits, step accepts, plan revisions, etc. all need to
    // appear on both surfaces.
    this.artifacts.broadcast(msg);
  }

  private html(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.joinPath(this.ctx.extensionUri, "webview", "dist");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "main.css"));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com`,
      `connect-src https://fonts.googleapis.com https://fonts.gstatic.com`
    ].join("; ");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>Iridescent</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let n = "";
  for (let i = 0; i < 32; i++) n += chars[Math.floor(Math.random() * chars.length)];
  return n;
}

/** Strip stray slash prefixes and trailing whitespace from a captured selection. */
function cleanSelection(raw: string): string {
  // Drop a leading line that is purely a slash command (e.g. "/explain").
  const lines = raw.split(/\r?\n/);
  if (lines.length && /^\s*\/\S/.test(lines[0]) && !lines[0].includes("//")) {
    lines.shift();
  }
  // Trim trailing blank lines but keep interior whitespace.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

function escapeGlob(s: string): string {
  return s.replace(/[\[\]{}*?!()]/g, "\\$&");
}

// ── Models / skills catalogs ─────────────────────────────────

export type ModelGroup = "alias" | "version";

export interface ModelInfo {
  value: string;
  label: string;
  note: string;
  supportsTools: boolean;
  group: ModelGroup;
}

/**
 * Models surfaced in the picker, sourced from Claude Code's model-config docs.
 *
 * Two groups:
 *  - **alias**   — Claude Code CLI shorthands (`opus`, `sonnet`, `haiku`,
 *                  `opusplan`, `default`). Subscription mode only.
 *  - **version** — pinned IDs the Messages API accepts directly. Includes
 *                  `[1m]` variants for the two models with 1M context.
 *
 * Aliases are a CLI convention (rejected by the raw Messages API), so they're
 * gated to subscription mode. The `[1m]` suffix is also a CLI convention —
 * the Messages API uses the `context-1m-2025-08-07` beta header instead — so
 * those variants only show in subscription mode.
 *
 * Reference: https://code.claude.com/docs/en/model-config
 */
function availableModels(): ModelInfo[] {
  // Subscription (Claude Code CLI). Aliases first (the recommended path),
  // then explicit versions including the two 1M-context variants.
  return [
    { value: "default",  label: "Default",     note: "your plan's recommended model",                supportsTools: true, group: "alias" },
    { value: "opus",     label: "Opus",        note: "latest Opus · complex reasoning",              supportsTools: true, group: "alias" },
    { value: "sonnet",   label: "Sonnet",      note: "latest Sonnet · daily coding",                 supportsTools: true, group: "alias" },
    { value: "haiku",    label: "Haiku",       note: "latest Haiku · simple tasks",                  supportsTools: true, group: "alias" },
    { value: "opusplan", label: "Opus + Plan", note: "Opus while planning, Sonnet while executing",  supportsTools: true, group: "alias" },

    { value: "claude-opus-4-7",        label: "Opus 4.7",        note: "current Opus",      supportsTools: true, group: "version" },
    { value: "claude-opus-4-7[1m]",    label: "Opus 4.7 · 1M",   note: "Opus 4.7 + 1M context window",   supportsTools: true, group: "version" },
    { value: "claude-sonnet-4-6",      label: "Sonnet 4.6",      note: "current Sonnet",    supportsTools: true, group: "version" },
    { value: "claude-sonnet-4-6[1m]",  label: "Sonnet 4.6 · 1M", note: "Sonnet 4.6 + 1M context window", supportsTools: true, group: "version" },
    { value: "claude-haiku-4-5",       label: "Haiku 4.5",       note: "current Haiku",     supportsTools: true, group: "version" }
  ];
}

export interface SkillInfo {
  id: string;
  name: string;
  category: "tool" | "skill" | "integration";
  description: string;
  enabled: boolean;
  toggleable: boolean;
  external?: boolean;
  /** "user" / "project" for filesystem-discovered skills; undefined otherwise. */
  source?: "user" | "project";
}

/**
 * Skills surfaced in the chat composer. Mirrors Claude Code's tool taxonomy
 * plus user-installed skills discovered on disk under ~/.claude/skills/ and
 * <workspace>/.claude/skills/.
 *
 * `disabled` carries the set of skill ids the user has toggled off in the
 * picker — used to flip `enabled: false` so the UI reflects state, even
 * though the toggle is a preference (Claude Code auto-loads skills based
 * on the prompt; we can't actually filter them at the CLI layer).
 */
async function availableSkills(
  workspaceRoot: string | undefined,
  disabled: Set<string>
): Promise<SkillInfo[]> {
  // Capabilities surfaced by Claude Code (CLI). Marked `external` because
  // they execute inside the CLI agent — Iridescent doesn't own them.
  const claudeCode: SkillInfo[] = [
    { id: "Read",       name: "Read",       category: "tool",  description: "Read files in the workspace", enabled: true, toggleable: false, external: true },
    { id: "Write",      name: "Write",      category: "tool",  description: "Create and edit files",       enabled: true, toggleable: false, external: true },
    { id: "Bash",       name: "Bash",       category: "tool",  description: "Run shell commands",          enabled: true, toggleable: false, external: true },
    { id: "Glob",       name: "Glob",       category: "skill", description: "Find files by glob pattern",  enabled: true, toggleable: false, external: true },
    { id: "Grep",       name: "Grep",       category: "skill", description: "Search file contents",        enabled: true, toggleable: false, external: true },
    { id: "Edit",       name: "Edit",       category: "skill", description: "Targeted in-file edits",      enabled: true, toggleable: false, external: true },
    { id: "WebFetch",   name: "WebFetch",   category: "skill", description: "Fetch and read URLs",         enabled: true, toggleable: false, external: true },
    { id: "Task",       name: "Sub-agents", category: "skill", description: "Spawn parallel sub-agents",   enabled: true, toggleable: false, external: true }
  ];

  // User-installed skills from disk. Both `~/.claude/skills/<name>/SKILL.md`
  // and `<ws>/.claude/skills/<name>/SKILL.md` are scanned; failures are
  // swallowed (missing dir, unreadable files, etc.).
  let custom: SkillInfo[] = [];
  try {
    const found = await discoverClaudeSkills(workspaceRoot);
    custom = found.map((s) => ({
      id: s.id,
      name: s.name,
      category: "skill",
      description: s.description,
      enabled: !disabled.has(s.id),
      toggleable: true,
      external: true,
      source: s.source
    }));
  } catch {
    custom = [];
  }

  // Optional integrations (placeholder — not yet wired).
  const integrations: SkillInfo[] = [
    { id: "mcp", name: "MCP Servers", category: "integration", description: "Model Context Protocol servers (configure to enable)", enabled: false, toggleable: false }
  ];

  return [...claudeCode, ...custom, ...integrations];
}
