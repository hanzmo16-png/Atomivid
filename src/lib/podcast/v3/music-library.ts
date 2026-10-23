/**
 * Podcast 3.0 — biblioteca musical PROPIA y procedural (CC0 1.0). Arregla el episodio real sin música: ya no depende
 * de PODCAST_MUSIC_DIR. Cada pista se sintetiza con ffmpeg (aevalsrc) a partir de parámetros fijos de este archivo
 * (acordes, pulso, timbre), de forma determinista; el resultado es obra original de Atomivid dedicada al dominio
 * público (ver assets/podcast-music/LICENSE.md). Sin descargas, sin red, sin costo.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Mood } from "./spec";
import { ffmpeg } from "./ffmpeg";

export const LIBRARY_VERSION = "atomivid-procedural-1";
export const LICENSE_TEXT = "CC0 1.0 Universal (dominio público) — composición procedural original de Atomivid";
export type BundledTrack = { file: string; title: string; mood: Mood; license: "CC0 1.0"; author: "Atomivid (procedural)"; root: number; chords: number[][]; bpm: number; pulse: number; bright: number };

const T = (mood: Mood, title: string, root: number, chords: number[][], bpm: number, pulse: number, bright: number): BundledTrack =>
  ({ file: `atomivid-${mood}.wav`, title, mood, license: "CC0 1.0", author: "Atomivid (procedural)", root, chords, bpm, pulse, bright });

/** Progresiones en semitonos sobre la raíz (Hz). Menor/modal para misterio/suspenso; mayor para inspirador/relajante. */
export const BUNDLED_TRACKS: BundledTrack[] = [
  T("misterio", "Señales lejanas", 110, [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [-5, -1, 2]], 0, 0, 0.25),
  T("suspenso", "Cuenta regresiva", 98, [[0, 3, 7], [1, 4, 8], [0, 3, 7], [-1, 3, 6]], 96, 0.5, 0.2),
  T("epico", "Horizonte", 87.3, [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]], 120, 0.8, 0.45),
  T("documental", "Archivo abierto", 130.8, [[0, 4, 7], [-3, 0, 4], [-5, -1, 2], [-7, -3, 0]], 0, 0, 0.3),
  T("relajante", "Marea tranquila", 146.8, [[0, 4, 7, 11], [-3, 0, 4, 7], [-7, -3, 0, 4], [-5, -1, 2, 5]], 0, 0, 0.15),
  T("inspirador", "Primer paso", 130.8, [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], 100, 0.35, 0.4),
  T("tension", "Pulso bajo", 82.4, [[0, 1, 7], [0, 3, 6], [0, 1, 7], [-1, 2, 6]], 132, 0.9, 0.2),
  T("nostalgico", "Fotografías", 123.5, [[0, 3, 7, 10], [-4, 0, 3, 7], [-7, -4, 0, 3], [-2, 2, 5, 9]], 0, 0, 0.2),
];
export const SECTION_SECONDS = 8;
export const LOOP_SECONDS = SECTION_SECONDS * 4;

const f = (n: number) => n.toFixed(4);
/** Expresión aevalsrc de la pista (bucle perfecto de LOOP_SECONDS). */
export function trackExpression(tr: BundledTrack): string {
  const S = SECTION_SECONDS;
  const env = `min(1,mod(t,${S})/1.2)*min(1,(${S}-mod(t,${S}))/1.2)`;
  const parts = tr.chords.map((ch, k) => {
    const gate = `between(mod(t,${LOOP_SECONDS}),${k * S},${(k + 1) * S - 0.0001})`;
    const notes = ch.map((st) => { const hz = tr.root * Math.pow(2, st / 12); return `sin(2*PI*${f(hz)}*t)+${f(tr.bright)}*sin(4*PI*${f(hz)}*t)+${f(tr.bright / 3)}*sin(6*PI*${f(hz * 1.002)}*t)`; }).join("+");
    return `${gate}*(${notes})`;
  }).join("+");
  const lfo = "(0.75+0.25*sin(2*PI*0.125*t))";
  const pulse = tr.bpm > 0 ? `+${f(tr.pulse)}*sin(2*PI*${f(tr.root / 2)}*t)*exp(-7*mod(t,${f(60 / tr.bpm)}))` : "";
  return `0.08*(${env}*${lfo}*(${parts})${pulse})`;
}

export const STINGS = { intro: "sting-intro.wav", transicion: "sting-transicion.wav" } as const;
export const AMBIENT_FILES = { lluvia: "amb-lluvia.wav", viento: "amb-viento.wav", noche: "amb-noche.wav" } as const;

