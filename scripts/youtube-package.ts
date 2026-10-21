/**
 * Arma un paquete de entrega YouTube LOCAL (no publica nada, no llama a proveedores).
 *   npx tsx scripts/youtube-package.ts --mp4 v.mp4 --script beats.json --timeline segs.json \
 *     [--srt subs.srt] [--thumbnail thumb.jpg] [--avqc dir/base] [--sources sources.json] --topic "..." --out dir
 * Sin --thumbnail usa un fotograma del video y lo DECLARA así en el manifiesto.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chapters, describe, parseSrt, sourcesMarkdown, toSrt, toVtt, type PkgBeat, type PkgSegment, type PkgSource } from "../src/lib/delivery/youtube-package";

const a = process.argv.slice(2);
const arg = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const need = (k: string) => { const v = arg(k); if (!v) { console.error(`falta --${k}`); process.exit(1); } return v; };
const out = need("out"); mkdirSync(out, { recursive: true });
const beats: PkgBeat[] = JSON.parse(readFileSync(need("script"), "utf8"));
const segs: PkgSegment[] = JSON.parse(readFileSync(need("timeline"), "utf8"));
const sources: PkgSource[] = arg("sources") ? JSON.parse(readFileSync(arg("sources")!, "utf8")) : [];
const notes: string[] = [];

copyFileSync(need("mp4"), join(out, "video.mp4"));
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(out, "video.mp4")]).toString().trim());

let cues = arg("srt") ? parseSrt(readFileSync(arg("srt")!, "utf8")) : [];
if (!cues.length) {
  cues = segs.filter((s) => s.text?.trim()).map((s) => ({ start: s.startSeconds, end: s.endSeconds, text: s.text!.trim() }));
  notes.push("Subtítulos derivados de la línea de tiempo de narración (no había SRT del render).");
}
writeFileSync(join(out, "subtitles.es.srt"), toSrt(cues));
writeFileSync(join(out, "subtitles.es.vtt"), toVtt(cues));

if (arg("thumbnail") && existsSync(arg("thumbnail")!)) copyFileSync(arg("thumbnail")!, join(out, "thumbnail.jpg"));
else {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.min(5, dur / 2)), "-i", join(out, "video.mp4"), "-frames:v", "1", "-vf", "scale=1280:720", "-q:v", "3", join(out, "thumbnail.jpg")]);
  notes.push("Miniatura = fotograma del video (la miniatura diseñada no estaba activada/disponible).");
}

const ch = chapters(beats, segs);
const meta = describe({ topic: need("topic"), beats, chapters: ch, sources });
writeFileSync(join(out, "title.txt"), meta.title + "\n");
writeFileSync(join(out, "description.txt"), meta.description + "\n");
writeFileSync(join(out, "chapters.txt"), ch.map((c) => `${new Date(c.start * 1000).toISOString().slice(11, 19)} ${c.title}`).join("\n") + "\n");
writeFileSync(join(out, "SOURCES.md"), sourcesMarkdown(sources));
const avqc = arg("avqc");
let avqcCopied = 0;
if (avqc) for (const ext of [".av-qc.json", ".av-qc.md"]) if (existsSync(avqc + ext)) { copyFileSync(avqc + ext, join(out, "av-qc" + ext)); avqcCopied++; }
if (!avqcCopied) notes.push("Sin informe AV QC.");

const files = readdirSync(out).filter((f) => f !== "manifest.json").sort().map((f) => {
  const buf = readFileSync(join(out, f));
  return { file: f, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
});
writeFileSync(join(out, "manifest.json"), JSON.stringify({
  kind: "atomivid-youtube-package", createdAt: new Date().toISOString(), published: false,
  durationSeconds: dur, chapters: ch.length, subtitleCues: cues.length, notes, files,
}, null, 2));
console.log(`paquete en ${out}: ${files.length} archivos, ${ch.length} capítulos, ${cues.length} subtítulos (${basename(out)})`);
