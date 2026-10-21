/**
 * Control técnico audiovisual reutilizable (sin proveedores, USD 0). Separa la MEDICIÓN (ffprobe/ffmpeg, en
 * scripts/av-qc.ts) de la DECISIÓN (este módulo, puro y probado): mismas reglas para Reel, Long Form o Podcast.
 *
 * Reutiliza: el objetivo de sonoridad del producto (audio-master.ts LOUDNESS_TARGET) y los detectores de
 * scripts/delivery/qa.mjs (blackdetect/freezedetect/silencedetect/ebur128), ampliados con decodificación completa,
 * coherencia A/V, subtítulos y el manifiesto del montaje.
 *
 * Bloqueante = el archivo no debe entregarse así. Aviso = requiere revisión humana. No juzga relevancia histórica,
 * narrativa ni estética: eso queda SIEMPRE en revisión humana (ver AV_QC_LIMITS).
 */
import { LOUDNESS_TARGET } from "@/lib/video/audio-master";

export type AvManifestSegment = {
  id: string;
  start: number;
  end: number;
  kind?: string;
  file?: string;
  sha256?: string;
  /** "pending" = tarjeta/material pendiente: nunca debe llegar a un archivo entregado. */
  status?: "ready" | "pending";
  /** Negro/congelado/silencio previsto en este tramo (fundido, pausa dramática, tarjeta fija). */
  intentional?: ("black" | "freeze" | "silence")[];
};

export type AvManifest = {
  version?: 1;
  expected?: {
    width?: number; height?: number; durationSeconds?: number; durationTolerancePct?: number;
    videoCodec?: string; audioCodec?: string; requireAudio?: boolean;
  };
  loudness?: { integratedLufs?: number; toleranceLu?: number; truePeakDbtp?: number };
  subtitles?: string;
  timeline?: AvManifestSegment[];
  files?: { path: string; sha256?: string; role?: string }[];
  /** Segment ids whose shared file identity is intended (e.g. a recurring map). */
  allowRepeats?: string[];
};

export type AvMeasurements = {
  probeOk: boolean;
  width?: number; height?: number; videoCodec?: string; audioCodec?: string; pixFmt?: string; fps?: number;
  formatDuration?: number; videoDuration?: number; audioDuration?: number; hasAudio: boolean;
  decodeErrors: string[];
  /** Errors from the detector/loudness pass. A failed pass must never look like zero findings. */
  detectorErrors: string[];
  black: [number, number][];
  freeze: [number, number][];
  silence: [number, number][];
  integratedLufs?: number; lra?: number; truePeakDbfs?: number; samplePeakDb?: number; meanVolumeDb?: number;
  subtitles?: { start: number; end: number; text: string }[] | null;
  subtitleParseError?: string;
  /** Manifest files that are missing on disk or whose sha256 does not match. */
  missingFiles: string[];
  hashMismatches: string[];
  /** sha256 actually read per segment file (identity for repeats). */
  segmentHashes: Record<string, string>;
};

export type AvFinding = { severity: "blocking" | "warning"; code: string; message: string; at?: number[] };
export type AvReport = {
  verdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL";
  blocking: AvFinding[]; warnings: AvFinding[];
  measured: Omit<AvMeasurements, "subtitles"> & { subtitleCount: number | null };
  limits: string[];
};

export const AV_QC_LIMITS = [
  "No evalúa relevancia histórica, veracidad, narrativa, ritmo editorial ni estética: requieren revisión humana.",
  "La correspondencia narración-imagen solo se comprueba por tiempos del manifiesto, no por contenido.",
  "Negro/congelado/silencio se detectan con umbrales (ffmpeg blackdetect pix_th=0.10 ≥2 s; freezedetect -60 dB ≥2.5 s; silencedetect -50 dB ≥2 s); un plano casi estático puede marcarse como congelado.",
  "La repetición de material se detecta por identidad de archivo (sha256), no por similitud visual: un recorte o re-encode del mismo plano no se detecta aquí.",
  "La sonoridad se compara con el perfil del producto (audio-master.ts); una plataforma concreta puede normalizar distinto.",
  "Los subtítulos solo se validan si se entregan como archivo (SRT/VTT); subtítulos quemados en la imagen no se leen.",
];

const DEF = { durationTolerancePct: 10, toleranceLu: 2 };
const overlap = (a: [number, number], s: AvManifestSegment) => a[0] < s.end && a[1] > s.start;

/** Interval [a,b] is acceptable if fully covered by segments marked intentional for that kind. */
function intentional(iv: [number, number], kind: "black" | "freeze" | "silence", tl: AvManifestSegment[]): boolean {
  const segs = tl.filter((s) => overlap(iv, s));
  if (!segs.length) return false;
  // Fades at the very start/end shorter than 2.5 s are a normal opening/closing.
  return segs.every((s) => s.intentional?.includes(kind));
}

