/**
 * Validación local y GRATUITA de un episodio de ~45 minutos de «Texto a
 * voz» con música (sin proveedores ni red): mismo worker (runTtsJob), mismas
 * funciones de unión, masterización y mezcla que en producción, con una base
 * y un Storage en memoria y un proveedor de voz simulado que devuelve habla
 * sintética (no es voz real).
 *
 * Comprueba y deja evidencia de:
 * - una pieza equivalente a 45 min (≈ 5.850 palabras a 130 ppm);
 * - interrupción (presupuesto de tiempo y un fallo sin cobro) y reanudación
 *   sin repetir ninguna síntesis;
 * - continuidad y duración de la narración;
 * - narración y mezcla: sonoridad, pico real, sin recorte, tamaño;
 * - voz al frente (relación voz/música por tramos) y costuras del bucle;
 * - tiempos reales de unir, masterizar y mezclar (dimensionan el worker).
 *
 * Uso: npx tsx scripts/podcast-local-validation.ts --out-dir evidence/podcast [--minutes 45]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

const args = process.argv.slice(2);
const outDir = args.includes("--out-dir") ? args[args.indexOf("--out-dir") + 1] : "evidence/podcast";
const minutes = args.includes("--minutes") ? Number(args[args.indexOf("--minutes") + 1]) : 45;

const WORDS = (
  "la historia del valle empezó mucho antes de que llegaran los primeros viajeros con sus carretas cargadas de sal y de telas " +
  "en aquel tiempo los caminos eran estrechos y el río marcaba las estaciones con crecidas que nadie sabía anunciar " +
  "los archivos del monasterio guardan cartas cuentas y mapas que contradicen la versión que se enseñó durante siglos " +
  "cada documento abre una pregunta nueva sobre quién construyó las murallas y por qué el puente quedó sin terminar"
).split(" ");

function buildScript(targetWords: number): string {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const paragraphs: string[] = [];
  let words = 0;
  let p = 0;
  while (words < targetWords) {
    p += 1;
    const sentences: string[] = [];
    const count = 4 + Math.floor(rand() * 4);
    for (let s = 0; s < count && words < targetWords; s++) {
      const len = 12 + Math.floor(rand() * 14);
      const w = Array.from({ length: len }, () => WORDS[Math.floor(rand() * WORDS.length)]);
      w[0] = `${w[0][0].toUpperCase()}${w[0].slice(1)}`;
      if (s === 0) w.unshift(`Parte ${p}:`);
      sentences.push(`${w.join(" ")}${rand() < 0.2 ? "?" : "."}`.replace(/^([^?]*)\?$/, "¿$1?"));
      words += w.length;
    }
    paragraphs.push(sentences.join(" "));
  }
  return paragraphs.join("\n\n");
}

async function main() {
  const { memoryDb } = await import("../src/lib/tts/test-db");
  const { monoWav16, sliceSpeech, speechBank } = await import("../src/lib/tts/test-audio");
  const { segmentScript, billableCharacters, countWords, estimateDurationRange, formatDurationRange } = await import("../src/lib/tts/segment");
  const { runTtsJob, ttsAudioPath, ttsMixPath } = await import("../src/lib/tts/run-tts-job");
  const { retryTtsRequest } = await import("../src/lib/tts/requests");
  const { concatToMp3, mixToMp3 } = await import("../src/lib/tts/concat");
  const { MUSIC_BEDS, renderMusicBedWav, findMusicBed } = await import("../src/lib/tts/music-beds");
  const { MIX, mixNarrationWithBed, mixTotalSeconds, measureLoudness, DEFAULT_MAX_OBJECT_BYTES } = await import("../src/lib/tts/podcast-audio");

  await mkdir(outDir, { recursive: true });
  const script = buildScript(Math.round(minutes * 130));
  const segments = segmentScript(script);
  const words = countWords(script);
  const characters = billableCharacters(segments);
  const range = estimateDurationRange(words);
  console.log(`[podcast] guion: ${words} palabras, ${characters} caracteres, ${segments.length} fragmentos, estimación ${formatDurationRange(range)}`);

  const jobId = "0d1e2f30-4a5b-4c6d-8e7f-8091a2b3c4d5";
  const owner = "11111111-1111-4111-8111-111111111111";
  const db = memoryDb({
    tts_jobs: [
      {
        id: jobId, user_id: owner, title: "Episodio de prueba", language: "es", voice_choice: "miguel", script, characters,
        status: "queued", attempts: 0, segments_done: 0, long_pilot: true, music_choice: "documentary", music_track_id: null,
        mix_status: "pending", mix_attempts: 0, audio_path: null,
      },
    ],
  });

  // Proveedor simulado: habla sintética a ~150 palabras/min de habla (las pausas las pone la unión). Un fallo «rechazado» (sin cobro) en la llamada 31.
  const bank = speechBank(120, 11);
  const calls: string[] = [];
  const segmentSeconds = new Map<string, number>();
  let clock = 0;
  let failedOnce = false;
  const provider = {
    name: "elevenlabs",
    async synthesize(text: string) {
      const index = calls.length;
      calls.push(text);
      clock += 9_000; // ~9 s simulados por llamada (latencia típica de un fragmento de ~900 caracteres)
      if (index === 30 && !failedOnce) {
        failedOnce = true;
        throw new Error("ElevenLabs respondió 400: texto rechazado (simulado)");
      }
      const seconds = (countWords(text) / 150) * 60;
      segmentSeconds.set(text, seconds);
      return { audioBuffer: monoWav16(sliceSpeech(bank, index * 7.3, seconds)), durationSeconds: seconds, words: [], mimeType: "audio/wav", extension: "wav" };
    },
  };
  const timings: Record<string, number> = {};
  const timed = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => async (...a: A) => {
    const t0 = Date.now();
    try {
      return await fn(...a);
    } finally {
      timings[name] = (timings[name] ?? 0) + (Date.now() - t0) / 1000;
    }
  };
  const deps = (deadlineMs: number) => ({
    service: db.client,
    voiceProvider: provider as never,
    concat: timed("unir_y_masterizar_narracion_s", concatToMp3),
    mix: timed("mezclar_y_masterizar_s", mixToMp3),
    quota: async () => ({ remaining: 1_000_000 }),
    otherVoiceWork: async () => 0,
    providerReserveChars: 3000,
    now: () => new Date(clock),
    deadlineMs,
  });

  const runs: { run: number; result: string; segmentsDone: number; calls: number; message: string | null }[] = [];
  const row = db.rows("tts_jobs")[0];
  // Ejecución 1: presupuesto de ~20 fragmentos simulados (fuerza la pausa); la 2 encuentra el fallo rechazado; la 3 termina.
  const budgets = [20 * 9_000, 10 * 3600_000, 10 * 3600_000, 10 * 3600_000];
  for (let run = 1; run <= budgets.length && row.status !== "completed"; run++) {
    if (run > 1) {
      const retry = await retryTtsRequest({ service: db.client, userId: owner, jobId, dispatch: async () => {} });
      if (!retry.ok) throw new Error(`reintento rechazado: ${retry.error}`);
    }
    const result = await runTtsJob(jobId, deps(clock + budgets[run - 1]));
    runs.push({ run, result, segmentsDone: Number(row.segments_done), calls: calls.length, message: (row.error_message as string) ?? null });
    console.log(`[podcast] ejecución ${run}: ${result}, fragmentos ${row.segments_done}/${segments.length}, llamadas ${calls.length}${row.error_message ? ` — ${row.error_message}` : ""}`);
  }
  if (row.status !== "completed" || row.mix_status !== "completed") throw new Error(`no terminó: ${row.status} / ${row.mix_status}`);
  const uniqueTexts = new Set(calls);
  const repeated = calls.length - uniqueTexts.size;

  const narration = db.storage.files.get(ttsAudioPath(jobId))!;
  const mix = db.storage.files.get(ttsMixPath(jobId))!;
  await writeFile(path.join(outDir, "narracion.mp3"), narration);
  await writeFile(path.join(outDir, "podcast-con-musica.mp3"), mix);
  const narrLoud = await measureLoudness(path.join(outDir, "narracion.mp3"));
  const mixLoud = await measureLoudness(path.join(outDir, "podcast-con-musica.mp3"));
  const probe = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).stdout.toString().trim());
  const narrSeconds = probe(path.join(outDir, "narracion.mp3"));
  const mixSeconds = probe(path.join(outDir, "podcast-con-musica.mp3"));
  const expectedNarr = segments.reduce((sum, s) => sum + (segmentSeconds.get(s.text) ?? 0) + s.pauseAfterMs / 1000, 0);

  // Stems con la misma curva para medir la relación voz/música y las costuras del bucle.
  const bed = findMusicBed(row.music_track_id as string)!;
  const bedFile = path.join(outDir, "fondo.wav");
  await writeFile(bedFile, renderMusicBedWav(bed));
  const t0 = Date.now();
  const voiceStem = await mixNarrationWithBed({ narration: path.join(outDir, "narracion.mp3"), bed: bedFile, output: path.join(outDir, "stem-voz.wav"), stem: "voice" });
  const musicStem = await mixNarrationWithBed({ narration: path.join(outDir, "narracion.mp3"), bed: bedFile, output: path.join(outDir, "stem-musica.wav"), stem: "music" });
  timings.stems_s = (Date.now() - t0) / 1000;
  const decode = (f: string) => {
    const out = spawnSync("ffmpeg", ["-v", "error", "-i", f, "-ac", "2", "-f", "f32le", "-"], { maxBuffer: 2 ** 31 - 1 });
    const buf = Buffer.from(out.stdout as Buffer);
    const st = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const mono = new Float32Array(st.length / 2);
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < mono.length; i++) {
      mono[i] = (st[2 * i] + st[2 * i + 1]) / 2;
      peak = Math.max(peak, Math.abs(st[2 * i]), Math.abs(st[2 * i + 1]));
      if (Math.abs(st[2 * i]) >= 0.999 || Math.abs(st[2 * i + 1]) >= 0.999) clipped++;
    }
    return { mono, peak, clipped };
  };
  const rms = (x: Float32Array, a: number, b: number) => {
    let s = 0;
    const i0 = Math.round(a * 44100);
    const i1 = Math.min(x.length, Math.round(b * 44100));
    for (let i = i0; i < i1; i++) s += x[i] * x[i];
    return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-20);
  };
  const v = decode(voiceStem.wavPath).mono;
  const m = decode(musicStem.wavPath).mono;
  const full = decode(path.join(outDir, "podcast-con-musica.mp3"));
  const voiceStart = MIX.introSeconds;
  const voiceEnd = MIX.introSeconds + voiceStem.narrationSeconds;
  // Relación voz/música por minuto de narración.
  const ratios: number[] = [];
  for (let t = voiceStart + 5; t + 30 < voiceEnd; t += 60) ratios.push(Math.round((rms(v, t, t + 30) - rms(m, t, t + 30)) * 10) / 10);
  // Costuras: salto de nivel (ventanas de 100 ms) de la música justo en cada vuelta del bucle vs. el percentil 99 de todos los saltos.
  const win = (t: number) => rms(m, t, t + 0.1);
  const jumps: number[] = [];
  for (let t = voiceStart + 1; t + 0.2 < voiceEnd - 1; t += 0.1) jumps.push(Math.abs(win(t + 0.1) - win(t)));
  jumps.sort((a, b) => a - b);
  const p99 = jumps[Math.floor(jumps.length * 0.99)];
  const seamJumps: number[] = [];
  for (let k = 1; k * bed.loopSeconds < voiceEnd - 1; k++) {
    const t = k * bed.loopSeconds;
    if (t < voiceStart + 1) continue;
    seamJumps.push(Math.abs(win(t) - win(t - 0.1)));
  }

  // Extractos para escuchar (entrada y baja de la música, una vuelta del bucle, salida) y los cuatro fondos.
  const excerpt = (from: number, dur: number, name: string) =>
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(from), "-t", String(dur), "-i", path.join(outDir, "podcast-con-musica.mp3"), "-c", "copy", path.join(outDir, name)]);
  excerpt(0, 30, "extracto-entrada.mp3");
  excerpt(bed.loopSeconds * 3 - 10, 20, "extracto-vuelta-del-bucle.mp3");
  excerpt(Math.max(0, mixSeconds - 25), 25, "extracto-salida.mp3");
  for (const b of MUSIC_BEDS) {
    const wav = path.join(outDir, `${b.id}.wav`);
    await writeFile(wav, renderMusicBedWav(b));
    spawnSync("ffmpeg", ["-y", "-v", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "160k", path.join(outDir, `fondo-${b.id}.mp3`)]);
  }

  // Los stems y WAV intermedios pesan cientos de MB: fuera de la evidencia.
  const { rm } = await import("node:fs/promises");
  for (const f of ["stem-voz.wav", "stem-musica.wav", "fondo.wav", ...MUSIC_BEDS.map((b) => `${b.id}.wav`)]) await rm(path.join(outDir, f), { force: true });

  const summary = {
    nota: "Proveedor de voz SIMULADO (habla sintética, no voz real). Sin red ni gasto.",
    guion: { palabras: words, caracteres: characters, fragmentos: segments.length, estimacion: formatDurationRange(range), estimacion_segundos: range },
    ejecuciones: runs,
    sintesis: { llamadas: calls.length, fragmentos: segments.length, textos_unicos: uniqueTexts.size, repetidas_por_reintento_de_fallo_rechazado: repeated },
    narracion: { segundos: narrSeconds, esperado_segundos: Math.round(expectedNarr * 10) / 10, sonoridad: narrLoud, bytes: narration.length },
    mezcla: {
      segundos: mixSeconds,
      esperado_segundos: Math.round(mixTotalSeconds(narrSeconds) * 10) / 10,
      sonoridad: mixLoud,
      bytes: mix.length,
      pico_muestra: full.peak,
      muestras_recortadas: full.clipped,
      fondo: { id: bed.id, titulo: bed.title, licencia: bed.license },
      voz_sobre_musica_db_por_minuto: ratios,
      costuras_del_bucle_db: seamJumps.map((j) => Math.round(j * 100) / 100),
      salto_p99_db: Math.round(p99 * 100) / 100,
      silencio_final_db: Math.round(rms(full.mono, mixSeconds - 0.3, mixSeconds) * 10) / 10,
    },
    techo_storage_bytes: DEFAULT_MAX_OBJECT_BYTES,
    tiempos_locales_s: timings,
  };
  await writeFile(path.join(outDir, "resumen.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  const problems: string[] = [];
  if (calls.length !== segments.length + 1 || repeated !== 1) problems.push(`síntesis repetidas: ${calls.length} llamadas para ${segments.length} fragmentos (se esperaba solo la del fallo rechazado)`);
  if (Math.abs(narrSeconds - expectedNarr) > 1.5) problems.push(`duración de narración ${narrSeconds} vs ${expectedNarr}`);
  if (Math.abs(mixSeconds - mixTotalSeconds(narrSeconds)) > 0.5) problems.push(`duración de mezcla ${mixSeconds}`);
  if (narrLoud.truePeakDbtp > -1.5 || mixLoud.truePeakDbtp > -1.5) problems.push("pico real sobre −1,5 dBTP");
  if (Math.abs(narrLoud.integratedLufs + 19) > 0.5 || Math.abs(mixLoud.integratedLufs + 16) > 0.5) problems.push("sonoridad fuera de objetivo");
  if (full.clipped > 0) problems.push(`${full.clipped} muestras recortadas`);
  if (narration.length > DEFAULT_MAX_OBJECT_BYTES || mix.length > DEFAULT_MAX_OBJECT_BYTES) problems.push("archivo sobre el techo de Storage");
  if (ratios.some((r) => r < 15)) problems.push(`voz/música bajo 15 dB en algún minuto: ${ratios.join(", ")}`);
  if (seamJumps.some((j) => j > Math.max(p99, 1.5))) problems.push(`costura del bucle audible: ${seamJumps.join(", ")} (p99 ${p99})`);
  if (summary.mezcla.silencio_final_db > -45) problems.push("la salida no termina en silencio");
  if (problems.length) {
    console.error(`[podcast] PROBLEMAS:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("[podcast] validación local OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
