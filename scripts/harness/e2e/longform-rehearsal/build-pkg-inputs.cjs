// Uso: node build-pkg-inputs.cjs <requestId> <outDir>
// Reconstruye desde el estado REAL del pedido (caché TTS por beat con tiempos por palabra + activos guardados):
// beats.json, timeline.json (beats contiguos en el orden del guion), subs.srt (≤8 palabras / ≤3.5 s),
// sources.json (stock = ilustración, ai_image = recreación; licencias NO inventadas) y manifest.json para av-qc.
const fs = require("fs"), path = require("path");
const [R, o] = process.argv.slice(2);
const root = "/workspace/atomivid-recraft/.e2e-local/storage/videos";
const d = `${root}/long-form/${R}/state/tts/`;
fs.mkdirSync(o, { recursive: true });
const t = fs.readdirSync(d).map((f) => JSON.parse(fs.readFileSync(d + f, "utf8"))).sort((a, b) => +a.identity.beatId.split("-")[1] - +b.identity.beatId.split("-")[1]);
let off = 0; const segs = [], cues = [], beats = [];
for (const j of t) {
  const b = +j.identity.beatId.split("-")[1];
  beats.push({ index: b, text: j.identity.text });
  segs.push({ beatIndex: b, startSeconds: off, endSeconds: off + j.durationSeconds, text: j.identity.text });
  let cur = []; const flush = () => { if (cur.length) { cues.push({ start: off + cur[0].startSeconds, end: off + cur[cur.length - 1].endSeconds, text: cur.map((w) => w.text).join(" ") }); cur = []; } };
  for (const w of j.words) { cur.push(w); if (cur.length >= 8 || (/[.!?,;:]$/.test(w.text) && cur.length >= 3) || cur[cur.length - 1].endSeconds - cur[0].startSeconds > 3.5) flush(); }
  flush(); off += j.durationSeconds;
}
const ts = (s) => { const ms = Math.round(s * 1000), p = (n, w = 2) => String(n).padStart(w, "0"); return `${p(Math.floor(ms / 36e5))}:${p(Math.floor(ms / 6e4) % 60)}:${p(Math.floor(ms / 1e3) % 60)},${p(ms % 1000, 3)}`; };
fs.writeFileSync(path.join(o, "subs.srt"), cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n"));
fs.writeFileSync(path.join(o, "beats.json"), JSON.stringify(beats));
fs.writeFileSync(path.join(o, "timeline.json"), JSON.stringify(segs));
const A = `${root}/${R}/assets/`;
const src = fs.readdirSync(A).map((f) => { const m = f.match(/^(beat-\d+-shot-\d+)\.(\w+)\./); return m && { sceneId: m[1], kind: m[2] === "ai_image" ? "recreation" : "illustration", provider: m[2] === "ai_image" ? "openai (MOCK local, sintético)" : "pexels (MOCK local, sintético)", author: null, license: null, url: null }; }).filter(Boolean);
fs.writeFileSync(path.join(o, "sources.json"), JSON.stringify(src));
fs.writeFileSync(path.join(o, "manifest.json"), JSON.stringify({ version: 1, expected: { width: 1920, height: 1080, durationSeconds: 600, durationTolerancePct: 5, videoCodec: "h264", audioCodec: "aac", requireAudio: true }, loudness: { integratedLufs: -16, toleranceLu: 2, truePeakDbtp: -1.5 }, subtitles: path.join(o, "subs.srt"), timeline: segs.map((s) => ({ id: `beat-${s.beatIndex}`, start: s.startSeconds, end: s.endSeconds, status: "ready" })) }, null, 1));
console.log(JSON.stringify({ cues: cues.length, beats: beats.length, narrationSeconds: off, sources: src.length, ai: src.filter((s) => s.kind === "recreation").length }));
