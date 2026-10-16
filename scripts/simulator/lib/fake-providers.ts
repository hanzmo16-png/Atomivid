/**
 * Proveedores emulados a nivel HTTP. El código REAL de los adaptadores
 * (providers/avatar/heygen.ts, providers/avatar/did.ts, ai/voice.ts) se
 * ejecuta sin cambios: lo único simulado es la respuesta remota. Así se
 * prueban sus reintentos, sondeos, tiempos de espera y la puerta de llamadas
 * pagadas tal y como están implementados hoy.
 *
 * Mecanismos emulados (solo los que el código usa de verdad):
 * - HeyGen: POST /v3/assets, POST /v3/videos (facturable), GET /v3/videos/:id
 *   (sondeo), descarga del video_url. HeyGen NO tiene webhook en ATOMIVID
 *   (processWebhookPayload devuelve null) — no se emula ninguno.
 * - D-ID: POST /talks (facturable), GET /talks/:id (sondeo), descarga del
 *   result_url. El código no registra webhook al crear el talk.
 * - ElevenLabs: POST /v1/text-to-speech/:voice/with-timestamps (síncrono,
 *   facturable por carácter). Sin webhook: la integración es una sola
 *   petición por fragmento.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { json, registerFake, type FakeRequest } from "./guard";

const FIXTURE_MP4 = path.join(process.cwd(), "src/lib/providers/avatar/fixtures/simulated-avatar-video.mp4");

/** Una respuesta guionizada: estado normal, error HTTP o corte de red. */
export type Step = string | { http: number; body?: unknown } | { network: "reset" };

function stepResponse(step: Exclude<Step, string>) {
  if ("network" in step) throw new TypeError("fetch failed (simulated connection reset)");
  return json(step.body ?? { error: { code: "simulated" } }, step.http);
}

export type CallRecord = { at: number; method: string; path: string; status: number | "network" };

function makeLog() {
  const calls: CallRecord[] = [];
  const record = (req: FakeRequest, status: number | "network") => calls.push({ at: Date.now(), method: req.method, path: req.url.pathname, status });
  return { calls, record };
}

// ---------------------------------------------------------------- medios
export function installMediaHost(getStorageObject: (key: string) => Buffer | undefined) {
  registerFake("sim-media.local", async (req) => {
    const bytes = fs.readFileSync(FIXTURE_MP4);
    void req;
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "video/mp4" } });
  });
  registerFake("sim-storage.local", async (req) => {
    const key = decodeURIComponent(req.url.pathname.slice(1));
    const obj = getStorageObject(key);
    return obj ? new Response(new Uint8Array(obj), { status: 200 }) : new Response("not found", { status: 404 });
  });
}

// ---------------------------------------------------------------- HeyGen
export type HeygenScript = {
  /** Respuesta de POST /v3/videos. "ok" crea el trabajo. */
  create?: Step;
  /** Secuencia de respuestas del sondeo GET /v3/videos/:id (la última se repite). */
  poll: Step[];
};

