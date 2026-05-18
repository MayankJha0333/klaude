// ─────────────────────────────────────────────────────────────
// Skills picker. Surfaces every skill the agent has access to:
//   - Built-in tools (Read/Write/Bash) — always on
//   - Claude Code agent (Glob/Grep/Edit/WebFetch/Task) — CLI-native
//   - Project skills (<workspace>/.claude/skills/) — toggleable
//   - User skills (~/.claude/skills/) — toggleable
//   - Integrations (placeholder)
// "Add skills" opens the live Marketplace (claude-plugins.dev),
// which handles real install/uninstall via the extension host.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconName } from "../../design/icons";
import { send, SkillInfo } from "../../lib/rpc";
import { SkillsMarketplace } from "./SkillsMarketplace";

export interface SkillsPickerProps {
  skills: ReadonlyArray<SkillInfo>;
}

export function SkillsPicker({ skills }: SkillsPickerProps) {
  const [open, setOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !marketOpen) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, marketOpen]);

  // The on-disk skill list is the only source of truth now — every entry
  // honors its own `enabled` flag (driven by the disabled-skills set in
  // globalState).
  const totalEnabled = skills.filter((s) => s.enabled).length;
  const totalCount = skills.length;

  const grouped = useMemo(
    () => ({
      tool: skills.filter((s) => s.category === "tool"),
      // CLI-native skills (Glob/Grep/Edit/WebFetch/Task) carry external=true
      // but no `source`. Filesystem-discovered skills (~/.claude/skills,
      // <ws>/.claude/skills) carry `source` so we can split them out.
      cli: skills.filter((s) => s.category === "skill" && !s.source),
      user: skills.filter((s) => s.source === "user"),
      project: skills.filter((s) => s.source === "project"),
      integration: skills.filter((s) => s.category === "integration")
    }),
    [skills]
  );

  // For the marketplace modal: a name → installed-source map built from the
  // skills the extension just discovered on disk. This is the source of
  // truth for scope badges (User vs Project) — the old localStorage `added`
  // list is purely a cosmetic carry-over for marketplace items the user
  // toggled on/off without a real install.
  const installedMap = useMemo(() => {
    const m = new Map<
      string,
      { source: "user" | "project"; displayName: string; description: string }
    >();
    for (const s of skills) {
      if (s.source === "user" || s.source === "project") {
        m.set(s.id, {
          source: s.source,
          displayName: s.name,
          description: s.description
        });
      }
    }
    return m;
  }, [skills]);

  return (
    <>
      <div className="picker skills-picker" ref={ref}>
        <button
          type="button"
          className="cmp-skills"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${totalEnabled} of ${totalCount} skills enabled`}
        >
          <Icon name="bolt" size={11} />
          <span>Skills</span>
          <span className="cmp-skills-count">
            {totalEnabled}/{totalCount}
          </span>
          <Icon name="chevronD" size={9} />
        </button>

        {open && (
          <div className="dropdown dropdown-left dropdown-above skills-dropdown" role="dialog">
            <div className="skills-head">
              <span className="skills-title">Skills</span>
              <span className="skills-sub">
                Tools and capabilities Klaude can use this session.
              </span>
            </div>

            <div className="skills-scroll">
              {grouped.tool.length > 0 && (
                <SkillSection title="Built-in tools">
                  {grouped.tool.map((s) => (
                    <SkillRow key={s.id} skill={s} />
                  ))}
                </SkillSection>
              )}
              {grouped.cli.length > 0 && (
                <SkillSection title="Claude Code agent">
                  {grouped.cli.map((s) => (
                    <SkillRow key={s.id} skill={s} />
                  ))}
                </SkillSection>
              )}
              {grouped.project.length > 0 && (
                <SkillSection title="Project skills">
                  {grouped.project.map((s) => (
                    <DiscoveredRow key={s.id} skill={s} />
                  ))}
                </SkillSection>
              )}
              {grouped.user.length > 0 && (
                <SkillSection title="Your skills">
                  {grouped.user.map((s) => (
                    <DiscoveredRow key={s.id} skill={s} />
                  ))}
                </SkillSection>
              )}
              {grouped.integration.length > 0 && (
                <SkillSection title="Integrations">
                  {grouped.integration.map((s) => (
                    <SkillRow key={s.id} skill={s} />
                  ))}
                </SkillSection>
              )}
            </div>

            <div className="skills-foot">
              <button
                type="button"
                className="skills-add-btn"
                onClick={() => setMarketOpen(true)}
              >
                <Icon name="plus" size={11} />
                Add skills
              </button>
              <span className="skills-foot-hint">{totalEnabled} enabled</span>
            </div>
          </div>
        )}
      </div>

      <SkillsMarketplace
        open={marketOpen}
        installed={installedMap}
        onClose={() => setMarketOpen(false)}
      />
    </>
  );
}

function SkillSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="skills-section">
      <div className="skills-section-title">{title}</div>
      <div className="skills-list">{children}</div>
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillInfo }) {
  const icon = iconFor(skill.id);
  return (
    <div className={`skill-row${skill.enabled ? " enabled" : ""}`}>
      <span className="skill-row-icon">
        <Icon name={icon} size={12} />
      </span>
      <div className="skill-row-body">
        <div className="skill-row-name">
          {skill.name}
          {skill.external && <span className="skill-row-tag">CLI</span>}
        </div>
        <div className="skill-row-desc">{skill.description}</div>
      </div>
      <span className={`skill-row-state${skill.enabled ? " on" : ""}`}>
        {skill.enabled ? <Icon name="check" size={11} /> : <Icon name="x" size={11} />}
      </span>
    </div>
  );
}

/**
 * Filesystem-discovered skill row — Read-only metadata (name, description,
 * source tag) plus a Switch that flips enabled state via the setSkillEnabled
 * RPC. No remove button: the user manages the underlying SKILL.md file
 * outside the extension.
 */
function DiscoveredRow({ skill }: { skill: SkillInfo }) {
  const icon = iconFor(skill.id);
  return (
    <div className={`skill-row toggleable${skill.enabled ? " enabled" : ""}`}>
      <span className="skill-row-icon">
        <Icon name={icon} size={12} />
      </span>
      <div className="skill-row-body">
        <div className="skill-row-name">
          {skill.name}
          {skill.source && (
            <span className="skill-row-tag market">
              {skill.source === "user" ? "User" : "Project"}
            </span>
          )}
        </div>
        <div className="skill-row-desc">{skill.description}</div>
      </div>
      <div className="skill-row-controls">
        <Switch
          checked={skill.enabled}
          onChange={() =>
            send({ type: "setSkillEnabled", id: skill.id, enabled: !skill.enabled })
          }
          label={skill.name}
        />
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Toggle ${label}`}
      className={`switch${checked ? " on" : ""}`}
      onClick={onChange}
    >
      <span className="switch-knob" />
    </button>
  );
}

function iconFor(id: string): IconName {
  switch (id) {
    case "fs_read":
    case "Read":
      return "file";
    case "fs_write":
    case "Write":
    case "Edit":
      return "edit";
    case "bash":
      return "terminal";
    case "Glob":
      return "folder";
    case "Grep":
      return "search";
    case "WebFetch":
      return "cloud";
    case "Task":
      return "layers";
    case "mcp":
      return "git";
    case "github":
    case "git":
      return "branch";
    case "postgres":
      return "layers";
    case "linear":
    case "notion":
      return "book";
    case "slack":
      return "cloud";
    case "playwright":
    case "puppeteer":
      return "eye";
    case "filesystem":
      return "folder";
    case "memory":
      return "book";
    case "brave-search":
      return "search";
    case "figma":
      return "edit";
    default:
      return "code";
  }
}