let pending: Promise<{ dir: string; tracks: BundledTrack[] }> | null = null;
/** Genera (una vez por proceso/directorio) las pistas, cortinas y ambientes en `dir` y escribe LICENSES.md. */
export function ensureBundledMusic(dir = path.join(tmpdir(), LIBRARY_VERSION)): Promise<{ dir: string; tracks: BundledTrack[] }> {
  if (pending && dir === path.join(tmpdir(), LIBRARY_VERSION)) return pending;
  const p = (async () => {
    await mkdir(dir, { recursive: true });
    const make = async (file: string, args: string[]) => {
      const out = path.join(dir, file);
      if (existsSync(out)) return;
      const tmp = out + `.tmp-${process.pid}.wav`;
      await ffmpeg(["-y", "-v", "error", ...args, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", tmp]);
      await rename(tmp, out);
    };
    for (const tr of BUNDLED_TRACKS)
      await make(tr.file, ["-f", "lavfi", "-i", `aevalsrc='${trackExpression(tr)}':s=48000:d=${LOOP_SECONDS}`, "-af", "lowpass=f=3200,aecho=0.8:0.6:90|170:0.22|0.12,loudnorm=I=-20:TP=-3:LRA=7"]);
    await make(STINGS.intro, ["-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*(110+220*t)*t)*exp(-1.6*t)+0.3*sin(2*PI*55*t)*exp(-3*t)':s=48000:d=2.2", "-af", "afade=t=out:st=1.6:d=0.6,aecho=0.8:0.5:120:0.3,loudnorm=I=-20:TP=-3"]);
    await make(STINGS.transicion, ["-f", "lavfi", "-i", "anoisesrc=d=1.2:c=pink:a=0.4:s=48000", "-af", "highpass=f=400,lowpass=f=5000,afade=t=in:d=0.5,afade=t=out:st=0.6:d=0.6,loudnorm=I=-24:TP=-6"]);
    await make(AMBIENT_FILES.lluvia, ["-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:a=0.3:s=48000:seed=7", "-af", "highpass=f=800,lowpass=f=9000,loudnorm=I=-30:TP=-8"]);
    await make(AMBIENT_FILES.viento, ["-f", "lavfi", "-i", "anoisesrc=d=20:c=brown:a=0.4:s=48000:seed=11", "-af", "lowpass=f=600,volume='0.6+0.4*sin(2*PI*0.08*t)':eval=frame,loudnorm=I=-30:TP=-8"]);
    await make(AMBIENT_FILES.noche, ["-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*4200*t)*gt(sin(2*PI*1.3*t)\\,0.9)+0.1*sin(2*PI*90*t)':s=48000:d=20", "-af", "volume=-22dB"]);
    await writeFile(path.join(dir, "LICENSES.md"), licenseManifest());
    return { dir, tracks: BUNDLED_TRACKS };
  })();
  if (dir === path.join(tmpdir(), LIBRARY_VERSION)) { pending = p; p.catch(() => { pending = null; }); }
  return p;
}

export function licenseManifest(): string {
  return [`# Biblioteca musical ${LIBRARY_VERSION}`, "", `Licencia: ${LICENSE_TEXT}.`, "Generada por src/lib/podcast/v3/music-library.ts (sin muestras de terceros).", "",
    ...BUNDLED_TRACKS.map((t) => `- ${t.file} — «${t.title}» (${t.mood}) — ${t.author} — ${t.license}`),
    ...Object.values(STINGS).map((s) => `- ${s} — cortina — Atomivid (procedural) — CC0 1.0`),
    ...Object.values(AMBIENT_FILES).map((s) => `- ${s} — ambiente — Atomivid (procedural) — CC0 1.0`), ""].join("\n");
}

export const trackFor = (mood: Mood) => BUNDLED_TRACKS.find((t) => t.mood === mood) ?? BUNDLED_TRACKS[3];

/** Ambiente automático por contenido del guion (determinista). */
export function autoMood(text: string): Mood {
  const s = text.toLowerCase();
  const score: Record<Mood, number> = { misterio: 0, suspenso: 0, epico: 0, documental: 1, relajante: 0, inspirador: 0, tension: 0, nostalgico: 0 };
  const add = (m: Mood, re: RegExp) => { score[m] += (s.match(re) ?? []).length; };
  add("misterio", /misterio|enigma|señal|inexplicable|desconocid|ovni|extraterrest|oculto/g);
  add("suspenso", /de repente|silencio|sombra|nadie sab|esperaba|tiempo se agota/g);
  add("epico", /batalla|imperio|héroe|conquista|gigante|histórico|legend/g);
  add("relajante", /calma|tranquil|respira|naturaleza|descanso/g);
  add("inspirador", /logr|sueño|superar|futuro|esperanza|emprend/g);
  add("tension", /peligro|amenaza|crisis|urgente|ataque/g);
  add("nostalgico", /recuerd|infancia|antes|aquellos años|memoria/g);
  return (Object.entries(score) as [Mood, number][]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** Puente con Podcast 2.x (narrate-v2): moods del director emocional → pistas propias. Mismo tipo MusicTrack. */
export const V2_MOOD_MAP: Record<"calm" | "suspense" | "revelation" | "reflection" | "enthusiasm", Mood> = { calm: "documental", suspense: "suspenso", revelation: "misterio", reflection: "nostalgico", enthusiasm: "inspirador" };
