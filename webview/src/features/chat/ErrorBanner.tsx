import { motion } from "framer-motion";

interface ErrorBannerProps {
  text: string;
  onDismiss: () => void;
}

export function ErrorBanner({ text, onDismiss }: ErrorBannerProps) {
  const isRateLimit = /429|rate.?limit/i.test(text);
  const isAuth = /401|403|auth rejected|login/i.test(text);
  const title = isRateLimit ? "Rate limited" : isAuth ? "Authentication failed" : "Error";
  const icon = isRateLimit ? "⏱" : isAuth ? "🔒" : "⚠";

  return (
    <motion.div
      className="bg-err-soft border border-[rgba(248,113,113,0.35)] rounded-[10px] px-[13px] py-[11px] ml-9"
      role="alert"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 mb-[5px]">
        <span className="text-[13px]" aria-hidden>
          {icon}
        </span>
        <span className="font-bold text-err text-[12.5px] flex-1 tracking-[-0.1px]">
          {title}
        </span>
        <button
          type="button"
          className="bg-transparent border-0 text-t3 cursor-pointer text-[18px] leading-none px-1 py-0 hover:text-t1"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <div className="text-[12px] leading-[1.55] text-t2 font-mono whitespace-pre-wrap break-words">
        {text}
      </div>
      {isAuth && (
        <div className="mt-2 text-[11.5px] text-t3 leading-[1.5]">
          Re-authenticate in a terminal: <code className="font-mono text-t1">claude login</code>
        </div>
      )}
    </motion.div>
  );
}
