/**
 * Audio Podcast Studio — worker de render: voz por intervención (con caché), música por sección, mezcla con ducking y
 * máster a −16 LUFS / pico ≤ −1 dBTP, exporte MP3. Reutiliza sin modificar los motores de Podcast 3.0:
 * assembleVoice / mixAndMaster / exportAudio (audio.ts), ffmpeg/ffprobe/ebur128 (ffmpeg.ts) y la biblioteca CC0
 * (music-library.ts). Nunca toca tablas ni archivos de Premium: lee y escribe solo bajo audio-studio/v1/<dueño>/<proyecto>/.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleVoice, exportAudio, MASTER, mixAndMaster, type TurnAudio } from "@/lib/podcast/v3/audio";
import { ebur128, ffmpeg, ffprobeDuration } from "@/lib/podcast/v3/ffmpeg";
import { AMBIENT_FILES, BUNDLED_TRACKS, ensureBundledMusic, STINGS } from "@/lib/podcast/v3/music-library";
import type { Mood } from "@/lib/podcast/v3/spec";
import { musicPlan, scriptLines, type AudioProject, type AudioResult, type Generation, type MusicMood } from "./model";
import { assertBlobPath, projectDir, type BlobStore, type ProjectStore } from "./store";
import { segmentKey, settingsFor, type StudioVoice } from "./voice";

/** Ambiente del estudio → pista CC0 de la biblioteca propia. */
export const MOOD_TRACK: Record<MusicMood, Mood> = { calma: "relajante", reflexiva: "nostalgico", inspiradora: "inspirador", intensa: "tension" };
export const CROSSFADE_SECONDS = 2;
export const PAUSE = { sameVoice: 0.5, voiceChange: 0.35, section: 1.2 } as const;

export class RenderError extends Error { constructor(m: string) { super(m); this.name = "RenderError"; } }

export type RenderDeps = {
  store: ProjectStore & BlobStore; voice: StudioVoice; now?: () => string;
  /** Carpeta de la biblioteca musical generada (se reutiliza entre renders). */
  musicDir?: string;
  /** Pruebas: corta el render después de N intervenciones nuevas (simula una interrupción del proceso). */
  interruptAfter?: number;
};

/** Volumen de la música bajo la voz (0–60 %) → nivel de la cama en LUFS antes del ducking. */
export const musicLevelDb = (volume: number) => Math.max(-45, 20 * Math.log10(Math.max(volume, 1) / 100) - 14);

/** Pistas de la biblioteca con licencia comercial verificada; sin ellas no se musicaliza. */
export function licensedTrack(mood: MusicMood): (typeof BUNDLED_TRACKS)[number] {
  const t = BUNDLED_TRACKS.find((x) => x.mood === MOOD_TRACK[mood]);
  if (!t || t.license !== "CC0 1.0") throw new RenderError(`No hay una pista con licencia comercial verificada para el ambiente «${mood}»: no se musicaliza. Elige otro ambiente o «Sin música».`);
  return t;
}

