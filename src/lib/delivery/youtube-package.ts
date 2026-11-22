/**
 * Paquete de entrega YouTube (sin publicar, sin llamadas pagadas).
 * Todo se DERIVA de entradas existentes: guion (beats), línea de tiempo real
 * del render, subtítulos del render y el informe AV QC. Nada se inventa:
 * licencias/atribuciones solo se copian si el recurso las trae; si no, quedan
 * como «licencia no declarada — revisar antes de publicar».
 */
import { suggestTitle } from "../video/long-form/packaging";

export type PkgBeat = { index: number; type?: string; heading?: string; text: string };
export type PkgSegment = { beatIndex: number; startSeconds: number; endSeconds: number; text?: string };
export type PkgSource = {
  sceneId: string; kind: "evidence" | "illustration" | "recreation";
  provider: string; url?: string | null; author?: string | null; license?: string | null; note?: string | null;
};
export type Cue = { start: number; end: number; text: string };

export function ts(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}
export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n${c.text}\n`).join("\n");
}
export function toVtt(cues: Cue[]): string {
  return "WEBVTT\n\n" + cues.map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}\n${c.text}\n`).join("\n");
}
/** Parser SRT mínimo (para convertir el SRT del render a VTT sin re-sincronizar). */
export function parseSrt(src: string): Cue[] {
  const toS = (t: string) => { const [h, m, r] = t.replace(",", ".").split(":"); return +h * 3600 + +m * 60 + +r; };
  return src.replace(/\r/g, "").split(/\n\n+/).flatMap((b) => {
    const l = b.trim().split("\n"); const i = l.findIndex((x) => x.includes("-->"));
    if (i < 0) return [];
    const [a, z] = l[i].split("-->").map((s) => s.trim().split(" ")[0]);
    return [{ start: toS(a), end: toS(z), text: l.slice(i + 1).join("\n").trim() }];
  });
}

function mmss(sec: number): string {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
}

/**
 * Capítulos desde la línea de tiempo REAL. Reglas de YouTube: el primero en 0:00,
 * ≥3 capítulos, cada uno ≥10 s. Beats contiguos demasiado cortos se fusionan.
 */
export function chapters(beats: PkgBeat[], segs: PkgSegment[], minLen = 10): { start: number; title: string }[] {
  const byBeat = new Map<number, { s: number; e: number }>();
  for (const g of segs) {
    const c = byBeat.get(g.beatIndex);
    byBeat.set(g.beatIndex, c ? { s: Math.min(c.s, g.startSeconds), e: Math.max(c.e, g.endSeconds) } : { s: g.startSeconds, e: g.endSeconds });
  }
  const out: { start: number; end: number; title: string }[] = [];
  for (const b of [...beats].sort((x, y) => x.index - y.index)) {
    const r = byBeat.get(b.index); if (!r) continue;
    const title = (b.heading?.trim() || firstSentence(b.text)).slice(0, 60);
    const last = out[out.length - 1];
    if (last && (last.end - last.start < minLen || r.e - r.s < minLen)) { last.end = r.e; continue; }
    out.push({ start: r.s, end: r.e, title });
  }
  if (out.length) out[0].start = 0;
  if (out.length >= 2 && out[out.length - 1].end - out[out.length - 1].start < minLen) {
    const z = out.pop()!; out[out.length - 1].end = z.end;
  }
  return out.length >= 3 ? out.map(({ start, title }) => ({ start, title })) : [];
}
function firstSentence(t: string): string {
  const s = t.replace(/\s+/g, " ").trim().split(/(?<=[.!?¿¡])\s/)[0] ?? "";
  return s.replace(/[.!?]+$/, "").split(" ").slice(0, 8).join(" ");
}

