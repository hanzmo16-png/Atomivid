/**
 * Worker de Podcast 3.0 (estudio). Se ejecuta en el runner de podcast-video.yml con JOB_KIND=studio.
 * Proveedores REALES (adapters.ts, «real adapter (untested live)»); todo cargo pasa por el libro podcast_studio_operations
 * con tope = monto autorizado. Si falla: reservas liberadas, episodio «failed», sin cobro al usuario.
 */
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function runStudioJob(episodeId: string) {
  if (process.env.PODCAST_V3_ENABLED !== "1") { console.log("STUDIO_DISABLED"); return; }
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new Error("EPISODE_ID missing");
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const { STUDIO_TABLE, STUDIO_COLUMNS, supabaseStudioLedger, supabaseRunGuard } = await import("../../src/lib/podcast/v3/store");
  const { StudioSpec } = await import("../../src/lib/podcast/v3/spec");
  const { runEpisode } = await import("../../src/lib/podcast/v3/pipeline");
  const { realTts, realAvatar, realImages } = await import("../../src/lib/podcast/v3/adapters");
  const { searchScenePhotos } = await import("../../src/lib/ai/footage");
  const { downloadToFile } = await import("../../src/lib/podcast/visual-assets");
  const { heygenAvatarProvider } = await import("../../src/lib/providers/avatar/heygen");
  const service = createServiceClient();
  const BUCKET = "videos";
  const { data: row } = await service.from(STUDIO_TABLE).select(STUDIO_COLUMNS).eq("id", episodeId).single();
  if (!row || row.status !== "authorized") { console.log("STUDIO_NOT_AUTHORIZED"); return; }
  const spec = StudioSpec.parse(row.spec);
  const owner = row.user_id as string;
  const base = `${owner}/podcast-studio/${episodeId}`;
  const dir = path.join(os.tmpdir(), "studio", episodeId);
  await mkdir(dir, { recursive: true });
  const upload = async (p: string, file: string, type: string) => { const { error } = await service.storage.from(BUCKET).upload(p, await readFile(file), { contentType: type, upsert: true }); if (error) throw new Error("STORAGE"); return p; };
  // Avatares desde foto: se suben a HeyGen solo con consentimiento registrado en la especificación.
  const refs = new Map<string, string>();
  const avatarRow = async (id: string) => {
    const { data } = await service.from("avatars").select("provider_avatar_id,source_photo_path").eq("id", id).eq("user_id", owner).eq("status", "ready").maybeSingle();
    if (!data?.provider_avatar_id) throw new Error("AVATAR_NO_DISPONIBLE"); return data as { provider_avatar_id: string; source_photo_path: string | null };
  };
  const resolveRef = async (ref: string) => {
    if (!ref.startsWith("foto:")) return (await avatarRow(ref)).provider_avatar_id;
    if (refs.has(ref)) return refs.get(ref)!;
    const p = ref.slice(5);
    if (!p.startsWith(`${owner}/`)) throw new Error("FOTO_NO_PROPIA");
    const part = spec.participants.find((x) => x.avatar.kind === "foto" && x.avatar.photo_path === p);
    if (part?.avatar.kind !== "foto" || !part.avatar.consent.given) throw new Error("SIN_CONSENTIMIENTO");
    const { data } = await service.storage.from(BUCKET).download(p); if (!data) throw new Error("FOTO_NO_ENCONTRADA");
    const created = await heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.from(await data.arrayBuffer()), mimeType: p.endsWith(".png") ? "image/png" : "image/jpeg", consentGiven: true } as never);
    refs.set(ref, created.providerAvatarId); return created.providerAvatarId;
  };
  const avatar = realAvatar({
    publishAudio: async (file) => { const p = await upload(`${base}/avatar-audio/${path.basename(file)}`, file, "audio/wav"); const { data } = await service.storage.from(BUCKET).createSignedUrl(p, 3600); if (!data?.signedUrl) throw new Error("SIGN"); return data.signedUrl; },
    fetchStill: async (ref, dest) => { const p = ref.startsWith("foto:") ? ref.slice(5) : (await avatarRow(ref)).source_photo_path; if (!p || !p.startsWith(`${owner}/`)) throw new Error("Avatar sin foto fija disponible"); const { data } = await service.storage.from(BUCKET).download(p); if (!data) throw new Error("FOTO"); const { writeFile } = await import("node:fs/promises"); await writeFile(dest, Buffer.from(await data.arrayBuffer())); },
  });
  const wrapped = { ...avatar, render: async (ref: string, a: string, s: number, d: string, m: number) => avatar.render(await resolveRef(ref), a, s, d, m) };
  // Arnés E2E local: proveedores simulados (nunca en producción).
  const simulated = process.env.PODCAST_V3_PROVIDERS === "mock" && process.env.ATOMIVID_RUNTIME !== "production";
  const { mockProviders } = await import("../../src/lib/podcast/v3/mocks");
  const providers = simulated ? mockProviders() : { tts: realTts(spec.language), avatar: wrapped,
    images: realImages({ searchPhotos: async (q) => (await searchScenePhotos(q, spec.format === "9:16" ? "portrait" : "landscape", spec.language)).map((c) => ({ id: c.sourceId, url: c.url, credit: c.photographer })), download: downloadToFile }) };
  console.log("STUDIO_PROVIDERS", simulated ? "mock" : "real adapter (untested live)");
  const progress = (stage: string, pct: number) => { void service.from(STUDIO_TABLE).update({ progress: { stage, pct }, updated_at: new Date().toISOString() }).eq("id", episodeId); };
  try {
    const r = await runEpisode(spec, { owner, episode: episodeId, dir, providers, small: simulated, ledger: supabaseStudioLedger(service, owner), guard: supabaseRunGuard(service), authorizedUsd: Number(row.authorized_usd), onProgress: progress });
    const video = await upload(`${base}/episodio.mp4`, r.mp4, "video/mp4");
    const audio = await upload(`${base}/episodio.${spec.audio_export}`, r.audio, spec.audio_export === "mp3" ? "audio/mpeg" : "audio/wav");
    await service.from(STUDIO_TABLE).update({ status: "ready", video_path: video, audio_path: audio, cost_usd: r.spentUsd, progress: { stage: "listo", pct: 100 },
      result: { duration: r.durationSeconds, lufs: r.lufs, true_peak: r.truePeak, music: r.musicTrack, mood: r.mood, shots: r.plan.shots.map((s) => ({ kind: s.kind, start: s.start, end: s.end, label: s.label ?? null })), providers: r.providers }, error: null, updated_at: new Date().toISOString() }).eq("id", episodeId);
    console.log("STUDIO_READY", JSON.stringify({ usd: r.spentUsd, paid: r.paidOps, reused: r.reusedOps }));
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 400) : "Error";
    await service.from(STUDIO_TABLE).update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", episodeId);
    console.log("STUDIO_FAILED", e instanceof Error ? e.name : "unknown", e instanceof Error && "detail" in e ? String((e as { detail?: string }).detail ?? "").slice(0, 200) : "");
    throw e;
  }
}
