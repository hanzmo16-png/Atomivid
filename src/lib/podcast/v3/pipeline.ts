/**
 * Podcast 3.0 — orquestador de un episodio de estudio (modos A/B/C). Los proveedores se INYECTAN:
 *  - en pruebas/demos: simulados (mocks.ts), etiquetados «mock»;
 *  - en la app: adaptadores reales (adapters.ts) — ElevenLabs y HeyGen reutilizando el código existente,
 *    marcados «real adapter (untested live)» hasta una prueba real autorizada.
 * Garantías: estimación previa y autorización explícita; presupuesto máximo; una llamada de pago por clave
 * (reintentos reutilizan lo pagado); protección contra ejecuciones duplicadas; si la entrega falla, se liberan
 * reservas y el episodio no se cobra al usuario.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { ffmpeg, ffprobeDuration } from "./ffmpeg";
import { assembleVoice, exportAudio, mixAndMaster, transitionTimes, type TimelineEntry } from "./audio";
import { FPS, frameFor, muxEpisode, renderShot, shotFrames } from "./compose";
import { estimateEpisodeCost, opKey, paidOnce, releaseUndelivered, committedUsd, BudgetExceededError, UnauthorizedChargeError, type CostEstimate, type StudioLedger } from "./cost";
import { keywords, planEpisode, planIssues, type EditorialPlan, type VisualAsset } from "./editorial";
import { autoMood, ensureBundledMusic } from "./music-library";
import { estimateSeconds, narrationTurns, parseLabeledScript, type Turn } from "./script";
import type { Mood, StudioSpec } from "./spec";

export type ProviderLabel = "mock" | "real adapter (untested live)";
export type TtsProvider = { name: string; label: ProviderLabel; model: string; synth(text: string, voiceId: string, dest: string): Promise<{ actualUsd: number }>; usdFor(chars: number): number };
export type AvatarProvider = { name: string; label: ProviderLabel;
  /** Genera el clip con lip-sync a partir del audio del turno (HeyGen: foto/avatar + audio propio). */
  render(avatarRef: string, audioFile: string, seconds: number, dest: string, maxUsd: number): Promise<{ actualUsd: number }>;
  /** Fotograma fijo del avatar (sin costo): foto/preview del avatar. */
  still(avatarRef: string, dest: string): Promise<void>; usdFor(seconds: number): number;
  /**
   * Prepara un avatar desde foto (HeyGen: sube la foto como asset) y devuelve la referencia del proveedor. Pasa por el
   * libro de operaciones con su propia clave: un reintento reutiliza la referencia y no vuelve a subir/cobrar.
   */
  prepare?: (photoRef: string) => Promise<{ ref: string; actualUsd: number }>; prepareUsd?: number };
export type ImageProvider = { name: string; label: ProviderLabel; search(query: string): Promise<VisualAsset[]>; fetch(asset: VisualAsset, dest: string): Promise<void>;
  /** Recreación generada (de pago). Ausente → no se ofrecen recreaciones. */
  recreate?: (prompt: string, dest: string) => Promise<{ actualUsd: number }>; recreateUsd?: number };
/** Lo que el episodio necesita de cada proveedor antes de empezar (para verificar saldo sin gastar). */
export type ProviderNeeds = { ttsChars: number; ttsUsd: number; avatarUsd: number; imagesUsd: number };
export type Providers = { tts: TtsProvider; avatar: AvatarProvider; images: ImageProvider;
  /** Verificación GRATUITA previa (credenciales y saldo). Devuelve el motivo del bloqueo o null. Sin ella no se verifica saldo. */
  readiness?: (needs: ProviderNeeds) => Promise<string | null> };
export class ProviderNotReadyError extends Error { constructor(why: string) { super(`Proveedor no listo: ${why} No se hizo ningún cargo.`); this.name = "ProviderNotReadyError"; } }

export interface RunGuard { acquire(episode: string, token: string): Promise<boolean>; release(episode: string, token: string): Promise<void> }
export class MemoryRunGuard implements RunGuard {
  private m = new Map<string, string>();
  async acquire(e: string, t: string) { if (this.m.has(e)) return false; this.m.set(e, t); return true; }
  async release(e: string, t: string) { if (this.m.get(e) === t) this.m.delete(e); }
}
export class DuplicateRunError extends Error { constructor() { super("Ya hay una generación en curso para este episodio; no se inicia otra."); this.name = "DuplicateRunError"; } }