export function createFakeHeygen() {
  const { calls, record } = makeLog();
  let script: HeygenScript = { poll: ["completed"] };
  const jobs = new Map<string, { polls: number; script: HeygenScript }>();
  let counter = 0;
  const state = {
    calls,
    jobs,
    setScript(s: HeygenScript) { script = s; },
    /** Cambia el guion de un trabajo ya creado (p. ej. el proveedor terminó mientras el worker estaba caído). */
    setJobPoll(id: string, poll: Step[]) { const j = jobs.get(id); if (j) { j.script = { ...j.script, poll }; j.polls = 0; } },
    billablePosts: () => calls.filter((c) => c.method === "POST" && c.path === "/v3/videos").length,
  };
  registerFake("api.heygen.com", async (req) => {
    const p = req.url.pathname;
    if (req.method === "POST" && p === "/v3/assets") {
      record(req, 200);
      return json({ data: { asset_id: `sim-asset-${++counter}` } });
    }
    if (req.method === "POST" && p === "/v3/videos") {
      const step = script.create ?? "ok";
      if (typeof step !== "string") {
        if ("network" in step) {
          // Corte DESPUÉS de que el proveedor aceptara: el trabajo existe y se cobrará.
          const id = `sim-hg-${++counter}`;
          jobs.set(id, { polls: 0, script });
          record(req, "network");
        } else record(req, step.http);
        return stepResponse(step);
      }
      const id = `sim-hg-${++counter}`;
      jobs.set(id, { polls: 0, script });
      record(req, 200);
      return json({ data: { video_id: id } });
    }
    const m = p.match(/^\/v3\/videos\/(.+)$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) { record(req, 404); return json({ error: { code: "not_found" } }, 404); }
      const step = job.script.poll[Math.min(job.polls, job.script.poll.length - 1)];
      job.polls += 1;
      if (typeof step !== "string") { record(req, "network" in step ? "network" : step.http); return stepResponse(step); }
      record(req, 200);
      return json({ data: { status: step, ...(step === "completed" ? { video_url: `https://sim-media.local/heygen/${m[1]}.mp4` } : {}), ...(step === "failed" ? { failure_code: "simulated_failure" } : {}) } });
    }
    if (req.method === "GET" && p === "/v3/users/me") { record(req, 200); return json({ data: { wallet: { currency: "usd", remaining_balance: 0 } } }); }
    record(req, 404);
    return json({ error: { code: "unknown_endpoint" } }, 404);
  });
  return state;
}

// ---------------------------------------------------------------- D-ID
export type DidScript = { create?: Step; poll: Step[] };

export function createFakeDid() {
  const { calls, record } = makeLog();
  let script: DidScript = { poll: ["done"] };
  const jobs = new Map<string, { polls: number; script: DidScript }>();
  let counter = 0;
  const state = {
    calls,
    jobs,
    setScript(s: DidScript) { script = s; },
    setJobPoll(id: string, poll: Step[]) { const j = jobs.get(id); if (j) { j.script = { ...j.script, poll }; j.polls = 0; } },
    billablePosts: () => calls.filter((c) => c.method === "POST" && c.path === "/talks").length,
  };
  registerFake("api.d-id.com", async (req) => {
    const p = req.url.pathname;
    if (req.method === "POST" && p === "/talks") {
      const step = script.create ?? "ok";
      if (typeof step !== "string") {
        if ("network" in step) { jobs.set(`sim-did-${++counter}`, { polls: 0, script }); record(req, "network"); } else record(req, step.http);
        return stepResponse(step);
      }
      const id = `sim-did-${++counter}`;
      jobs.set(id, { polls: 0, script });
      record(req, 201);
      return json({ id, status: "created" }, 201);
    }
    const m = p.match(/^\/talks\/(.+)$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) { record(req, 404); return json({ kind: "NotFoundError" }, 404); }
      const step = job.script.poll[Math.min(job.polls, job.script.poll.length - 1)];
      job.polls += 1;
      if (typeof step !== "string") { record(req, "network" in step ? "network" : step.http); return stepResponse(step); }
      record(req, 200);
      return json({ id: m[1], status: step, ...(step === "done" ? { result_url: `https://sim-media.local/did/${m[1]}.mp4` } : {}) });
    }
    if (req.method === "DELETE") { record(req, 200); return json({ deleted: true }); }
    record(req, 404);
    return json({ kind: "NotFoundError" }, 404);
  });
  return state;
}

// ---------------------------------------------------------------- ElevenLabs
export const SIM_TTS = {
  wordsPerSecond: 2.6,
  /** Pausa natural tras fin de oración y tras coma (s). */
  sentencePauseSeconds: 0.6,
  commaPauseSeconds: 0.25,
  sampleRate: 22050,
};

