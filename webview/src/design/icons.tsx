// ─────────────────────────────────────────────────────────────
// Icon registry — the Forge icon set as a single typed component.
// Each icon is a 20×20 path drawn with stroke + currentColor so
// it inherits text color from the parent.
// ─────────────────────────────────────────────────────────────

import { CSSProperties } from "react";

export const ICON_PATHS = {
  sparkle: "M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8L10 2z",
  send: "M3 10l14-7-7 14-2-6-5-1z",
  plus: "M10 4v12M4 10h12",
  check: "M4 10l4 4 8-8",
  x: "M5 5l10 10M15 5L5 15",
  chevronR: "M7 4l6 6-6 6",
  chevronD: "M4 7l6 6 6-6",
  chevronL: "M13 4l-6 6 6 6",
  chevronU: "M4 13l6-6 6 6",
  file: "M5 3h6l4 4v10H5V3z M11 3v4h4",
  folder: "M3 5h5l2 2h7v9H3V5z",
  search: "M9 3a6 6 0 104.47 10.03l3.5 3.5 1-1-3.5-3.5A6 6 0 009 3z",
  terminal: "M3 4h14v12H3zM5 8l3 2-3 2 M10 12h4",
  branch: "M6 3v14 M14 5v4a3 3 0 01-3 3H6 M6 5a2 2 0 100-4 2 2 0 000 4z M14 5a2 2 0 100-4 2 2 0 000 4z",
  edit: "M4 14l-1 3 3-1L16 5l-2-2L4 14z",
  code: "M7 6l-4 4 4 4 M13 6l4 4-4 4",
  at: "M10 3a7 7 0 00-7 7 7 7 0 007 7h2 M10 13a3 3 0 110-6 3 3 0 010 6z M13 10v1a2 2 0 004 0v-1",
  attach: "M14 8l-6 6a3 3 0 11-4-4l7-7a2 2 0 113 3l-7 7a1 1 0 11-1-1l5-5",
  dots: "M5 10a1 1 0 102 0 1 1 0 00-2 0zM9 10a1 1 0 102 0 1 1 0 00-2 0zM13 10a1 1 0 102 0 1 1 0 00-2 0z",
  history: "M10 4a6 6 0 106 6 M10 1v3l2 1 M4 4l2 2",
  bolt: "M11 2l-6 9h4l-1 7 6-9h-4l1-7z",
  shield: "M10 2l6 2v5a8 8 0 01-6 8 8 8 0 01-6-8V4l6-2z",
  shieldOff: "M10 2l6 2v5a8 8 0 01-2.6 5.9 M3 3l14 14 M4 5v4a8 8 0 006 8",
  layers: "M10 2L2 6l8 4 8-4-8-4z M2 10l8 4 8-4 M2 14l8 4 8-4",
  book: "M3 4h6a2 2 0 012 2v11 M17 4h-6a2 2 0 00-2 2v11 M3 4v13h14V4",
  arrow: "M3 10h13 M11 5l5 5-5 5",
  play: "M6 4l10 6-10 6V4z",
  stop: "M5 5h10v10H5z",
  cloud: "M6 14h9a3 3 0 000-6 5 5 0 00-9-1 3 3 0 00-1 6",
  lock: "M5 9h10v8H5z M7 9V6a3 3 0 016 0v3",
  eye: "M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z M10 13a3 3 0 100-6 3 3 0 000 6z",
  copy: "M7 7h9v10H7zM4 4h9v3",
  user: "M10 10a3 3 0 100-6 3 3 0 000 6zM4 17c1-3 3.5-4 6-4s5 1 6 4",
  settings: "M10 13a3 3 0 100-6 3 3 0 000 6z M10 1v2 M10 17v2 M3.5 3.5l1.4 1.4 M15.1 15.1l1.4 1.4 M1 10h2 M17 10h2 M3.5 16.5l1.4-1.4 M15.1 4.9l1.4-1.4",
  zap: "M13 2l-3 7h5l-6 9 2-7H6l7-9z",
  git: "M15 12a3 3 0 11-5 2L7 11a3 3 0 110-4l3 3a3 3 0 015 2z",
  refresh: "M3 10a7 7 0 0112-5l2 2 M17 4v4h-4 M17 10a7 7 0 01-12 5l-2-2 M3 16v-4h4",
  logout: "M9 18H5a2 2 0 01-2-2V4a2 2 0 012-2h4 M16 14l4-4-4-4 M20 10H9",
  plug: "M7 2v4 M13 2v4 M5 6h10v4a5 5 0 01-10 0V6z M10 15v3"
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function Icon({ name, size = 14, strokeWidth = 1.6, className, style, title }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
