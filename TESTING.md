# Klaude — Testing Flow & Broken-Functionality Report

This document describes the automated test flow for the Klaude VS Code extension
and lists the functionality that is currently broken, behaving unexpectedly, or
diverging from its documented contract.

## How to run the tests

```bash
npm test          # vitest run — all unit tests (extension host + webview logic)
npm run lint      # tsc --noEmit — typecheck of src/
npm run build     # esbuild bundle + webview vite build
```

CI (`.github/workflows/ci.yml`) runs `lint → test → build` on every push/PR, so
the new tests below now gate merges automatically.

Tests live in:

- `test/unit/**` — extension-host logic (Node). `vscode` is stubbed with
  `vi.mock("vscode", () => ({}))` for modules that import it only for types.
- `test/webview/**` — webview pure logic (no React/DOM). These import
  `webview/src/**` `.ts` files directly; they work because those files use
  `import type` only (erased at runtime). Run by the same root `vitest.config.ts`
  (`include: ["test/**/*.test.ts"]`), so `npm test` covers both.

## Coverage delta from this change

| | Before | After |
|---|---|---|
| Test files | 10 | **25** |
| Tests | 125 | **237** |
| Webview logic covered | none | summary, extract-file-edits, tool-buckets, plan utils, constants, foldPlanState |
| Backend logic newly covered | — | buildArgs allow-list, Session.truncateAt, marketplace path guard, claude-skills frontmatter, MCP storage/catalog/client-parse/naming, usage windowing |

### New test files
`test/webview/{summary,extract-file-edits,tool-buckets,plan-utils,constants,fold-plan-state}.test.ts`,
`test/unit/{buildargs-allowedtools,session,marketplace,claude-skills,mcp-storage,mcp-catalog,mcp-client-parse,mcp-naming,claude-usage}.test.ts`

### Minimal source changes made to enable testing (no behavior change)
- Exported pure helpers: `marketplace.installRoot`, `claude-skills.parseFrontmatter`,
  `mcp/index.slugify` + `cliServerName`, `mcp/client.parseEnvelope`.
- Added an optional `projectsRoot` to `AggregateOptions` in `claude-code-usage.ts`
  so the windowing logic can be exercised against a fixture directory (default
  is unchanged: `~/.claude/projects`).

---

## Broken / unexpected functionality

Severity: **High** = user-visible feature doesn't work / data safety; **Medium**
= wrong or dropped behavior with a workaround or limited blast radius; **Low** =
cosmetic / edge.

### A. Proven by an automated test (`it.fails` reproduces the bug; flip to a normal `it` to see it fail)

| # | Severity | Feature | What happens | Where | Pinned by |
|---|---|---|---|---|---|
| 1 | **High** | **Agent/Auto-mode bash auto-approve** | The default config patterns `^npm (test\|run test)$` and `^git (status\|diff\|log\|branch)$` are translated to `Bash(npm (test\|run test))` etc. The CLI's `--allowedTools` expects a literal/glob prefix, not a regex, so these never match and the agent still prompts for `npm test` / `git status`. The `.replace(/\([^)]+\)/g, (m) => m)` step is a no-op. | `src/providers/claude-cli.ts:288-297` (`regexToCliPattern`) | `test/unit/buildargs-allowedtools.test.ts` |
| 2 | Medium | **Plan card preview** | A plan body that is pure prose with **no** markdown heading renders the preview "Plan body is empty." even though there is real prose. `firstParagraph` only starts collecting after it sees a heading. | `webview/src/features/plan/summary.ts:33-40` | `test/webview/summary.test.ts` |
| 3 | Medium | **Rewind / Edit-from-here history** | `Session.truncateAt` rebuilds the in-memory message history from the timeline but only restores user(text) + assistant(text) entries — `tool_call`/`tool_result` events are dropped, so the assistant's tool context is lost from `messages` after a rewind/edit. (Blast radius limited because `--resume` keeps the CLI's own transcript.) | `src/core/session.ts:131-145` | `test/unit/session.test.ts` |
| 4 | Low | **Path chip rendering** | `compactPath("/a/b/c/d.md")` returns `//…/c/d.md` (doubled leading slash) instead of the documented `/a/…/c/d.md`, because `split("/")` yields a leading empty segment. Workspace paths are absolute, so this is the common case. | `webview/src/features/plan/utils.ts:20-24` | `test/webview/plan-utils.test.ts` |