export async function renderProject(deps: RenderDeps, ownerId: string, id: string): Promise<"terminada" | "fallida" | "omitida"> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { store, voice } = deps;
  const snap = await store.get(ownerId, id);
  if (!snap || (snap.generation.status !== "en_cola" && snap.generation.status !== "generando")) return "omitida";
  // Escritura de estado sin tocar el contenido ni la revisión (el editor está bloqueado mientras se genera).
  const patch = async (fn: (p: AudioProject) => Partial<AudioProject>) => {
    const cur = await store.get(ownerId, id);
    if (!cur) return;
    await store.put({ ...cur, ...fn(cur) });
  };
  const gen = (g: Partial<Generation>) => patch((p) => ({ generation: { ...p.generation, ...g, heartbeatAt: now() } }));
  const work = await mkdtemp(path.join(tmpdir(), "audio-studio-"));
  try {
    await gen({ status: "generando", startedAt: now(), error: null });
    const allowSynth = snap.generation.kind !== "remezclar";
    const auth = snap.generation.authorization;
    if (allowSynth && (!auth || auth.revision !== snap.revision)) throw new RenderError("La autorización de gasto no corresponde a esta versión del guion. Vuelve a autorizar. No se hizo ningún cargo.");
    // La autorización es para un modelo: nunca se usa con otro (un cambio de modelo exige autorizar de nuevo).
    if (allowSynth && auth!.model !== snap.ttsModel) throw new RenderError("La autorización de gasto es para otro modelo de voz. Vuelve a autorizar. No se hizo ningún cargo.");
    const provider = voice.provider(snap.ttsModel);
    const settings = settingsFor(snap.ttsModel);
    const lines = scriptLines(snap.script, snap.voiceCount);
    if (!lines.length) throw new RenderError("El guion no tiene texto para narrar.");
    const dir = projectDir(ownerId, id);
    const turns: TurnAudio[] = [];
    let reused = 0, fresh = 0;
    for (const [i, line] of lines.entries()) {
      const voiceId = voice.voiceIdFor(snap.voices[line.voice]);
      if (!voiceId) throw new RenderError("La voz elegida no está configurada en el proveedor. No se hizo ningún cargo.");
      const key = segmentKey(provider.name, snap.ttsModel, voiceId, line.text, settings);
      const blob = assertBlobPath(`${dir}/tts/${key}.mp3`, ownerId, id);
      const local = path.join(work, `seg-${String(i).padStart(4, "0")}.mp3`);
      const cached = await store.getBlob(blob);
      if (cached) { await writeFile(local, cached); reused++; }
      else {
        if (!allowSynth) throw new RenderError("La remezcla usa solo voz ya generada y falta una intervención (el guion o las voces cambiaron). Genera de nuevo para incluirla.");
        const cost = provider.usdFor(line.text.length);
        const before = auth!.spentBefore;
        const current = (await store.get(ownerId, id))?.spentUsd ?? snap.spentUsd;
        if (current - before + cost > auth!.usd + 1e-9) throw new RenderError(`Se alcanzó el gasto autorizado (USD ${auth!.usd.toFixed(2)}). No se hizo el cargo siguiente.`);
        const raw = path.join(work, `raw-${i}.wav`);
        let actual = 0;
        try { actual = (await provider.synth(line.text, voiceId, raw)).actualUsd; }
        catch (e) { throw new RenderError(`El proveedor de voz falló en la intervención ${i + 1}: ${(e as Error).message.slice(0, 160)} Lo ya generado queda guardado y no se volverá a cobrar.`); }
        await ffmpeg(["-y", "-v", "error", "-i", raw, "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k", local]);
        // Primero se guarda la voz y luego se suma el gasto: un reintento la encuentra en caché y no paga de nuevo.
        await store.putBlob(blob, await readFile(local), "audio/mpeg");
        fresh++;
        await patch((p) => ({ spentUsd: Math.round((p.spentUsd + actual) * 1e4) / 1e4, generation: { ...p.generation, providerCalls: p.generation.providerCalls + 1, charsSynthesized: p.generation.charsSynthesized + line.text.length, progress: { done: i + 1, total: lines.length }, heartbeatAt: now() } }));
        if (deps.interruptAfter !== undefined && fresh >= deps.interruptAfter) throw new Error("INTERRUPCION_SIMULADA");
      }
      const next = lines[i + 1];
      turns.push({ turn_id: String(i), speaker: line.voice === 0 ? "A" : "B", file: local,
        pause_after: !next ? 0 : next.section !== line.section ? PAUSE.section : next.voice !== line.voice ? PAUSE.voiceChange : PAUSE.sameVoice });
      if (i % 10 === 9) await gen({ progress: { done: i + 1, total: lines.length } });
    }
    await gen({ progress: { done: lines.length, total: lines.length } });

    const music = snap.music.mode !== "sin_musica";
    const voiceMix = await assembleVoice(work, turns, music && snap.music.intro ? 3 : 0.5, music && snap.music.outro ? 4 : 0.8);
    // La voz ya está unida: las piezas por intervención (mp3 de caché y wav normalizados) se borran del temporal.
    for (const f of await readdir(work)) if (/^(seg-\d+\.mp3|raw-\d+\.wav|turn-\d+\.wav|pause-\d+\.wav)$/.test(f)) await rm(path.join(work, f), { force: true });
    const tracks: string[] = [];
    let masterOut: { master: string; lufs: number; truePeak: number; clipped: number };
    if (music) {
      const plan = musicPlan(snap.script, snap.music);
      const lib = await ensureBundledMusic(deps.musicDir);
      // Inicio de cada sección = inicio de su primera intervención (la primera empieza en 0).
      const starts = plan.map((s) => { const k = lines.findIndex((l) => l.section === s.index); return k <= 0 ? 0 : voiceMix.timeline[k].start - 0.6; });
      const bounds = starts.map((st, k) => ({ start: st, end: k + 1 < starts.length ? starts[k + 1] : voiceMix.duration }));
      const bedDir = path.join(work, "bed");
      await rm(bedDir, { recursive: true, force: true });
      await mkdir(bedDir, { recursive: true });
      const parts: string[] = [];
      for (const [k, b] of bounds.entries()) {
        const t = licensedTrack(plan[k].mood);
        tracks.push(`${t.file} — «${t.title}» — ${t.license}`);
        const len = Math.max(1, b.end - b.start) + (k + 1 < bounds.length ? CROSSFADE_SECONDS : 0);
        const out = path.join(bedDir, `part-${k}.wav`);
        await ffmpeg(["-y", "-v", "error", "-stream_loop", "-1", "-i", path.join(lib.dir, t.file), "-t", len.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out]);
        parts.push(out);
      }
      // Cama continua: cada sección entra con un fundido cruzado de 2 s sobre la anterior.
      // Cada paso borra lo que ya no sirve: sin esto, un episodio de 18 min con 15 secciones acumulaba ~1,5 GB de camas
      // intermedias (en un disco pequeño el render fallaba por espacio).
      let bed = parts[0];
      for (let k = 1; k < parts.length; k++) {
        const out = path.join(bedDir, `chain-${k}.wav`);
        await ffmpeg(["-y", "-v", "error", "-i", bed, "-i", parts[k], "-filter_complex", `[0:a][1:a]acrossfade=d=${CROSSFADE_SECONDS}:c1=tri:c2=tri[a]`, "-map", "[a]", "-c:a", "pcm_s16le", out]);
        await rm(bed, { force: true });
        await rm(parts[k], { force: true });
        bed = out;
      }
      // mixAndMaster (Podcast 3.0) lee la cama como «pista documental» de su carpeta: se le da esta cama y las cortinas CC0.
      const mixDir = path.join(work, "mixlib");
      await mkdir(mixDir, { recursive: true });
      await symlink(bed, path.join(mixDir, BUNDLED_TRACKS.find((x) => x.mood === "documental")!.file));
      for (const f of [...Object.values(STINGS), ...Object.values(AMBIENT_FILES)]) await symlink(path.join(lib.dir, f), path.join(mixDir, f));
      masterOut = await mixAndMaster(work, voiceMix.file, { musicDir: mixDir, enabled: true, mood: "documental", volumeDb: musicLevelDb(snap.music.volume),
        stings: snap.music.intro || snap.music.outro, ambient: "ninguno", transitions: [], ducking: snap.music.ducking, intro: snap.music.intro, outro: snap.music.outro });
    } else {
      masterOut = await mixAndMaster(work, voiceMix.file, { musicDir: (await ensureBundledMusic(deps.musicDir)).dir, enabled: false, mood: "documental", volumeDb: -30, stings: false, ambient: "ninguno", transitions: [] });
    }
    const mp3 = path.join(work, "episodio.mp3");
    await exportAudio(masterOut.master, mp3, "mp3");
    const duration = await ffprobeDuration(mp3);
    const q = await ebur128(mp3);
    if (!(duration > 0) || Math.abs(q.lufs - MASTER.lufs) > 1.5 || q.truePeak > MASTER.truePeakMax || q.clipped > 0)
      throw new RenderError(`El control de calidad del MP3 falló (${q.lufs.toFixed(1)} LUFS, pico ${q.truePeak.toFixed(1)} dBTP). No se publicó el audio.`);
    const bytes = await readFile(mp3);
    const audioPath = assertBlobPath(`${dir}/audio/r${snap.revision}-${Date.parse(now())}.mp3`, ownerId, id);
    await store.putBlob(audioPath, bytes, "audio/mpeg");
    const audio: AudioResult = {
      path: audioPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: Math.round(duration * 10) / 10,
      lufs: Math.round(q.lufs * 10) / 10, truePeak: Math.round(q.truePeak * 10) / 10, revision: snap.revision, renderedAt: now(),
      provider: voice.mode, model: snap.ttsModel, segments: lines.length, reusedSegments: reused, musicTracks: [...new Set(tracks)],
    };
    await patch((p) => ({ audio, generation: { ...p.generation, status: "terminada", finishedAt: now(), heartbeatAt: now(), error: null, progress: { done: lines.length, total: lines.length } } }));
    return "terminada";
  } catch (e) {
    const message = e instanceof RenderError ? e.message
      : (e as Error).message === "INTERRUPCION_SIMULADA" ? "La generación se interrumpió. Pulsa «Reanudar»: lo ya generado no se vuelve a cobrar."
      : "La generación falló por un error técnico. Pulsa «Reanudar»: lo ya generado no se vuelve a cobrar.";
    if (!(e instanceof RenderError)) console.error("[audio-studio] render falló", (e as Error).message?.slice(0, 300));
    await gen({ status: "fallida", error: message, finishedAt: now() }).catch(() => {});
    return "fallida";
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