export function evaluateAv(m: AvMeasurements, manifest: AvManifest = {}): AvReport {
  const blocking: AvFinding[] = [], warnings: AvFinding[] = [];
  const B = (code: string, message: string, at?: number[]) => blocking.push({ severity: "blocking", code, message, at });
  const W = (code: string, message: string, at?: number[]) => warnings.push({ severity: "warning", code, message, at });
  const ex = manifest.expected ?? {};
  const tl = [...(manifest.timeline ?? [])].sort((a, b) => a.start - b.start);
  const dur = m.formatDuration ?? m.videoDuration ?? 0;

  if (!m.probeOk) B("probe_failed", "ffprobe no pudo leer el archivo como video.");
  if (!Number.isFinite(dur) || dur <= 0) B("duration_unreadable", "No se pudo medir una duración positiva y finita del video.");
  if (ex.width && ex.height && (m.width !== ex.width || m.height !== ex.height)) B("resolution", `Resolución ${m.width}x${m.height}; se esperaba ${ex.width}x${ex.height}.`);
  if (ex.width && ex.height && m.width && m.height && Math.abs(m.width / m.height - ex.width / ex.height) > 0.01) B("aspect", `Relación de aspecto ${(m.width / m.height).toFixed(3)}; se esperaba ${(ex.width / ex.height).toFixed(3)}.`);
  if (ex.videoCodec && m.videoCodec && m.videoCodec !== ex.videoCodec) B("video_codec", `Códec de video ${m.videoCodec}; se esperaba ${ex.videoCodec}.`);
  if (m.pixFmt && !/^yuv420p$/.test(m.pixFmt)) W("pix_fmt", `Formato de píxel ${m.pixFmt}; yuv420p es el más compatible para YouTube/móvil.`);
  if (ex.durationSeconds) {
    const tol = (ex.durationTolerancePct ?? DEF.durationTolerancePct) / 100, d = (dur - ex.durationSeconds) / ex.durationSeconds;
    if (Math.abs(d) > tol) B("duration", `Duración real ${dur.toFixed(1)} s vs pedida ${ex.durationSeconds} s (${(d * 100).toFixed(1)} %, tolerancia ±${(tol * 100).toFixed(0)} %).`);
    else if (Math.abs(d) > tol / 2) W("duration_drift", `Duración real ${dur.toFixed(1)} s se aparta ${(d * 100).toFixed(1)} % de la pedida.`);
  }
  if (m.decodeErrors.length) B("decode", `La decodificación completa reportó ${m.decodeErrors.length} error(es): ${m.decodeErrors.slice(0, 3).join(" | ").slice(0, 300)}`);
  if (m.detectorErrors.length) B("detector_failed", `El pase de detectores/sonoridad falló: ${m.detectorErrors.slice(0, 3).join(" | ").slice(0, 300)}`);

  const requireAudio = ex.requireAudio ?? true;
  if (!m.hasAudio) { if (requireAudio) B("no_audio", "El archivo no tiene pista de audio."); }
  else {
    if (ex.audioCodec && m.audioCodec && m.audioCodec !== ex.audioCodec) B("audio_codec", `Códec de audio ${m.audioCodec}; se esperaba ${ex.audioCodec}.`);
    if (m.meanVolumeDb !== undefined && m.meanVolumeDb < -60) B("silent_audio", `La pista de audio es prácticamente silencio (volumen medio ${m.meanVolumeDb} dB).`);
    if (m.videoDuration && m.audioDuration && Math.abs(m.videoDuration - m.audioDuration) > 0.5)
      B("av_length", `Audio ${m.audioDuration.toFixed(2)} s vs video ${m.videoDuration.toFixed(2)} s (diferencia > 0,5 s): final cortado o cola muda.`);
    const target = manifest.loudness?.integratedLufs ?? LOUDNESS_TARGET.INTEGRATED_LUFS, tolLu = manifest.loudness?.toleranceLu ?? DEF.toleranceLu;
    const tp = manifest.loudness?.truePeakDbtp ?? LOUDNESS_TARGET.TRUE_PEAK_DBTP;
    if (m.integratedLufs !== undefined && Number.isFinite(m.integratedLufs) && Math.abs(m.integratedLufs - target) > tolLu)
      W("loudness", `Sonoridad integrada ${m.integratedLufs} LUFS; perfil del producto ${target} ±${tolLu} LU.`);
    if (m.truePeakDbfs !== undefined && m.truePeakDbfs > tp + 0.5) W("true_peak", `Pico real ${m.truePeakDbfs} dBFS supera el máximo ${tp} dBTP.`);
    if (m.samplePeakDb !== undefined && m.samplePeakDb >= -0.1) B("clipping", `Pico de muestra ${m.samplePeakDb} dBFS: saturación digital (clipping).`);
    for (const s of m.silence) {
      const len = s[1] - s[0]; if (intentional(s, "silence", tl)) continue;
      const edge = s[0] < 0.5 || s[1] > dur - 0.5;
      if (len >= 6 && !edge) B("silence", `Silencio de ${len.toFixed(1)} s no previsto en mitad del video.`, s);
      else if (len >= 2 && !(edge && len < 4)) W("silence", `Silencio de ${len.toFixed(1)} s no marcado como intencional.`, s);
    }
  }
  for (const s of m.black) {
    const len = s[1] - s[0]; if (intentional(s, "black", tl)) continue;
    const edge = s[0] < 0.5 || s[1] > dur - 0.5;
    if (edge && len < 2.5) continue;
    if (len >= 2) B("black", `Negro de ${len.toFixed(1)} s no previsto.`, s); else W("black", `Negro de ${len.toFixed(1)} s.`, s);
  }
  for (const s of m.freeze) {
    const len = s[1] - s[0]; if (intentional(s, "freeze", tl)) continue;
    if (len >= 8) B("freeze", `Imagen congelada ${len.toFixed(1)} s no prevista.`, s); else W("freeze", `Imagen fija ${len.toFixed(1)} s (¿plano estático intencional?).`, s);
  }

  // Subtitles
  if (manifest.subtitles) {
    if (m.subtitleParseError || !m.subtitles) B("subtitles_unreadable", `Subtítulos ilegibles: ${m.subtitleParseError ?? "sin cues"}.`);
    else {
      if (!m.subtitles.length) B("subtitles_empty", "El archivo de subtítulos no tiene cues.");
      const beyond = m.subtitles.filter((c) => c.start >= dur + 0.05);
      if (beyond.length) B("subtitles_beyond", `${beyond.length} subtítulo(s) empiezan después del final del video.`, [beyond[0].start]);
      const cut = m.subtitles.filter((c) => c.start < dur && c.end > dur + 0.5);
      if (cut.length) B("subtitles_cut", `Un subtítulo queda cortado por el final del video (${cut[0].start.toFixed(2)}–${cut[0].end.toFixed(2)} s, video ${dur.toFixed(2)} s).`);
      const bad = m.subtitles.filter((c) => !(c.end > c.start));
      if (bad.length) B("subtitles_inverted", `${bad.length} subtítulo(s) con fin ≤ inicio.`);
      let ov = 0; let first: number | undefined;
      for (let i = 1; i < m.subtitles.length; i++) if (m.subtitles[i].start < m.subtitles[i - 1].end - 0.05) { ov++; first ??= m.subtitles[i].start; }
      if (ov) W("subtitles_overlap", `${ov} subtítulo(s) se superponen con el anterior.`, first !== undefined ? [first] : undefined);
      const lastEnd = Math.max(...m.subtitles.map((c) => c.end));
      if (dur - lastEnd > 30) W("subtitles_short", `Los subtítulos terminan ${(dur - lastEnd).toFixed(0)} s antes del final del video.`);
    }
  }

  // Manifest / montage
  for (const f of m.missingFiles) B("missing_file", `Falta el archivo del manifiesto: ${f}.`);
  for (const f of m.hashMismatches) B("hash_mismatch", `El archivo no coincide con su sha256 del manifiesto: ${f}.`);
  const pending = tl.filter((s) => s.status === "pending");
  if (pending.length) B("pending_material", `${pending.length} tramo(s) con material/tarjeta pendiente (${pending.slice(0, 5).map((s) => s.id).join(", ")}).`);
  if (tl.length) {
    if (tl[0].start > 0.1) B("gap", `Hueco al inicio del montaje (0–${tl[0].start.toFixed(2)} s).`, [0, tl[0].start]);
    for (let i = 1; i < tl.length; i++) {
      const g = tl[i].start - tl[i - 1].end;
      if (g > 0.1) B("gap", `Hueco de ${g.toFixed(2)} s en el montaje entre ${tl[i - 1].id} y ${tl[i].id}.`, [tl[i - 1].end, tl[i].start]);
    }
    const tlEnd = Math.max(...tl.map((s) => s.end));
    if (dur && tlEnd < dur - 1.0) B("timeline_short", `El montaje cubre hasta ${tlEnd.toFixed(1)} s pero el video dura ${dur.toFixed(1)} s.`);
    if (dur && tlEnd > dur + 1.0) B("ending_cut", `El montaje previsto termina en ${tlEnd.toFixed(1)} s pero el video dura ${dur.toFixed(1)} s: final cortado.`);
    const byHash = new Map<string, string[]>();
    for (const s of tl) { const h = m.segmentHashes[s.id] ?? s.sha256; if (!h) continue; byHash.set(h, [...(byHash.get(h) ?? []), s.id]); }
    const allow = new Set(manifest.allowRepeats ?? []);
    for (const [h, ids] of byHash) if (ids.length > 1 && !ids.every((id) => allow.has(id)))
      W("repeated_material", `Mismo archivo (sha256 ${h.slice(0, 12)}…) en ${ids.length} tramos: ${ids.slice(0, 6).join(", ")}.`);
  }

  const { subtitles, ...rest } = m;
  return { verdict: blocking.length ? "FAIL" : warnings.length ? "PASS_WITH_WARNINGS" : "PASS", blocking, warnings,
    measured: { ...rest, subtitleCount: subtitles ? subtitles.length : null }, limits: AV_QC_LIMITS };
}