### B. Confirmed by reading the code + a documenting test (passing tests that capture the current/buggy behavior)

| # | Severity | Feature | What happens | Where | Pinned by |
|---|---|---|---|---|---|
| 5 | Medium | **"Total" usage figure** | `total` is documented as "cumulative since storage began", but any session file older than ~2 weeks (by mtime) is skipped entirely, so old usage never reaches `total`. Also the inline comment says "> 2 weeks old" while the code subtracts only 1 week from the week-cutoff. | `src/services/claude-code-usage.ts:217-221` | `test/unit/claude-usage.test.ts` |
| 6 | ~~Medium~~ **FIXED** | **Add custom MCP connector** | ~~The connector id ignored the URL path, so `/mcp` and `/sse` on the same host collided.~~ Resolved: `deriveConnectorId(name, discriminator)` folds the full URL (or `command + args`) into a short hash, so different paths/commands get distinct ids. | `src/services/mcp/index.ts` (`deriveConnectorId`, `addCustom*`) | `test/unit/mcp-naming.test.ts` |
| 7 | ~~Low–Med~~ **FIXED** | **MCP response parsing** | ~~`parseEnvelope` took no id and returned the *first* `result`/`error` frame, so a multiplexed SSE stream could return the wrong frame.~~ Resolved: `parseEnvelope(res, expectedId)` returns the frame matching the request id (id-less response as fallback), and `rpc()` threads its id through. Also handles multi-line `data:` frames. | `src/services/mcp/client.ts` | `test/unit/mcp-client-parse.test.ts` |
| 8 | Low | **Edited-files diff card** | When a `Write` follows `Edit`s to the same path, the action flips to "Wrote" but the earlier edit hunks remain in `changes`, so the diff card shows stale edit hunks followed by a full-file write. | `webview/src/features/chat/extract-file-edits.ts:97-101` | `test/webview/extract-file-edits.test.ts` |

### C. Found via code audit — high confidence, not yet pinned by an automated test (verify in-app; would need a DOM/component harness or a child-process mock)

| # | Severity | Feature | What happens | Where |
|---|---|---|---|---|
| 9 | **Med–High** | **Rewind of renamed/spaced files** | `listCandidatePaths` does `rawLine.slice(3).trim()` on `git status --porcelain`. A rename line `R  old -> new` becomes the bogus path `"old -> new"`, and quoted paths (spaces/unicode) keep their quotes. So a checkpoint won't capture the real renamed file's pre-state and a rewind can fail to restore it. | `src/services/checkpoint.ts:288-294` |
| 10 | Medium | **Live per-turn token/cost meter** | The backend computes and sends a `tokenUsage` message (input/output/cost from the CLI `result` event), but the webview ignores it unless `m.rateLimit` is present — and subscription/CLI mode never sets `rateLimit`. So live per-turn cost from the CLI is never displayed; the meter relies solely on the jsonl aggregation + a local estimate. | `webview/src/features/chat/TokenMeter.tsx:212` |
| 11 | Low–Med | **Stream delta contract** | The webview's `delta` handler only consumes `text` and `error`; `tool_use_start/input/end`, `model`, `done` are dropped. Also the wire `Delta` type in `rpc.ts` diverges from the `StreamDelta` the host actually forwards (missing `partialInput`/`usage`/`tool_result`). Works today only because tool/model state is also carried by `timeline` events. | `webview/src/App.tsx:162-167`; `webview/src/lib/rpc.ts:141-148` |
| 12 | Medium | **Skills marketplace search** | A late-arriving `loadMore` response (offset > 0) for the *previous* query is appended to the freshly-reset list after the user changes the query — no request-id/generation guard — so search results from two queries can mix. | `webview/src/features/chat/SkillsMarketplace.tsx:72-78, 112-139` |
| 13 | Low | **Cancel** | `cancel()` sends SIGTERM then escalates to SIGKILL after 2s; `onExit` only treats `SIGTERM` as a clean stop, so a process killed by the SIGKILL escalation surfaces a spurious "claude exited with code …" error. | `src/providers/claude-cli.ts:64-69, 122-127` |
| 14 | Low | **MCP turn without connectors** | If `writeCliMcpConfig` throws, the turn runs with no connectors and the user gets no warning (silent `mcpConfig = null`). | `src/ui/panel.ts:~2187` |
| 15 | Low | **Dead wire fields** | `hello`/`reset` are posted with a `sessionId` field that isn't in the `Inbound` type and is never read by the webview. The error-mode half of `tokenUsage` (`source: "anthropic"`, `RateLimitInfo`) is unreachable in the current subscription-only build. | `src/ui/panel.ts:217, 563` |