export function describe(input: { topic: string; beats: PkgBeat[]; chapters: { start: number; title: string }[]; sources: PkgSource[] }) {
  const title = suggestTitle(input.topic, 100);
  const intro = firstSentenceFull(input.beats[0]?.text ?? "");
  const ch = input.chapters.map((c) => `${mmss(c.start)} ${c.title}`).join("\n");
  const n = (k: PkgSource["kind"]) => input.sources.filter((s) => s.kind === k).length;
  const description = [
    intro, "",
    ch ? "Capítulos:\n" + ch : "", "",
    `Material visual: ${n("evidence")} de archivo/evidencia, ${n("illustration")} ilustrativo, ${n("recreation")} recreación generada por IA (no es registro real).`,
    "Fuentes y atribuciones: ver SOURCES.md del paquete.",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
  return { title, description };
}
/**
 * Datos para publicar en YouTube que el cliente ve y copia junto al MP4 (T-VIDEO-GO-20261122). Solo se deriva de lo que
 * existe: el tema, la narración y los tiempos REALES medidos de cada bloque. No afirma nada sobre fuentes ni licencias:
 * esa línea queda fuera porque el worker no tiene el inventario completo aquí. Nunca publica nada.
 */
export type YoutubeMetadata = { version: 1; title: string; description: string; chapters: { start: number; title: string }[]; tags: string[] };

export function youtubeMetadata(input: { topic: string; language?: string | null; beats: { text: string; startSeconds: number; endSeconds: number }[] }): YoutubeMetadata {
  const beats = input.beats.map((b, index) => ({ index, text: b.text }));
  const segs = input.beats.map((b, index) => ({ beatIndex: index, startSeconds: b.startSeconds, endSeconds: b.endSeconds }));
  const ch = chapters(beats, segs);
  const en = input.language === "en";
  const intro = firstSentenceFull(input.beats[0]?.text ?? "");
  const description = [intro, ch.length ? `${en ? "Chapters" : "Capítulos"}:\n${ch.map((c) => `${mmss(c.start)} ${c.title}`).join("\n")}` : ""]
    .filter(Boolean).join("\n\n").slice(0, 5000);
  const tags = [...new Set(suggestTitle(input.topic, 100).toLocaleLowerCase(en ? "en" : "es").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))].slice(0, 8);
  return { version: 1, title: suggestTitle(input.topic, 100), description, chapters: ch, tags };
}

/** Lectura tolerante del JSON guardado: cualquier forma inesperada se descarta (el panel no se muestra). */
export function parseYoutubeMetadata(raw: unknown): YoutubeMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<YoutubeMetadata>;
  if (m.version !== 1 || typeof m.title !== "string" || !m.title.trim() || typeof m.description !== "string") return null;
  const chapters = Array.isArray(m.chapters) ? m.chapters.filter((c) => c && typeof c.start === "number" && typeof c.title === "string") : [];
  const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [];
  return { version: 1, title: m.title.slice(0, 100), description: m.description.slice(0, 5000), chapters, tags };
}

export const youtubeMetadataPath = (requestId: string) => `${requestId}/output/youtube.json`;

function firstSentenceFull(t: string): string {
  return (t.replace(/\s+/g, " ").trim().match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim().slice(0, 300);
}

export function sourcesMarkdown(src: PkgSource[]): string {
  const sect = (k: PkgSource["kind"], h: string) => {
    const rows = src.filter((s) => s.kind === k);
    return `## ${h} (${rows.length})\n\n` + (rows.length ? "| Escena | Proveedor | Autor | Licencia | URL |\n|---|---|---|---|---|\n" +
      rows.map((s) => `| ${s.sceneId} | ${s.provider} | ${s.author ?? "—"} | ${s.license ?? "**no declarada — revisar antes de publicar**"} | ${s.url ?? "—"} |`).join("\n") : "_ninguno_") + "\n";
  };
  return "# Fuentes y atribuciones\n\nNo se inventan licencias: si el proveedor no la declaró, se marca para revisión.\n\n" +
    sect("evidence", "Evidencia / archivo") + "\n" + sect("illustration", "Ilustración (stock genérico)") + "\n" +
    sect("recreation", "Recreación generada (IA) — no es registro real");
}
