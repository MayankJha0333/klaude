// ─────────────────────────────────────────────────────────────
// Model picker. Mirrors Claude Code's own model menu — a flat
// "Select a model" list where each row shows the concrete model
// its alias resolves to (e.g. Default → "Opus 4.7 · 1M context"),
// followed by an Effort segmented control and a Thinking toggle.
//
// The catalog comes from the extension via the `models` RPC; the
// resolved versions arrive via `activeModel` messages (the host
// probes each alias against the CLI). Effort + thinking are
// persisted in klaude config and applied to the spawned `claude`
// CLI (`--effort` / `--settings alwaysThinkingEnabled`).
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../design/icons";
import type { ModelInfo, EffortLevel } from "../../lib/rpc";
import { EFFORT_LEVELS, findEffort } from "./constants";

export interface ModelPickerProps {
  models: ReadonlyArray<ModelInfo>;
  value: string;
  /** alias → concrete model id (e.g. `default` → `claude-opus-4-7[1m]`).
   *  Populated as the host resolves each entry; rows fall back to their
   *  static description until their version arrives. */
  resolvedModels?: Record<string, string>;
  onSelect: (id: string) => void;
  effort: EffortLevel;
  onEffort: (level: EffortLevel) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
}

export function ModelPicker({
  models,
  value,
  resolvedModels = {},
  onSelect,
  effort,
  onEffort,
  thinking,
  onThinking
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current =
    models.find((m) => m.value === value) ??
    ({
      value,
      label: shortLabel(value),
      note: "active",
      supportsTools: true,
      group: "alias"
    } satisfies ModelInfo);

  const activeEffort = useMemo(() => findEffort(effort), [effort]);

  // Concrete version for the active selection (drives the trigger + header).
  const currentResolved = resolvedModels[value]
    ? prettyModel(resolvedModels[value])
    : null;

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div className="picker model-picker" ref={ref}>
      <button
        type="button"
        className="cmp-model"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        title={`Model: ${current.label}${
          currentResolved ? ` — ${currentResolved}` : ""
        } · Effort: ${activeEffort.label} · Thinking: ${thinking ? "on" : "off"}`}
      >
        <span className="cmp-model-name">{current.label}</span>
        {thinking && <Icon name="sparkle" size={9} />}
        <Icon name="chevronD" size={9} />
      </button>

      {open && (
        <div
          className="dropdown dropdown-right dropdown-above model-dropdown"
          role="listbox"
        >
          <div className="model-head">
            <span className="model-title">Select a model</span>
            <span className="model-sub">
              {currentResolved ? (
                <>
                  Using{" "}
                  <span className="model-sub-strong">{currentResolved}</span>
                </>
              ) : (
                "Each alias tracks the latest Claude release for your plan."
              )}
            </span>
          </div>

          <div className="model-scroll">
            <div className="model-group-list">
              {models.map((m) => (
                <ModelRow
                  key={m.value}
                  label={m.label}
                  note={m.note}
                  version={
                    resolvedModels[m.value]
                      ? prettyModel(resolvedModels[m.value])
                      : null
                  }
                  recommended={m.value === "default"}
                  selected={m.value === value}
                  onSelect={() => pick(m.value)}
                />
              ))}
            </div>
          </div>

          <div className="model-controls">
            <div className="model-control">
              <div className="model-control-head">
                <span className="model-control-label">Effort</span>
                <span className="model-control-value">{activeEffort.label}</span>
              </div>
              <div
                className="effort-seg"
                role="radiogroup"
                aria-label="Reasoning effort"
              >
                {EFFORT_LEVELS.map((opt, i) => {
                  const activeIdx = EFFORT_LEVELS.findIndex(
                    (e) => e.value === activeEffort.value
                  );
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={opt.value === activeEffort.value}
                      aria-label={opt.label}
                      title={opt.label}
                      className={`effort-cell${i <= activeIdx ? " filled" : ""}${
                        opt.value === activeEffort.value ? " active" : ""
                      }`}
                      onClick={() => onEffort(opt.value)}
                    >
                      <span className="effort-cell-label">{opt.short}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="model-control model-control-row">
              <div className="model-control-head model-control-head-inline">
                <span className="model-control-label">Thinking</span>
                <span className="model-control-note">
                  Reason step-by-step before answering
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={thinking}
                aria-label="Extended thinking"
                className={`kl-switch${thinking ? " on" : ""}`}
                onClick={() => onThinking(!thinking)}
              >
                <span className="kl-switch-knob" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRow({
  label,
  note,
  version,
  recommended,
  selected,
  onSelect
}: {
  label: string;
  note?: string;
  version?: string | null;
  recommended?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`model-row${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <span className="model-row-body">
        <span className="model-row-head">
          <span className="model-row-label">{label}</span>
          {recommended && <span className="model-row-tag">Recommended</span>}
        </span>
        {version ? (
          <span className="model-row-version">{version}</span>
        ) : (
          <span className="model-row-version model-row-version-pending">
            Resolving…
          </span>
        )}
        {note && <span className="model-row-note">{note}</span>}
      </span>
      {selected && (
        <span className="model-row-check" aria-hidden>
          <Icon name="check" size={15} />
        </span>
      )}
    </button>
  );
}

/** `claude-opus-4-7` → `opus-4-7` (used for unknown / freeform ids). */
function shortLabel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

/**
 * Format a concrete model id into a friendly version label:
 *   claude-opus-4-7[1m]  → "Opus 4.7 · 1M context"
 *   claude-sonnet-4-6    → "Sonnet 4.6"
 * Falls back to the stripped id for unrecognised shapes.
 */
function prettyModel(id: string): string {
  const has1m = /\[1m\]/i.test(id);
  const stripped = id
    .replace(/^claude-/, "")
    .replace(/\[1m\]/i, "")
    .replace(/-\d{8}$/, "");
  const m = stripped.match(/^([a-z]+)-?(.*)$/i);
  let label = stripped;
  if (m && /[a-z]/i.test(m[1])) {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[2].replace(/-/g, ".");
    label = ver ? `${tier} ${ver}` : tier;
  }
  return has1m ? `${label} · 1M context` : label;
}
