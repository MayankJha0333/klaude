# Klaude

Agentic AI coding assistant for VS Code. Inspired by Claude Code. Side-panel chat, inline diff previews, multi-file edits, terminal execution, permission modes. BYOK (Anthropic today; OpenAI/Ollama adapters pluggable).

Design doc: `~/.claude/plans/design-and-architect-a-klaude-planet.md`.

## Status

MVP scaffold (P0). Working: chat panel, streaming, fs_read / fs_write (with diff preview) / bash tools, permission modes (default / plan / auto), destructive-action guards, protected-path blocks, inline-edit / explain / refactor / fix-bug commands, @-mention file picker, Cmd+L send-selection, dynamic model list per provider, attachments, skills overview.

Not yet: embeddings indexer, tree-sitter symbol mentions, checkpoints timeline UI, MCP client, subagents, hooks, memory. See plan for roadmap.

## Install (dev)

```bash
cd klaude
npm install
(cd webview && npm install)
npm run build
```

Then in VS Code: **Run → Start Debugging** (or F5) with this folder open. An Extension Development Host launches with Klaude active.

## First run

1. Command palette → **Klaude: Set API Key** → pick `anthropic` → paste key.
2. Open any folder (workspace required).
3. Click the Klaude icon in the activity bar.
4. Type a prompt, `Cmd/Ctrl+Enter` to send.

Set model in settings (`klaude.model`, default `claude-opus-4-7`).

## Permission modes

Cycle with `Shift+Tab` (when chat focused) or `Klaude: Cycle Permission Mode`.

| Mode | Behavior |
|---|---|
| default | Every tool call prompts for approval. |
| plan | Agent reasons only — no tool execution. |
| auto | Allowlist: `fs_read` auto-approved; `bash` matching `klaude.allowedBashPatterns` auto-approved; everything else prompts. |

Protected paths (`.git`, `.env*`, `.ssh`, shell rc) always prompt regardless of mode.

## Commands

- `Klaude: New Chat`
- `Klaude: Toggle Chat Panel` — `Cmd/Ctrl+Shift+I`
- `Klaude: Inline Edit` — `Cmd/Ctrl+I` (prompts for instruction, pre-fills selection)
- `Klaude: Explain Selection`
- `Klaude: Refactor Selection`
- `Klaude: Fix Bug`
- `Klaude: Set API Key`
- `Klaude: Cycle Permission Mode`

## Architecture

```
extension.ts → ChatPanelProvider (webview host)
                 ↕ postMessage
              React webview (chat UI)
                 ↕
              Orchestrator (tool loop FSM)
                 ├─ ChatProvider (Anthropic streaming)
                 ├─ Tools: fs_read, fs_write, bash
                 └─ PermissionGate + Approver
```

Core (`src/core/*`) imports zero VS Code APIs — testable standalone. UI / services glue it to the editor.

## Tests

```bash
npm test
```

## Package

```bash
npm run package    # produces klaude-0.1.0.vsix
```

## License

MIT
