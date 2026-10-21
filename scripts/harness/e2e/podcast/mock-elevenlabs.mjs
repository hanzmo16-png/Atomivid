// Mock LOCAL de ElevenLabs (USD 0, 127.0.0.1). Voces de catálogo + una clonada «duro hans» (id ficticio de prueba,
// NO la voz real), saldo, y TTS /with-timestamps con espeak-ng: una voz espeak distinta y fija por voice_id.
// Registra cada síntesis (voice_id, chars, voice_settings) en MOCK_LOG. Fallos inyectables: archivo MOCK_FAIL con
// «500», «timeout» o «hang» (la próxima llamada).
import http from "node:http"; import fs from "node:fs"; import { execFileSync } from "node:child_process"; import os from "node:os"; import path from "node:path";
const PORT = Number(process.env.MOCK_EL_PORT ?? 54870), LOG = process.env.MOCK_LOG, FAIL = process.env.MOCK_FAIL;
const VOICES = [
  { voice_id: "VozCatalogoAna01", name: "Ana (catálogo)", category: "premade", labels: { language: "es", gender: "female" } },
  { voice_id: "VozCatalogoLeo02", name: "Leo (catálogo)", category: "premade", labels: { language: "es", gender: "male" } },
  { voice_id: "DuroPruebaLocal03", name: "duro hans (FICTICIA local)", category: "cloned", is_owner: true, labels: { language: "es" } },
];
const PROFILE = { VozCatalogoAna01: ["-v", "es+f3", "-p", "65"], VozCatalogoLeo02: ["-v", "es-419", "-p", "35"], DuroPruebaLocal03: ["-v", "es", "-p", "20"] };
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const body = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/v1/voices") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ voices: VOICES })); }
  if (u.pathname === "/v1/user/subscription") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ character_count: 1000, character_limit: 500000 })); }
  const m = /^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/.exec(u.pathname);
  if (m && req.method === "POST") {
    const voiceId = decodeURIComponent(m[1]); const b = JSON.parse(await body(req));
    const fail = FAIL && fs.existsSync(FAIL) ? fs.readFileSync(FAIL, "utf8").trim() : "";
    if (fail) fs.rmSync(FAIL);
    log({ kind: "tts", voiceId, chars: b.text.length, model: b.model_id, settings: b.voice_settings, fail: fail || null });
    if (fail === "500") { res.writeHead(500); return res.end("mock down"); }
    if (fail === "hang") return; // nunca responde (timeout del cliente → resultado ambiguo)
    if (fail === "timeout") { req.socket.destroy(); return; }
    if (!PROFILE[voiceId]) { res.writeHead(404); return res.end("voice not found"); }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mel-")), raw = path.join(d, "r.wav"), mp3 = path.join(d, "o.mp3");
    const speed = b.voice_settings?.speed ?? 1;
    execFileSync("espeak-ng", [...PROFILE[voiceId], "-s", String(Math.round(165 * speed)), "-w", raw, b.text]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-ar", "44100", "-ac", "1", "-b:a", "64k", mp3]);
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString().trim());
    const chars = [...b.text], step = dur / Math.max(1, chars.length);
    const audio = fs.readFileSync(mp3).toString("base64"); fs.rmSync(d, { recursive: true, force: true });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ audio_base64: audio, alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) } }));
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`mock-elevenlabs ${PORT}`));