/** SRT or WebVTT → cues (seconds). Throws on unreadable timestamps. */
export function parseSubtitles(text: string): { start: number; end: number; text: string }[] {
  const t = (s: string) => { const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim()); if (!m) throw new Error(`marca de tiempo inválida «${s}»`);
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000; };
  const cues: { start: number; end: number; text: string }[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean); const i = lines.findIndex((l) => l.includes("-->")); if (i < 0) continue;
    const [a, b] = lines[i].split("-->"); cues.push({ start: t(a), end: t(b.trim().split(/\s+/)[0]), text: lines.slice(i + 1).join("\n") });
  }
  return cues;
}

/** Parsers for ffmpeg filter logs (stderr). */
export function parseDetectors(stderr: string) {
  const pairs = (re: RegExp) => [...stderr.matchAll(re)].map((x) => [Number(x[1]), Number(x[2])] as [number, number]);
  const black = pairs(/black_start:([\d.]+) black_end:([\d.]+)/g);
  const fs = [...stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((x) => Number(x[1])), fe = [...stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((x) => Number(x[1]));
  const ss = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((x) => Math.max(0, Number(x[1]))), se = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((x) => Number(x[1]));
  const summ = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp, src = summ) => { const v = re.exec(src)?.[1]; return v === undefined ? undefined : Number(v); };
  return {
    black, freeze: fs.map((s, i) => [s, fe[i] ?? Number.NaN] as [number, number]), silence: ss.map((s, i) => [s, se[i] ?? Number.NaN] as [number, number]),
    integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/),
    meanVolumeDb: num(/mean_volume: (-?[\d.]+) dB/, stderr), samplePeakDb: num(/max_volume: (-?[\d.]+) dB/, stderr),
  };
}

