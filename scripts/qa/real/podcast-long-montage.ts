/**
 * Montaje de un episodio LARGO (~30 min) del estudio con proveedores SIMULADOS (USD 0) y ffmpeg real a resolución
 * completa (small=false), en el mismo tipo de runner que el worker (ubuntu-latest). Valida montaje y límites, NO la
 * calidad de proveedores reales: duración del MP4/MP3, tamaño, tiempo de render frente al timeout del worker (185 min),
 * memoria, planos congelados ≥ 2 s, continuidad del audio y la estimación de costo real que la app mostraría (tarifas reales).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runEpisode, preflight, MemoryRunGuard } from "../../../src/lib/podcast/v3/pipeline";
import { MemoryLedger } from "../../../src/lib/podcast/v3/cost";
import { mockProviders } from "../../../src/lib/podcast/v3/mocks";
import { StudioSpec, STUDIO_VERSION } from "../../../src/lib/podcast/v3/spec";

const MIN = Number(process.env.LONG_MINUTES || 30);
const OUT = path.resolve(process.env.OUT_DIR || "podcast-long-out");
const A = [
  "Valeria, empecemos por lo básico: ¿qué sabemos con certeza sobre este fenómeno?",
  "¿Y cómo se comprobó eso? Quiero entender qué observaciones lo sostienen.",
  "Me sorprende. ¿Hay alguna explicación alternativa que todavía se discuta?",
  "Pasemos al siguiente punto, porque hay una pregunta que nos dejan mucho los oyentes.",
];
const B = [
  "Lo que sabemos con certeza viene de mediciones repetidas por equipos independientes durante varios años, y los datos coinciden en lo esencial.",
  "Se comprobó comparando registros de distintos observatorios, con instrumentos diferentes, y descartando errores de calibración uno por uno.",
  "Sí, hay hipótesis alternativas razonables, y es honesto decir que ninguna explica todos los detalles; por eso la investigación sigue abierta.",
  "Es una gran pregunta, y la respuesta corta es que todavía no lo sabemos, pero hay misiones en marcha que podrían darnos pistas pronto.",
];
// ~15 caracteres/s (la misma regla de duración del TTS simulado): se agregan turnos hasta cubrir MIN minutos.
const lines: string[] = []; let chars = 0, i = 0;
while (chars / 15 < MIN * 60) { const a = `Hans: (${i + 1}) ${A[i % 4]}`, b = `Valeria: ${B[i % 4]}`; lines.push(a, b); chars += a.length + b.length; i++; }
const spec = StudioSpec.parse({ version: STUDIO_VERSION, language: "es", format: "16:9", audio_export: "mp3", budget_usd: 50, mode: "dialogo",
  title: "Prueba de montaje largo (simulada)", topic: "montaje largo", target_minutes: MIN, script: lines.join("\n"),
  participants: [{ id: "A", name: "Hans", voice_id: "voiceHansSim01", avatar: { kind: "existente", avatar_id: "avatar-hans-sim" } },
    { id: "B", name: "Valeria", voice_id: "voiceValeriaSim", avatar: { kind: "existente", avatar_id: "avatar-valeria-sim" } }],
  visual: { set: "biblioteca", subtitles: true, avatar_frequency: 0.8, avatar_max_seconds: 10, recreations: true, swap_sides: false },
  music: { enabled: true, mood: "auto", volume_db: -22, stings: true, ambient: "ninguno" } });

async function main() {
  const providers = mockProviders();
  const pf = await preflight(spec, providers);
  const stages: Record<string, number> = {}; const t0 = Date.now();
  const r = await runEpisode(spec, { owner: "owner-sim", episode: "long-sim", dir: OUT, providers, ledger: new MemoryLedger(), guard: new MemoryRunGuard(),
    authorizedUsd: 50, small: false, onProgress: (s) => { stages[s] ??= Math.round((Date.now() - t0) / 1000); } });
  const secs = Math.round((Date.now() - t0) / 1000);
  const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", f]).toString());
  const fr = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", r.mp4!, "-vf", "freezedetect=n=0.003:d=2", "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const frozen = [...fr.matchAll(/freeze_duration: ([\d.]+)/g)].map((x) => Number(x[1]));
  const sil = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", r.audio, "-af", "silencedetect=n=-45dB:d=3", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const silences = (sil.match(/silence_start/g) || []).length;
  const shots = r.plan.shots ?? [];
  const kinds = shots.reduce((a: Record<string, number>, s: { kind?: string; type?: string }) => { const k = String(s.kind ?? s.type ?? "?"); a[k] = (a[k] || 0) + 1; return a; }, {});
  const facts = {
    targetMinutes: MIN, turns: lines.length, chars, renderSeconds: secs, workerTimeoutSeconds: 185 * 60, stages,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    mp4: { ...probe(r.mp4!).format, streams: probe(r.mp4!).streams, mb: Math.round(statSync(r.mp4!).size / 1e5) / 10 },
    mp3: { ...probe(r.audio).format, mb: Math.round(statSync(r.audio).size / 1e5) / 10 },
    durationSeconds: r.durationSeconds, lufs: r.lufs, truePeak: r.truePeak, clipped: r.clipped, music: r.musicTrack,
    shots: shots.length, shotKinds: kinds, frozenSegments: frozen.length, frozenMaxS: frozen.length ? Math.max(...frozen) : 0, longSilences: silences,
    estimateRealRatesUsd: pf.estimate.totalUsd, estimateLines: pf.estimate.lines, simulatedSpendUsd: r.spentUsd, paidOps: r.paidOps,
  };
  writeFileSync(path.join(OUT, "facts.json"), JSON.stringify(facts, null, 1));
  console.log("FACTS", JSON.stringify(facts));
  const checks: [string, boolean][] = [
    [`duration ≥ ${MIN - 2} min`, r.durationSeconds >= (MIN - 2) * 60],
    ["render within the worker timeout with ≥ 50 % margin", secs < 185 * 60 * 0.5],
    ["mp4 1920x1080 video + aac audio", facts.mp4.streams.some((s: { codec_type: string; width?: number }) => s.codec_type === "video" && s.width === 1920) && facts.mp4.streams.some((s: { codec_type: string; codec_name: string }) => s.codec_type === "audio" && s.codec_name === "aac")],
    ["mp3 duration ≈ mp4 duration (±2 s)", Math.abs(Number(facts.mp3.duration) - Number(facts.mp4.duration)) <= 2],
    ["loudness near −16 LUFS (±2), no clipping", Math.abs(r.lufs + 16) <= 2 && r.clipped === 0],
    ["no long silences (≥ 3 s) in the audio", silences === 0],
    ["estimate ≤ studio max authorization (USD 50)", pf.estimate.totalUsd <= 50],
  ];
  for (const [n, c] of checks) console.log(`${c ? "PASS" : "FAIL"} ${n}`);
  console.log(`INFO frozen video segments ≥ 2 s: ${frozen.length} (max ${facts.frozenMaxS} s) — simulated stills/plates; judged with the real-provider sample`);
  const f = checks.filter(([, c]) => !c).length; console.log(`RESULT podcast-long-montage: ${f} FAIL`); process.exitCode = f ? 1 : 0;
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
