import { motion } from "framer-motion";
import { send } from "../../lib/rpc";
import { Icon, IconName } from "../../design/icons";
import { Kbd, Orb } from "../../design/primitives";

interface SuggestionItem {
  icon: IconName;
  title: string;
  sub: string;
  prompt: string;
}

interface SuggestionGroup {
  label: string;
  items: SuggestionItem[];
}

const GROUPS: ReadonlyArray<SuggestionGroup> = [
  {
    label: "Understand",
    items: [
      {
        icon: "book",
        title: "Explain this codebase",
        sub: "Walk through architecture and key symbols",
        prompt: "Explain this codebase"
      },
      {
        icon: "search",
        title: "Find and fix a bug",
        sub: "Search for the issue, then patch it",
        prompt: "Find and fix a bug"
      }
    ]
  },
  {
    label: "Build",
    items: [
      {
        icon: "edit",
        title: "Refactor for clarity",
        sub: "Extract helpers, preserve behavior",
        prompt: "Refactor for clarity"
      },
      {
        icon: "bolt",
        title: "Write tests for the selected file",
        sub: "Match existing test patterns",
        prompt: "Write tests for the selected file"
      }
    ]
  }
];

export function EmptyState() {
  return (
    <motion.div
      className="m-auto text-center px-2 pt-4 pb-8 w-full max-w-[480px] flex flex-col items-center"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.38, ease: "easeOut" }}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <Orb size={84} />
      </motion.div>
      <motion.div
        className="text-[24px] font-extrabold tracking-[-0.6px] mb-2 leading-[1.18] text-t1 mt-1"
        initial={{ y: 6, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.08, duration: 0.36, ease: "easeOut" }}
      >
        What are we building?
      </motion.div>
      <motion.div
        className="text-[13px] text-t3 leading-[1.55] mb-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.18, duration: 0.32 }}
      >
        Mention files with <Kbd>@</Kbd> · pick a mode for the kind of help you need
      </motion.div>
      {GROUPS.map((g, gi) => (
        <motion.section
          key={g.label}
          className="w-full mb-4 last:mb-0"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22 + gi * 0.06, duration: 0.32, ease: "easeOut" }}
        >
          <div className="flex items-center gap-2 mb-2.5 px-0.5">
            <span className="inline-flex items-center px-2 py-[2px] rounded-[5px] text-[10px] font-bold tracking-[0.6px] uppercase bg-accent-soft text-accent border border-accent-mid">
              {g.label}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-b2 to-transparent" />
          </div>
          <div className="flex flex-col gap-2">
            {g.items.map((s, si) => (
              <Suggestion key={s.title} item={s} delay={0.3 + gi * 0.06 + si * 0.04} />
            ))}
          </div>
        </motion.section>
      ))}
    </motion.div>
  );
}

function Suggestion({ item, delay }: { item: SuggestionItem; delay: number }) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.28, ease: "easeOut" }}
      className="group relative flex items-center gap-3 px-3.5 py-3 rounded-xl border border-b1 bg-gradient-to-br from-s1 to-s2/40 cursor-pointer text-left font-[inherit] text-t1 transition-[transform,border-color,background,box-shadow] duration-150 hover:border-accent-mid hover:from-accent-soft hover:to-accent-soft/30 hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(211,115,80,0.16)]"
      onClick={() => send({ type: "prompt", text: item.prompt })}
    >
      <span className="w-[32px] h-[32px] rounded-lg inline-flex items-center justify-center flex-shrink-0 bg-s2 text-accent transition-all duration-150 border border-b1 group-hover:bg-accent group-hover:border-accent group-hover:text-on-accent group-hover:shadow-[0_2px_12px_var(--accent-shadow)]">
        <Icon name={item.icon} size={15} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="text-[13px] font-semibold text-t1 block tracking-[-0.1px]">{item.title}</span>
        <span className="text-[11.5px] text-t3 mt-0.5 block leading-[1.4]">{item.sub}</span>
      </span>
      <Icon
        name="arrow"
        size={14}
        className="flex-shrink-0 text-t4 transition-all duration-150 group-hover:text-accent group-hover:translate-x-1"
      />
    </motion.button>
  );
}