export type StudioTurns = { turns: Turn[]; names: Record<"A" | "B", string> };
/** Turnos según el modo: guion etiquetado (diálogo) o párrafos (narración/avatar; 2 voces alternan). */
export function turnsFor(spec: StudioSpec): StudioTurns {
  const names = { A: spec.participants[0]?.name ?? "A", B: spec.participants[1]?.name ?? "B" };
  if (spec.mode === "dialogo") {
    const p = parseLabeledScript(spec.script, names);
    if (!p) throw new Error("El guion de conversación necesita etiquetas de hablante (por ejemplo «Ana: …» y «Luis: …»).");
    return { turns: p.turns, names };
  }
  const labeled = spec.participants.length === 2 ? parseLabeledScript(spec.script, names) : null;
  return { turns: labeled?.turns ?? narrationTurns(spec.script, spec.participants.length === 2 ? 2 : 1), names };
}

export const INTRO_SECONDS = 3, OUTRO_SECONDS = 2.5;

/** Activos candidatos por turno (búsqueda deduplicada por consulta). */
export async function gatherAssets(turns: Turn[], images: ImageProvider, title: string, recreations: boolean): Promise<VisualAsset[]> {
  const seen = new Map<string, VisualAsset>();
  const queries = new Set<string>();
  for (const t of turns) { const kw = keywords(t.text).slice(0, 3); if (kw.length) queries.add(kw.join(" ")); }
  for (const q of queries) for (const a of await images.search(q).catch(() => [])) if (!seen.has(a.id)) seen.set(a.id, a);
  if (recreations && images.recreate) for (const t of turns.filter((x) => x.kind === "narracion" || x.kind === "respuesta").slice(0, 4)) {
    const kw = keywords(t.text).slice(0, 4);
    if (kw.length) seen.set(`rec-${t.id}`, { id: `rec-${t.id}`, query: `${title}: ${kw.join(" ")}`, kind: "recreacion", tags: kw });
  }
  return [...seen.values()];
}

export type Preflight = { turns: Turn[]; names: Record<"A" | "B", string>; plan: EditorialPlan; estimate: CostEstimate; mood: Mood; ttsChars: number; assets: VisualAsset[] };

/** Paso 9 del asistente: plan y costo ANTES de generar (sin llamadas de pago; búsqueda de imágenes gratuita). */
export async function preflight(spec: StudioSpec, providers: Providers): Promise<Preflight> {
  const { turns, names } = turnsFor(spec);
  const audioOnly = spec.output === "audio";
  const assets = audioOnly || spec.visual.provider === "solo_set" ? [] : await gatherAssets(turns, providers.images, spec.title, spec.visual.recreations);
  const plan = planEpisode({ mode: spec.mode, turns, assets, avatarFrequency: spec.mode === "narracion" ? 0 : spec.visual.avatar_frequency, avatarMaxSeconds: spec.visual.avatar_max_seconds,
    recreations: spec.visual.recreations, hasAvatar: { A: hasAvatar(spec, "A"), B: hasAvatar(spec, "B") }, introSeconds: INTRO_SECONDS });
  const ttsChars = turns.reduce((n, t) => n + t.text.length, 0);
  const seconds = INTRO_SECONDS + OUTRO_SECONDS + turns.reduce((n, t) => n + estimateSeconds(t.text) + 0.4, 0);
  const estimate = estimateEpisodeCost({ ttsChars, plan, recreationImages: plan.shots.filter((s) => s.kind === "recreacion").length, episodeSeconds: seconds,
    avatarCreations: spec.participants.filter((p) => p.avatar.kind === "foto").length, renderMinutesFactor: audioOnly ? 0.2 : undefined, audioOnly });
  const mood = spec.music.mood === "auto" ? autoMood(spec.script) : spec.music.mood;
  return { turns, names, plan, estimate, mood, ttsChars, assets };
}
const hasAvatar = (spec: StudioSpec, id: "A" | "B") => { const p = spec.participants.find((x) => x.id === id); return !!p && p.avatar.kind !== "ninguno"; };
const avatarRef = (spec: StudioSpec, id: "A" | "B") => { const a = spec.participants.find((x) => x.id === id)?.avatar; return a?.kind === "existente" ? a.avatar_id : a?.kind === "foto" ? `foto:${a.photo_path}` : ""; };

