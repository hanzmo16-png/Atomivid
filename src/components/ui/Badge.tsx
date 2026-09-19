import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-surface-raised text-ink-muted border border-border-strong",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
};

// Punto de color a juego con cada tono — puramente decorativo, nunca la
// única señal de estado (el texto del badge siempre acompaña).
const DOT_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-ink-faint",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}