### MCP parity with Claude Code (added in this change)
Klaude's MCP support now mirrors Claude Code's:
- **stdio / local-command servers** (`command` + `args` + `env`) in addition to remote
  OAuth servers. New `StdioMcpClient` spawns the command and runs the
  initialize → tools/list handshake (`test/unit/mcp-stdio.test.ts`).
- **Imports the user's existing Claude Code servers** from `~/.claude.json`
  (global + per-project) and `<cwd>/.mcp.json`, shown read-only as "Managed by
  Claude Code" (`src/services/mcp/cli-config.ts`, `test/unit/mcp-cli-config.test.ts`).
- **`--mcp-config` bridge** emits `{type:http|sse,url,headers}` for remote and
  `{type:stdio,command,args,env}` for local; managed servers are pre-allowed
  (`mcp__<name>`) but not re-emitted (the CLI loads them itself), so their tools
  don't double-register or trip permission prompts
  (`toCliServerEntry`, `test/unit/mcp-cli-bridge.test.ts`).

These additions were put through an adversarial multi-lens review and hardened:
stdio `env` values are stored in the OS keychain (not plaintext globalState);
imported server names are pre-allowed through the CLI's exact `mcp__<namespace>`
transform (`cliToolNamespace`) so dotted/spaced names aren't gated; remote managed
entries without an explicit `type` are dropped (the CLI rejects them); the stdio
client handles stdin `EPIPE` and defers failure until readline drains so a
response sent just before exit isn't lost; managed servers are excluded from the
"Connected" tab count.

### Notes on things that are NOT broken (verified, locked with tests)
- `marketplace.installRoot` path-traversal guard correctly rejects slashes, `..`, `.`, and empty names (`test/unit/marketplace.test.ts`).
- MCP storage round-trip / dedupe / token keychain behave correctly (`test/unit/mcp-storage.test.ts`).
- Curated MCP catalog has unique ids, all-https URLs, consistent transports (`test/unit/mcp-catalog.test.ts`).
- `buildArgs` MCP pre-allow (`mcp__<server>`) in both auto and default mode works (`test/unit/buildargs-allowedtools.test.ts`).

---

## Recommended next steps for fuller coverage
1. **Component tests** (add `jsdom` + `@testing-library/react` to the webview, or a
   second vitest project) to pin items #10–#12 and the markdown renderer.
2. **A child-process mock for `ClaudeCliProvider.stream`** to cover the spawn/cancel/
   error/timeout lifecycle (#13) end-to-end.
3. **A checkpoint test for renamed/quoted paths** (#9) — drive a real temp git repo,
   `git mv` a file, and assert the candidate path is parsed correctly.
4. **Fix #1 first** — it silently defeats the headline "Agent" auto-approve feature
   for the shipped defaults.