export type RunResult = {
  /** null en «solo audio»: no se renderiza video. */
  ok: true; mp4: string | null; audio: string; durationSeconds: number; lufs: number; truePeak: number; clipped: number; musicTrack: string | null; mood: Mood;
  plan: EditorialPlan; timeline: TimelineEntry[]; spentUsd: number; reusedOps: number; paidOps: number; providers: Record<string, ProviderLabel>; charged: true; shotFiles: string[];
};

export async function runEpisode(spec: StudioSpec, ctx: { owner: string; episode: string; dir: string; providers: Providers; ledger: StudioLedger; guard: RunGuard; authorizedUsd: number | null; small?: boolean; musicDir?: string; onProgress?: (stage: string, pct: number) => void }): Promise<RunResult> {
  const token = createHash("sha1").update(`${ctx.episode}:${Date.now()}:${Math.random()}`).digest("hex");
  if (!(await ctx.guard.acquire(ctx.episode, token))) throw new DuplicateRunError();
  const progress = ctx.onProgress ?? (() => {});
  try {
    await mkdir(ctx.dir, { recursive: true });
    const pf = await preflight(spec, ctx.providers);
    // Autorización explícita: el usuario aprobó un monto ≥ estimación; el tope efectivo es min(autorizado, presupuesto del episodio).
    const authorized = ctx.authorizedUsd != null && ctx.authorizedUsd + 1e-9 >= pf.estimate.totalUsd - pf.estimate.lines.find((l) => l.concept === "render")!.usd;
    const budget = Math.min(spec.budget_usd, ctx.authorizedUsd ?? 0);
    if (!authorized) throw new UnauthorizedChargeError();
    // Presupuesto previo: si lo estimado (sin el runner) no cabe en el tope efectivo, no se empieza (ningún cargo).
    const line = (c: string) => pf.estimate.lines.find((l) => l.concept === c)?.usd ?? 0;
    const providerUsd = Math.round((pf.estimate.totalUsd - line("render")) * 1e4) / 1e4;
    if (providerUsd > budget + 1e-9) throw new BudgetExceededError(providerUsd, budget);
    // Saldo/credenciales de los proveedores ANTES de la primera llamada de pago (verificación gratuita).
    if (ctx.providers.readiness) {
      const why = await ctx.providers.readiness({ ttsChars: pf.ttsChars, ttsUsd: line("voz"), avatarUsd: line("avatar"), imagesUsd: line("imagenes") });
      if (why) throw new ProviderNotReadyError(why);
    }
    let reused = 0, paid = 0;
    const pay = async (provider: string, op: string, payload: unknown, usd: number, call: () => Promise<{ result: string; actualUsd: number }>) => {
      const r = await paidOnce(ctx.ledger, { key: opKey({ owner: ctx.owner, episode: ctx.episode, provider, op, payload }), owner: ctx.owner, episode: ctx.episode, provider, op, usd, budgetUsd: budget, authorized }, call);
      if (r.reused) reused++; else paid++;
      return r.result;
    };
    // 0) Avatares desde foto: preparación idempotente (una vez por foto y episodio, registrada en el libro).
    const prepared: Partial<Record<"A" | "B", string>> = {};
    if (spec.output !== "audio") for (const p of spec.participants) {
      if (p.avatar.kind !== "foto" || !pf.plan.shots.some((s) => s.speaker === p.id && (s.kind === "avatar_a" || s.kind === "avatar_b" || s.kind === "two_shot" || s.kind === "over_shoulder"))) continue;
      const prepare = ctx.providers.avatar.prepare;
      if (!prepare) continue;
      const ref = avatarRef(spec, p.id);
      prepared[p.id] = await pay(ctx.providers.avatar.name, "avatar_prepare", { photo: ref }, ctx.providers.avatar.prepareUsd ?? 0, async () => { const r = await prepare(ref); return { result: r.ref, actualUsd: r.actualUsd }; });
    }
    // 1) Voz por turno (cada turno con la voz de su participante; las voces alternan según el guion).
    progress("voz", 5);
    const voiceOf = (s: "A" | "B") => spec.participants.find((p) => p.id === s)?.voice_id ?? spec.participants[0].voice_id;
    const turnAudio = [];
    for (const [i, t] of pf.turns.entries()) {
      const dest = path.join(ctx.dir, `tts-${t.id}.mp3`);
      const payload = { voice: voiceOf(t.speaker), model: ctx.providers.tts.model, text: t.text };
      const file = await pay(ctx.providers.tts.name, "tts", payload, ctx.providers.tts.usdFor(t.text.length), async () => { const r = await ctx.providers.tts.synth(t.text, payload.voice, dest); return { result: dest, actualUsd: r.actualUsd }; });
      turnAudio.push({ turn_id: t.id, speaker: t.speaker, file, pause_after: (i + 1) % 6 === 0 && i < pf.turns.length - 1 ? 1.2 : undefined });
      progress("voz", 5 + Math.round(30 * (i + 1) / pf.turns.length));
    }
    const voice = await assembleVoice(ctx.dir, turnAudio, INTRO_SECONDS, OUTRO_SECONDS);
    // 2) Plan definitivo con duraciones reales.
    const realTurns = pf.turns.map((t, i) => ({ ...t, seconds: (i + 1 < voice.timeline.length ? voice.timeline[i + 1].start : voice.duration) - voice.timeline[i].start }));
    const plan = planEpisode({ mode: spec.mode, turns: realTurns, assets: pf.assets, avatarFrequency: spec.mode === "narracion" ? 0 : spec.visual.avatar_frequency, avatarMaxSeconds: spec.visual.avatar_max_seconds,
      recreations: spec.visual.recreations, hasAvatar: { A: hasAvatar(spec, "A"), B: hasAvatar(spec, "B") }, introSeconds: voice.timeline[0]?.start ?? INTRO_SECONDS });
    const issues = planIssues(plan);
    if (issues.length) throw new Error(`Plan editorial inválido: ${issues.join("; ")}`);
    // 3) Música y master.
    progress("musica", 40);
    const musicDir = (await ensureBundledMusic(ctx.musicDir)).dir;
    const mix = await mixAndMaster(ctx.dir, voice.file, { musicDir, enabled: spec.music.enabled, mood: pf.mood, volumeDb: spec.music.volume_db, stings: spec.music.stings || spec.music.intro || spec.music.outro, ambient: spec.music.ambient, transitions: spec.music.stings ? transitionTimes(voice.timeline) : [], ducking: spec.music.ducking, intro: spec.music.intro, outro: spec.music.outro });
    const audioOut = path.join(ctx.dir, `episodio.${spec.audio_export}`);
    await exportAudio(mix.master, audioOut, spec.audio_export);
    if (spec.output === "audio") {
      // Solo audio: no se buscan ni descargan imágenes, no se renderizan planos ni se genera MP4.
      progress("listo", 100);
      return { ok: true, mp4: null, audio: audioOut, durationSeconds: await ffprobeDuration(audioOut), lufs: mix.lufs, truePeak: mix.truePeak, clipped: mix.clipped, musicTrack: mix.track?.file ?? null, mood: pf.mood, plan, timeline: voice.timeline,
        spentUsd: await committedUsd(ctx.ledger, ctx.episode), reusedOps: reused, paidOps: paid, charged: true, shotFiles: [],
        providers: { tts: ctx.providers.tts.label, avatar: ctx.providers.avatar.label, images: ctx.providers.images.label } };
    }
    // 4) Planos: avatar (de pago, por turno, recortado a la duración máxima), imágenes, recreaciones, composición.
    progress("video", 50);
    const fr = frameFor(spec.format, ctx.small);
    const frames = shotFrames(plan.shots, voice.duration);
    const stills: Partial<Record<"A" | "B", string>> = {};
    const stillFor = async (s: "A" | "B") => { if (!stills[s]) { const f = path.join(ctx.dir, `still-${s}.png`); await ctx.providers.avatar.still(avatarRef(spec, s), f); stills[s] = f; } return stills[s]!; };
    const clips: string[] = [];
    const turnText = new Map(pf.turns.map((t) => [t.id, t.text]));
    const turnLine = new Map(voice.timeline.map((e) => [e.turn_id, e]));
    for (const [i, shot] of plan.shots.entries()) {
      const src: Parameters<typeof renderShot>[4] = { title: spec.title, subtitle: spec.visual.subtitles && shot.turn_id ? turnText.get(shot.turn_id) ?? null : null };
      if (shot.kind === "avatar_a" || shot.kind === "avatar_b" || shot.kind === "two_shot" || shot.kind === "over_shoulder") {
        const sp = shot.speaker!;
        const line = turnLine.get(shot.turn_id!)!;
        const secs = Math.min(frames[i] / FPS, line.end - line.start + 0.5);
        // Audio del tramo (desde el máster de voz) → el proveedor anima exactamente esa voz: sincronía labial con el máster.
        const seg = path.join(ctx.dir, `avatar-audio-${i}.wav`);
        await ffmpeg(["-y", "-v", "error", "-ss", (shot.start).toFixed(3), "-t", secs.toFixed(3), "-i", voice.file, "-c:a", "pcm_s16le", seg]);
        const segHash = createHash("sha256").update(await readFile(seg)).digest("hex");
        const dest = path.join(ctx.dir, `avatar-${sp}-${i}.mp4`);
        const usd = ctx.providers.avatar.usdFor(secs);
        src.speakingClip = await pay(ctx.providers.avatar.name, "avatar_clip", { avatar: avatarRef(spec, sp), audio: segHash }, usd, async () => { const r = await ctx.providers.avatar.render(prepared[sp] ?? avatarRef(spec, sp), seg, secs, dest, usd); return { result: dest, actualUsd: r.actualUsd }; });
        if (shot.kind === "two_shot" || shot.kind === "over_shoulder") src.listenerStill = await stillFor(sp === "A" ? "B" : "A");
      } else if (shot.asset_id) {
        const asset = pf.assets.find((a) => a.id === shot.asset_id)!;
        const dest = path.join(ctx.dir, `img-${asset.id.replace(/[^\w-]/g, "_")}.png`);
        if (asset.kind === "recreacion" && ctx.providers.images.recreate) {
          src.image = await pay(ctx.providers.images.name, "recreacion", { prompt: asset.query }, ctx.providers.images.recreateUsd ?? 0, async () => { const r = await ctx.providers.images.recreate!(asset.query, dest); return { result: dest, actualUsd: r.actualUsd }; });
        } else { await ctx.providers.images.fetch(asset, dest); src.image = dest; }
      }
      clips.push(await renderShot(ctx.dir, i, shot, frames[i], src, { set: spec.visual.set, frame: fr, swap: spec.visual.swap_sides, small: !!ctx.small, fade: true }));
      progress("video", 50 + Math.round(45 * (i + 1) / plan.shots.length));
    }
    const mp4 = await muxEpisode(ctx.dir, clips, mix.master, path.join(ctx.dir, "episodio.mp4"), !!ctx.small);
    progress("listo", 100);
    const durationSeconds = await ffprobeDuration(mp4);
    return { ok: true, mp4, audio: audioOut, durationSeconds, lufs: mix.lufs, truePeak: mix.truePeak, clipped: mix.clipped, musicTrack: mix.track?.file ?? null, mood: pf.mood, plan, timeline: voice.timeline,
      spentUsd: await committedUsd(ctx.ledger, ctx.episode), reusedOps: reused, paidOps: paid, charged: true, shotFiles: clips,
      providers: { tts: ctx.providers.tts.label, avatar: ctx.providers.avatar.label, images: ctx.providers.images.label } };
  } catch (e) {
    // No entregado: se liberan reservas sin liquidar; el usuario no consume cuota (charged nunca es true aquí).
    await releaseUndelivered(ctx.ledger, ctx.episode);
    throw e;
  } finally {
    await ctx.guard.release(ctx.episode, token);
  }
}

/** Copia de seguridad del exporte (para evidencia). */
export const copyOut = (src: string, dest: string) => copyFile(src, dest);
