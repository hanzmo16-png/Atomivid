/** Podcast 2.0 — QC editorial objetivo. Lo expresivo queda para escucha humana (nunca «indistinguible de humano»). */
import type { DirectionPlan } from "./director";
import { monotonyScore } from "./director";

export type QcFinding = { check: string; ok: boolean; detail: string; objective: boolean };

export function editorialQc(plan: DirectionPlan, opts: { targetMinutes: number; images?: string[]; subtitles?: { speaker: string; text: string }[] }): QcFinding[] {
  const f: QcFinding[] = [];
  const segs = plan.segments, total = segs.reduce((s, x) => s + (x.actual_duration_ms ?? x.estimated_duration_ms), 0);
  const first = segs[0];
  f.push({ check: "intro_larga", ok: (first.actual_duration_ms ?? first.estimated_duration_ms) <= 45_000, detail: `${Math.round((first.actual_duration_ms ?? first.estimated_duration_ms) / 1000)} s`, objective: true });
  const ratio = total / (opts.targetMinutes * 60_000);
  f.push({ check: "duracion_objetivo", ok: ratio >= 0.8 && ratio <= 1.2, detail: `${(total / 60000).toFixed(1)} min vs ${opts.targetMinutes}`, objective: true });
  const mono = monotonyScore(plan);
  f.push({ check: "narracion_uniforme", ok: mono <= 0.6, detail: `emoción dominante ${(mono * 100).toFixed(0)}%`, objective: true });
  const norm = segs.map(s => s.text.toLowerCase().replace(/[^a-záéíóúñ ]/g, "").split(" ").filter(w => w.length > 4));
  let rep = 0;
  for (let i = 0; i < norm.length; i++) for (let j = i + 1; j < norm.length; j++) {
    const a = new Set(norm[i]), inter = norm[j].filter(w => a.has(w)).length;
    if (norm[j].length >= 6 && inter / norm[j].length > 0.7) rep++;
  }
  f.push({ check: "ideas_repetidas", ok: rep === 0, detail: `${rep} pares casi idénticos`, objective: true });
  const pron = segs.flatMap(s => s.text.match(/\b([A-Z]{2,}|\d{4,}|[A-Za-z]+\.[a-z]{2,})\b/g) ?? []).filter(w => !segs.some(s => s.pronunciation.some(p => p.grapheme === w)));
  f.push({ check: "pronunciacion", ok: pron.length === 0, detail: pron.length ? `revisar: ${[...new Set(pron)].slice(0, 8).join(", ")}` : "sin marcas", objective: true });
  const longSil = segs.filter(s => s.pause_before_ms + s.pause_after_ms > 2500);
  f.push({ check: "silencios_accidentales", ok: longSil.length === 0, detail: `${longSil.length} pausas > 2.5 s`, objective: true });
  if (opts.images) { const dup = opts.images.filter((x, i) => i > 0 && x === opts.images![i - 1]).length; f.push({ check: "imagenes_repetidas", ok: dup === 0, detail: `${dup} repeticiones consecutivas`, objective: true }); }
  if (opts.subtitles) { const bad = opts.subtitles.filter((s, i) => s.speaker !== segs[i]?.speaker_id).length; f.push({ check: "subtitulos_hablante", ok: bad === 0, detail: `${bad} subtítulos con hablante incorrecto`, objective: true }); }
  const last = segs[segs.length - 1];
  f.push({ check: "final_abrupto", ok: last.pause_after_ms >= 500 || last.emotion === "reflection", detail: `pausa final ${last.pause_after_ms} ms`, objective: true });
  f.push({ check: "expresividad", ok: true, detail: "REQUIERE ESCUCHA HUMANA: naturalidad, emoción y timbre no se validan automáticamente", objective: false });
  return f;
}