/** Alineación por carácter + audio MP3 real con silencio en las pausas — misma forma que la respuesta de ElevenLabs. */
export function synthesizeSimNarration(text: string, speed = 1) {
  const words = text.split(/\s+/).filter(Boolean);
  const wordDur = 1 / SIM_TTS.wordsPerSecond / speed;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const voiced: [number, number][] = [];
  let t = 0;
  words.forEach((w, wi) => {
    const per = wordDur / w.length;
    const ws = t;
    for (const ch of w) { characters.push(ch); starts.push(t); t += per; ends.push(t); }
    voiced.push([ws, t]);
    if (wi < words.length - 1) {
      const pause = /[.!?…]$/.test(w) ? SIM_TTS.sentencePauseSeconds : /[,;:]$/.test(w) ? SIM_TTS.commaPauseSeconds : 0.02;
      characters.push(" "); starts.push(t); t += pause; ends.push(t);
    }
  });
  const total = Math.max(t, 0.1);
  const n = Math.ceil(total * SIM_TTS.sampleRate);
  const pcm = Buffer.alloc(n * 2);
  let vi = 0;
  for (let i = 0; i < n; i++) {
    const s = i / SIM_TTS.sampleRate;
    while (vi < voiced.length && s > voiced[vi][1]) vi++;
    const on = vi < voiced.length && s >= voiced[vi][0];
    pcm.writeInt16LE(on ? Math.round(Math.sin(2 * Math.PI * 180 * s) * 6000) : 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SIM_TTS.sampleRate, 24);
  header.writeUInt32LE(SIM_TTS.sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomivid-sim-tts-"));
  try {
    fs.writeFileSync(path.join(dir, "a.wav"), Buffer.concat([header, pcm]));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(dir, "a.wav"), "-codec:a", "libmp3lame", "-b:a", "64k", path.join(dir, "a.mp3")]);
    const mp3 = fs.readFileSync(path.join(dir, "a.mp3"));
    return { mp3, alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }, voiced };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createFakeElevenLabs() {
  const { calls, record } = makeLog();
  const queue: Step[] = [];
  const state = {
    calls,
    chars: 0,
    /** Síntesis exitosas: texto, velocidad y alineación devuelta (verdad de referencia de la narración). */
    history: [] as { text: string; speed: number; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } }[],
    /** Respuestas para las próximas peticiones, en orden; vacío = "ok". */
    queue,
    billablePosts: () => calls.filter((c) => c.method === "POST").length,
    reset() { calls.length = 0; queue.length = 0; state.chars = 0; state.history.length = 0; },
  };
  registerFake("api.elevenlabs.io", async (req) => {
    if (req.method !== "POST" || !/^\/v1\/text-to-speech\/[^/]+\/with-timestamps$/.test(req.url.pathname)) {
      record(req, 404);
      return json({ detail: "unknown endpoint" }, 404);
    }
    const body = JSON.parse(String(req.body)) as { text: string; voice_settings?: { speed?: number } };
    const step = queue.shift() ?? "ok";
    if (typeof step !== "string") {
      record(req, "network" in step ? "network" : step.http);
      if ("network" in step) state.chars += body.text.length; // aceptado y facturado; respuesta perdida
      return stepResponse(step);
    }
    state.chars += body.text.length;
    const { mp3, alignment } = synthesizeSimNarration(body.text, body.voice_settings?.speed ?? 1);
    state.history.push({ text: body.text, speed: body.voice_settings?.speed ?? 1, alignment });
    record(req, 200);
    return json({ audio_base64: mp3.toString("base64"), alignment });
  });
  return state;
}

/** Palabras a partir de la alineación por carácter (misma regla que ai/voice.ts buildWordTimings: espacios separan). */
export function wordsFromAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }) {
  const words: { text: string; startSeconds: number; endSeconds: number }[] = [];
  let cur: { text: string; startSeconds: number; endSeconds: number } | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { text: ch, startSeconds: a.character_start_times_seconds[i], endSeconds: a.character_end_times_seconds[i] };
    else { cur.text += ch; cur.endSeconds = a.character_end_times_seconds[i]; }
  });
  if (cur) words.push(cur);
  return words;
}