export function reportMarkdown(r: AvReport, title: string): string {
  const m = r.measured; const f = (x: AvFinding) => `- **${x.code}** — ${x.message}${x.at ? ` (t=${x.at.map((v) => v.toFixed(1)).join("–")} s)` : ""}`;
  return [`# Control AV — ${title}`, "", `**Veredicto: ${r.verdict}** (${r.blocking.length} bloqueante(s), ${r.warnings.length} aviso(s))`, "",
    "## Medido", `- ${m.width}x${m.height} ${m.videoCodec ?? "?"} ${m.pixFmt ?? ""} ${m.fps ? m.fps.toFixed(2) + " fps" : ""}; audio ${m.hasAudio ? m.audioCodec : "NINGUNO"}`,
    `- Duración contenedor ${m.formatDuration?.toFixed(2)} s · video ${m.videoDuration?.toFixed(2)} s · audio ${m.audioDuration?.toFixed(2) ?? "—"} s`,
    `- Decodificación completa: ${m.decodeErrors.length ? m.decodeErrors.length + " error(es)" : "sin errores"}`,
    `- Sonoridad ${m.integratedLufs ?? "—"} LUFS · LRA ${m.lra ?? "—"} LU · pico real ${m.truePeakDbfs ?? "—"} dBFS · pico muestra ${m.samplePeakDb ?? "—"} dB · volumen medio ${m.meanVolumeDb ?? "—"} dB`,
    `- Negro ${m.black.length} · congelado ${m.freeze.length} · silencio ${m.silence.length} · subtítulos ${m.subtitleCount ?? "no entregados"}`,
    "", "## Bloqueantes", ...(r.blocking.length ? r.blocking.map(f) : ["- Ninguno"]),
    "", "## Avisos (revisión humana)", ...(r.warnings.length ? r.warnings.map(f) : ["- Ninguno"]),
    "", "## Límites de este control", ...r.limits.map((l) => `- ${l}`), ""].join("\n");
}
