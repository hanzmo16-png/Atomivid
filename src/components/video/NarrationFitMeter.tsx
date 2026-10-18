"use client";

import { Alert } from "@/components/ui/Alert";
import { fitForDuration, fitForMaximum, formatRange, MAX_NARRATION_CHARS, narrationStats, recommendedCapacity, type NarrationLanguage } from "@/lib/video/narration-fit";

/**
 * Live counter for an own script (Reel) or avatar text. Pure computation with narration-fit.ts — the very
 * functions the server enforces — so the screen never counts one way and the server validates another.
 * It changes nothing: the customer shortens the text, picks a compatible duration, or asks for an AI
 * adaptation (with its cost shown first).
 */
export function NarrationFitMeter({ text, language, mode, targetSeconds, offeredDurations, maxSeconds, onSelectDuration }: {
  text: string;
  language: NarrationLanguage;
  mode: "visual" | "avatar";
  targetSeconds?: number;
  offeredDurations?: number[];
  /** Avatar: hard maximum instead of a target. */
  maxSeconds?: number;
  onSelectDuration?: (seconds: number) => void;
}) {
  const stats = narrationStats(text, language, mode);
  const fit = maxSeconds !== undefined ? fitForMaximum(stats, maxSeconds) : fitForDuration(stats, targetSeconds ?? 30, offeredDurations ?? [30, 60, 90]);
  const capacity = targetSeconds !== undefined && maxSeconds === undefined ? recommendedCapacity(targetSeconds, language) : null;
  const tone = !stats.text ? "info" : fit.verdict === "compatible" ? "success" : fit.verdict === "borderline" ? "warning" : "danger";
  // Durations this text can start with (comfortable first), offered as one-click choices; never applied automatically.
  const offered = offeredDurations ?? [30, 60, 90];
  const viable = maxSeconds !== undefined || fit.verdict === "compatible" ? [] : offered.filter(d => d !== targetSeconds && fitForDuration(stats, d, offered).allowed);
  const alternatives = fit.compatibleDurations.filter(d => viable.includes(d)).concat(viable.filter(d => !fit.compatibleDurations.includes(d)));

  return (
    <div className="mt-2 space-y-2" data-testid="narration-fit" data-verdict={fit.verdict}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-muted sm:grid-cols-4">
        <div><dt>Caracteres</dt><dd className="tabular-nums text-ink">{stats.chars} / {MAX_NARRATION_CHARS}</dd></div>
        <div><dt>Palabras</dt><dd className="tabular-nums text-ink">{stats.words}</dd></div>
        <div><dt>Duración estimada</dt><dd className="tabular-nums text-ink">{stats.text ? `≈ ${formatRange(stats.estimate)} s` : "—"}</dd></div>
        {capacity ? (
          <div><dt>Recomendado para {targetSeconds} s</dt><dd className="tabular-nums text-ink">{capacity.minWords}–{capacity.maxWords} palabras (≈ {capacity.approxMinChars}–{capacity.approxMaxChars} caracteres)</dd></div>
        ) : maxSeconds !== undefined ? (
          <div><dt>Límite de Avatar</dt><dd className="tabular-nums text-ink">{maxSeconds} s</dd></div>
        ) : null}
      </dl>
      {stats.text && (
        <Alert tone={tone}>
          <p>{fit.message}</p>
          {alternatives.length > 0 && onSelectDuration && (
            <div className="mt-2 flex flex-wrap gap-2">
              {alternatives.map(d => (
                <button key={d} type="button" onClick={() => onSelectDuration(d)}
                  className="rounded-md border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-raised">
                  Usar {d} segundos
                </button>
              ))}
            </div>
          )}
        </Alert>
      )}
      <p className="text-xs text-ink-faint">
        Estimación por palabras habladas (los números y símbolos cuentan como se pronuncian). No es una equivalencia exacta: la duración real se confirma al generar el audio.
      </p>
    </div>
  );
}
