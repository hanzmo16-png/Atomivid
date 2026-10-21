// Mock local (USD 0, sólo 127.0.0.1:54610) de los proveedores del Long Form para el ensayo 1080p (Grok, T-20261021-0530):
//  /el/v1/text-to-speech/:voice/with-timestamps → voz LOCAL Piper (es_MX) + alineación por carácter proporcional (no es ElevenLabs)
//  /pexels/videos/search, /pexels/v1/search → material SINTÉTICO 1920x1080 (MEDIA_DIR), alt = consulta (no prueba pertinencia)
//  /commons → sin resultados; /openai/v1/images/generations → PNG sintético 1536x1024; /media/* estático.
// Cada llamada se registra (MOCK_LOG) con sha256 de lo servido.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process"; import os from "node:os";
const MEDIA = process.env.MEDIA_DIR, LOG = process.env.MOCK_LOG, PIPER = process.env.PIPER_BIN, VOICE = process.env.PIPER_VOICE, PORT = 54610;
const FAULTS = process.env.FAULTS_FILE; // {"el":{"mode":"500","remaining":1}}
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let img = 0, ttsN = 0;
function fault(k) { if (!FAULTS) return null; try { const a = JSON.parse(fs.readFileSync(FAULTS, "utf8")); if (a[k]?.remaining > 0) { a[k].remaining--; fs.writeFileSync(FAULTS, JSON.stringify(a)); return a[k].mode; } } catch {} return null; }
function tts(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-")); const wav = path.join(dir, "a.wav"), mp3 = path.join(dir, "a.mp3");
  execFileSync(PIPER, ["-m", VOICE, "-f", wav], { input: text, stdio: ["pipe", "ignore", "ignore"] });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", mp3]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).toString());
  const buf = fs.readFileSync(mp3); fs.rmSync(dir, { recursive: true });
  const chars = [...text]; const lead = 0.08, span = Math.max(0.1, dur - 0.2);
  const s = chars.map((_, i) => +(lead + span * i / chars.length).toFixed(3)), e = chars.map((_, i) => +(lead + span * (i + 1) / chars.length).toFixed(3));
  return { buf, dur, alignment: { characters: chars, character_start_times_seconds: s, character_end_times_seconds: e } };
}
// Material ÚNICO por resultado (el control visual productivo detecta repeticiones por hash perceptual): cada id genera,
// bajo demanda y en caché, un patrón distinto (autómata celular con semilla + degradado con colores derivados del id).
let uid = 0; const GEN = path.join(MEDIA, "gen"); fs.mkdirSync(GEN, { recursive: true });
function gen(kind, id) {
  const ext = kind === "clip" ? "mp4" : kind === "ai" ? "png" : "jpg"; const f = path.join(GEN, `${kind}-${id}.${ext}`); if (fs.existsSync(f)) return f;
  const h = sha(`${kind}${id}`); const col = (i) => "0x" + h.slice(i, i + 6); const [w, hh] = kind === "ai" ? [1536, 1024] : kind === "photo" ? [1920, 1280] : [1920, 1080];
  const src = `cellauto=s=${w / 8}x${hh / 8}:rule=${30 + (parseInt(h.slice(0, 2), 16) % 90)}:random_seed=${parseInt(h.slice(2, 8), 16)}:full=1:r=30,scale=${w}:${hh}:flags=neighbor,format=rgb24`;
  const label = { clip: "VIDEO SINTETICO", photo: "FOTO SINTETICA", ai: "IMAGEN IA SINTETICA" }[kind];
  // Bloques grandes en posiciones/colores derivados del id: estructura de baja frecuencia distinta ⇒ hash perceptual distinto.
  const n = (i, m) => parseInt(h.slice(i, i + 4), 16) % m;
  const boxes = [0, 1, 2, 3].map((k) => `drawbox=x=${n(32 + k * 8, w - w / 3)}:y=${n(36 + k * 8, hh - hh / 3)}:w=${w / 4 + n(40 + k * 4, w / 4)}:h=${hh / 4 + n(44 + k * 4, hh / 4)}:c=0x${h.slice(48 + k * 4, 54 + k * 4).padEnd(6, "8")}:t=fill`).join(",");
  const vf = `[0:v][1:v]blend=all_mode=multiply,${boxes},drawtext=text='${label} ${id}':x=40:y=${hh - 90}:fontsize=52:fontcolor=white:box=1:boxcolor=black@0.6`;
  const g = `gradients=s=${w}x${hh}:c0=${col(8)}:c1=${col(14)}:c2=${col(20)}:seed=${parseInt(h.slice(26, 32), 16)}:speed=0.03:r=30`;
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-f", "lavfi", "-i", g, "-filter_complex", vf];
  if (kind === "clip") execFileSync("ffmpeg", [...args, "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
  else execFileSync("ffmpeg", [...args, "-frames:v", "1", f]);
  return f;
}
const files = (p) => fs.readdirSync(MEDIA).filter((f) => f.startsWith(p)).sort();
const slug = (q) => String(q).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
  const u = new URL(req.url, "http://x"), p = u.pathname, B = `http://127.0.0.1:${PORT}`;
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (p.startsWith("/el/v1/text-to-speech/")) {
      const b = JSON.parse(Buffer.concat(c).toString() || "{}"); const f = fault("el");
      if (f === "500") { log({ kind: "tts", fault: 500, chars: b.text?.length }); return json(500, { detail: "mock fault" }); }
      const r = tts(String(b.text ?? "")); ttsN++;
      log({ kind: "tts", n: ttsN, voice: p.split("/")[4], model: b.model_id, chars: b.text.length, words: b.text.split(/\s+/).length, seconds: r.dur, sha256: sha(r.buf) });
      return json(200, { audio_base64: r.buf.toString("base64"), alignment: r.alignment, normalized_alignment: r.alignment });
    }
    if (p === "/pexels/videos/search") { const q = u.searchParams.get("query") ?? ""; const v = files("clip-");
      const rot = Array.from({ length: 12 }, (_, i) => i).map(() => { const id = ++uid; return { id: 900000 + id, duration: 10, url: `https://www.pexels.com/video/${slug(q)}-${900000 + id}/`, user: { name: "Sintético local" },
        video_files: [{ link: `${B}/media/gen/clip-${id}.mp4`, width: 1920, height: 1080, file_type: "video/mp4", quality: "hd" }] }; });
      log({ kind: "pexels_video_search", q }); return json(200, { page: 1, per_page: rot.length, total_results: rot.length, videos: rot }); }
    if (p === "/pexels/v1/search") { const q = u.searchParams.get("query") ?? ""; const ph = files("photo-");
      log({ kind: "pexels_photo_search", q });
      return json(200, { photos: Array.from({ length: 12 }, (_, i) => i).map(() => { const id = ++uid; return { id: 800000 + id, width: 1920, height: 1280, url: `https://www.pexels.com/photo/${slug(q)}-${800000 + id}/`, photographer: "Sintético local", alt: q, src: { large2x: `${B}/media/gen/photo-${id}.jpg`, original: `${B}/media/gen/photo-${id}.jpg` } }; }) }); }
    if (p.startsWith("/commons")) { log({ kind: "commons", q: u.searchParams.get("gsrsearch") ?? u.searchParams.get("srsearch") }); return json(200, { batchcomplete: "", query: { pages: {}, search: [] } }); }
    if (p === "/openai/v1/images/generations") { const b = JSON.parse(Buffer.concat(c).toString() || "{}"); const f = path.basename(gen("ai", `x${++img}`)); const buf = fs.readFileSync(path.join(GEN, f));
      log({ kind: "openai_image", idx: img - 1, file: f, size: b.size, quality: b.quality, sha256: sha(buf), prompt: String(b.prompt ?? "").slice(0, 160) });
      return json(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString("base64") }], usage: { input_tokens: 50, output_tokens: 1056, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } }); }
    if (p.startsWith("/media/gen/")) { const m = /^(clip|photo|ai)-(\w+)\./.exec(path.basename(p)); if (m) gen(m[1], m[2]); }
    if (p.startsWith("/media/")) { const f = p.startsWith("/media/gen/") ? path.join(GEN, path.basename(p)) : path.join(MEDIA, path.basename(p)); if (!fs.existsSync(f)) return json(404, {}); const buf = fs.readFileSync(f);
      log({ kind: "media", file: path.basename(f) }); res.writeHead(200, { "content-type": f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".mp3") ? "audio/mpeg" : f.endsWith(".png") ? "image/png" : "image/jpeg", "content-length": buf.length }); return res.end(buf); }
    log({ kind: "unknown", path: p }); json(404, { error: "mock: unknown" });
  } catch (e) { log({ kind: "error", path: p, message: String(e) }); json(500, { error: String(e) }); }
}); }).listen(PORT, "127.0.0.1", () => console.log("mock longform providers " + PORT));
