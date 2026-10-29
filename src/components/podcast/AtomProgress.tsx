"use client";

import { useState } from "react";
import { ago, stageMessage, type ProgressView } from "@/lib/podcast/v3/progress";

/**
 * Avance de la producción con la identidad del átomo: la órbita exterior se completa con el porcentaje (que sale del
 * trabajo terminado, estimación por etapas) y las órbitas del símbolo giran mientras hay actividad. Distingue espera,
 * procesando, sin información y error; nunca muestra 100 % antes de que el episodio esté guardado («listo»).
 */
export function AtomProgress({ view: input, compact = false, now }: { view: ProgressView; compact?: boolean; now?: number }) {
  // La barra nunca retrocede mientras la página está abierta (un informe tardío o una consulta vieja no la bajan).
  // (Patrón de React para recordar un valor anterior: actualizar el estado durante el render, sin efectos.)
  const [peak, setPeak] = useState(0);
  const pct = input.state === "listo" ? 100 : input.state === "espera" ? 0 : Math.min(99, Math.max(peak, input.pct));
  if (input.state !== "espera" && pct !== peak) setPeak(pct);
  const view = { ...input, pct };
  const size = compact ? 96 : 168;
  const r = 44, c = 2 * Math.PI * r;
  const tone = view.state === "error" ? "var(--color-danger)" : view.state === "sin_informacion" ? "var(--color-warning)" : view.state === "listo" ? "var(--color-success)" : "var(--color-accent)";
  const message = view.state === "procesando" ? stageMessage(view.stage) : null;
  const last = ago(view.lastActivityAt, now);
  const latest = view.recent[view.recent.length - 1];
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 text-center sm:flex-row sm:items-center sm:text-left" role="status" aria-live="polite" data-testid="atom-progress" data-state={view.state}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-border-strong)" strokeWidth="3" />
          <circle cx="50" cy="50" r={r} fill="none" stroke={tone} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(view.pct / 100) * c} ${c}`} transform="rotate(-90 50 50)" style={{ transition: "stroke-dasharray 0.8s ease" }} />
          <g className={view.active ? "animate-atom-spin" : undefined} style={{ transformBox: "fill-box" }}>
            <g transform="translate(50 50) scale(1.55) translate(-12 -12)" stroke={tone} strokeWidth="0.9" fill="none" strokeLinecap="round" opacity="0.85">
              <ellipse cx="12" cy="12" rx="10" ry="4.1" />
              <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
              <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
            </g>
          </g>
          <circle cx="50" cy="50" r="4" fill={tone} className={view.active ? "animate-atom-pulse" : undefined} />
        </svg>
        <span className={`absolute inset-x-0 bottom-1 font-semibold tabular-nums text-ink ${compact ? "text-base" : "text-2xl"}`} data-testid="atom-progress-pct">{view.pct}%</span>
      </div>
      <div className="min-w-0 max-w-full">
        <p className={`font-semibold text-ink ${compact ? "text-sm" : "text-base"}`}>{view.title}</p>
        <p className="text-sm text-ink" data-testid="atom-progress-stage">
          {view.state === "espera" ? "En espera" : view.state === "listo" ? "Listo: guardado y disponible" : `Etapa: ${view.stageLabel}`}{view.detail ? ` · ${view.detail}` : ""}
        </p>
        {view.state === "sin_informacion" && <p className="text-xs text-warning" data-testid="atom-progress-stale">El procesador no envía señales{last ? ` (${last})` : ""}. Lo ya hecho está guardado y no se vuelve a cobrar.</p>}
        {message && <p className="text-xs text-ink-muted">{message}</p>}
        {(view.state === "procesando" || view.state === "sin_informacion") && last && (
          <p className="text-xs text-ink-muted" data-testid="atom-progress-activity">Última actividad {last}{latest ? `: ${latest.text}` : ""}</p>
        )}
        {!compact && view.state !== "listo" && view.state !== "error" && view.state !== "espera" && (
          <ol className="mt-2 grid min-w-0 grid-cols-2 gap-1 text-[11px] sm:flex sm:flex-wrap" aria-label="Etapas" data-testid="atom-progress-stages">
            {view.stages.map((r) => (
              <li key={r.stage} data-stage={r.stage} data-state={r.state} className={`min-w-0 truncate rounded px-1.5 py-0.5 ${r.state === "hecha" ? "bg-surface text-ink-muted" : r.state === "activa" ? "bg-accent-soft text-ink" : "text-ink-faint"}`}>
                {r.state === "hecha" ? "✓ " : ""}{r.label}{r.done != null ? ` ${r.total != null ? `${r.done}/${r.total}` : r.done}` : ""}
              </li>
            ))}
          </ol>
        )}
        {!compact && view.recent.length > 1 && (view.state === "procesando" || view.state === "sin_informacion") && (
          <details className="mt-1 text-[11px] text-ink-muted"><summary className="cursor-pointer">Actividad reciente</summary>
            <ul data-testid="atom-progress-recent">{[...view.recent].reverse().map((a) => <li key={`${a.at}${a.text}`}>{ago(a.at, now)} · {a.text}</li>)}</ul>
          </details>
        )}
        {view.state !== "listo" && <p className="mt-1 text-[11px] text-ink-faint">Porcentaje estimado por etapas a partir del trabajo terminado.</p>}
      </div>
    </div>
  );
}
