/**
 * Worker de Podcast 3.0 (estudio). Se ejecuta en el runner de podcast-video.yml con JOB_KIND=studio.
 * Proveedores REALES (adapters.ts, «real adapter (untested live)»); todo cargo pasa por el libro podcast_studio_operations
 * con tope = monto autorizado. Si falla: reservas liberadas, episodio «failed», sin cobro al usuario.
 */
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Mismo interruptor que la app: PODCAST_V3_ENABLED=1, o el piloto del dueño (PODCAST_V3_OWNER_PILOT=0 lo apaga) para
 *  episodios del dueño, verificado aquí de forma independiente: por PODCAST_V3_OWNER_USER_ID (secreto
 *  INTERNAL_PRODUCTION_OWNER_USER_ID, si existe en GitHub) o, si no, preguntando a la app con una petición firmada (la app
 *  sí conoce al dueño). Cualquier otra cuenta, error o falta de respuesta: no se genera ni se cobra. */
export async function studioWorkerEnabled(episodeId: string, env: Record<string, string | undefined> = process.env,
  deps: { ownerOf?: (id: string) => Promise<string | null>; askApp?: (userId: string) => Promise<boolean> } = {}): Promise<boolean> {
  if (env.PODCAST_V3_ENABLED === "1") return true;
  if (env.PODCAST_V3_OWNER_PILOT === "0" || !/^[0-9a-f-]{36}$/i.test(episodeId)) return false;
  const ownerId = env.PODCAST_V3_OWNER_USER_ID?.trim().toLowerCase();
  if (ownerId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ownerId)) return false;
  const read = deps.ownerOf ?? (async (id: string) => {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
    const { createServiceClient } = await import("../../src/lib/supabase/service");
    const { data } = await createServiceClient().from("podcast_studio_episodes").select("user_id").eq("id", id).maybeSingle();
    return (data as { user_id?: string } | null)?.user_id ?? null;
  });
  const uid = (await read(episodeId))?.toLowerCase();
  if (!uid) return false;
  if (ownerId) return uid === ownerId;
  const ask = deps.askApp ?? (async (u: string) => (await import("../../src/lib/podcast/v3/owner-check")).askAppIsStudioOwner(u, env));
  return ask(uid);
}

export async function runStudioJob(episodeId: string) {
  if (!(await studioWorkerEnabled(episodeId))) {
    // App y worker desalineados (la app autorizó, el worker no tiene el interruptor): no se genera NI se cobra, y el
    // episodio no queda «autorizado» para siempre: pasa a «failed» con el motivo (se puede reintentar al alinear).
    console.log("STUDIO_DISABLED");
    if (/^[0-9a-f-]{36}$/i.test(episodeId) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { createServiceClient } = await import("../../src/lib/supabase/service");
      await createServiceClient().from("podcast_studio_episodes").update({ status: "failed", error: "El estudio no está activado en el generador para esta cuenta (interruptor o piloto del dueño). No se hizo ningún cargo.", updated_at: new Date().toISOString() }).eq("id", episodeId).eq("status", "authorized");
    }
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new Error("EPISODE_ID missing");
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const { STUDIO_TABLE, STUDIO_OPS_TABLE, STUDIO_COLUMNS, supabaseStudioLedger, supabaseRunGuard } = await import("../../src/lib/podcast/v3/store");
  const { StudioSpec } = await import("../../src/lib/podcast/v3/spec");
  const { runEpisode, studioRunErrorFailsEpisode } = await import("../../src/lib/podcast/v3/pipeline");
  const { lipTimeline, lipViolations, shotCoverage } = await import("../../src/lib/podcast/v3/studio");
  const { realTts, realAvatar, realRecraftImages, realDirector, realMatter, RVM_MODEL } = await import("../../src/lib/podcast/v3/adapters");
  const { progressRecord, stagesFor } = await import("../../src/lib/podcast/v3/progress");
  const { heygenAvatarProvider } = await import("../../src/lib/providers/avatar/heygen");
  const { stillSource } = await import("../../src/lib/podcast/v3/still-source");
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
  // Avatares desde foto: se suben a HeyGen solo con consentimiento registrado en la especificación. La subida va por
  // AvatarProvider.prepare → libro de operaciones (op «avatar_prepare»): un reintento reutiliza la referencia guardada.
  const avatarRow = async (id: string) => {
    const { data } = await service.from("avatars").select("provider_avatar_id,source_photo_path").eq("id", id).eq("user_id", owner).eq("status", "ready").maybeSingle();
    if (!data?.provider_avatar_id) throw new Error("AVATAR_NO_DISPONIBLE"); return data as { provider_avatar_id: string; source_photo_path: string | null };
  };
  const { catalogHost } = await import("../../src/lib/podcast/v3/catalog");
  const resolveRef = async (ref: string) => {
    if (ref.startsWith("asset:")) return ref; // foto ya preparada (referencia del libro)
    if (ref.startsWith("foto:") || ref.startsWith("catalogo:")) throw new Error("AVATAR_FOTO_NO_PREPARADO");
    return (await avatarRow(ref)).provider_avatar_id;
  };
  const preparePhoto = async (ref: string) => {
    if (ref.startsWith("catalogo:")) {
      // Anfitrión del catálogo: su asset de HeyGen si ya existe (Valeria, identidad exacta); si no, su foto del catálogo.
      const host = catalogHost(ref.slice(9));
      if (!host) throw new Error("ANFITRION_DESCONOCIDO");
      if (host.heygenAsset) return { ref: host.heygenAsset, actualUsd: 0 };
      const { data } = await service.storage.from(BUCKET).download(host.photo); if (!data) throw new Error("FOTO_CATALOGO_NO_ENCONTRADA");
      const created = await heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.from(await data.arrayBuffer()), mimeType: "image/jpeg", consentGiven: true } as never);
      return { ref: created.providerAvatarId, actualUsd: 0 };
    }
    if (!ref.startsWith("foto:")) throw new Error("FOTO_REF");
    const p = ref.slice(5);
    if (!p.startsWith(`${owner}/`)) throw new Error("FOTO_NO_PROPIA");
    const part = spec.participants.find((x) => x.avatar.kind === "foto" && x.avatar.photo_path === p);
    if (part?.avatar.kind !== "foto" || !part.avatar.consent.given) throw new Error("SIN_CONSENTIMIENTO");
    const { data } = await service.storage.from(BUCKET).download(p); if (!data) throw new Error("FOTO_NO_ENCONTRADA");
    const created = await heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.from(await data.arrayBuffer()), mimeType: p.endsWith(".png") ? "image/png" : "image/jpeg", consentGiven: true } as never);
    return { ref: created.providerAvatarId, actualUsd: 0 };
  };
  // Misma fuente que fetchStill (bucket y ruta del dueño); lectura gratuita antes de cualquier cargo.
  const stillOf = async (ref: string) => {
    if (ref.startsWith("catalogo:")) { const host = catalogHost(ref.slice(9)); if (!host) throw new Error("ANFITRION_DESCONOCIDO"); return { bucket: BUCKET, path: host.photo }; }
    return stillSource(owner, ref, ref.startsWith("foto:") ? null : (await avatarRow(ref)).source_photo_path);
  };
  const avatar = realAvatar({
    checkStill: async (ref) => { const src = await stillOf(ref); const { data } = await service.storage.from(src.bucket).download(src.path); return !!data; },
    publishAudio: async (file) => { const p = await upload(`${base}/avatar-audio/${path.basename(file)}`, file, "audio/wav"); const { data } = await service.storage.from(BUCKET).createSignedUrl(p, 3600); if (!data?.signedUrl) throw new Error("SIGN"); return data.signedUrl; },
    fetchStill: async (ref, dest) => {
      // Wizard photo → «videos»; existing avatar → «avatar-uploads» (see still-source.ts). Owner-only path either way.
      const src = await stillOf(ref);
      const { data } = await service.storage.from(src.bucket).download(src.path); if (!data) throw new Error("FOTO");
      const { writeFile } = await import("node:fs/promises"); await writeFile(dest, Buffer.from(await data.arrayBuffer()));
    },
  });
  const wrapped = { ...avatar, prepare: preparePhoto, prepareUsd: 0, render: async (ref: string, a: string, s: number, d: string, m: number) => avatar.render(await resolveRef(ref), a, s, d, m) };
  // Saldo verificado ANTES de cualquier cargo (GET de facturación gratuitos; nunca generación).
  // Misma regla de producción que el resto de Atomicvid (saldo verificado + topes diarios/mensuales por proveedor y
  // global), ANTES de cualquier cargo. Lo que el estudio gastó en 24 h se suma a la demanda (su libro no está en pi_*).
  const readiness = async (needs: import("../../src/lib/podcast/v3/pipeline").ProviderNeeds) => {
    const [{ ensureJobSupplyReady }, { studioSupplyDemands, studioSpendByProvider, unsupportedSpend }] = await Promise.all([import("../../src/lib/supply/readiness"), import("../../src/lib/podcast/v3/readiness")]);
    const blocked = unsupportedSpend(needs, true); if (blocked) return blocked;
    const { data: recent, error: recentError } = await service.from(STUDIO_OPS_TABLE).select("provider,state,reserved_usd,actual_usd").gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
    if (recentError) return "No se pudo leer el gasto reciente del estudio.";
    const demands = studioSupplyDemands(needs, studioSpendByProvider(recent ?? []));
    if (!demands.length) return null;
    const r = await ensureJobSupplyReady(service, demands);
    console.log("STUDIO_READINESS", JSON.stringify({ demands, ready: r.ready, failure: r.failure ?? null, providers: r.providers.map((p) => ({ p: p.provider, level: p.level, free: p.free, ok: p.ok, failure: p.failure ?? null })) }));
    return r.ready ? null : `${r.failure?.provider ?? "proveedor"}: ${r.failure?.reason ?? "no disponible"}`;
  };
  // Arnés E2E local: proveedores simulados (nunca en producción).
  const simulated = process.env.PODCAST_V3_PROVIDERS === "mock" && process.env.ATOMIVID_RUNTIME !== "production";
  const { mockProviders } = await import("../../src/lib/podcast/v3/mocks");
  // Una sola fuente de tarifas: las de la estimación que el usuario autorizó (guardada con el episodio).
  const est = (row.estimate ?? {}) as { rates?: { voiceUsdPer1kChars?: number } };
  const voiceRate = Number(est.rates?.voiceUsdPer1kChars);
  const rates = Number.isFinite(voiceRate) && voiceRate > 0 ? { voiceUsdPer1kChars: voiceRate } : undefined;
  console.log("STUDIO_RATES", JSON.stringify(rates ?? { source: "config" }));
  // Lo pagado se guarda en Storage (privado, carpeta del dueño): un reintento en otro runner lo reutiliza sin pagar.
  const artifacts = {
    async put(key: string, local: string) { const p = `${base}/paid/${key.slice(0, 32)}${path.extname(local) || ".bin"}`; await upload(p, local, local.endsWith(".mp4") ? "video/mp4" : local.endsWith(".png") ? "image/png" : "audio/mpeg"); return `storage:${p}`; },
    async get(ref: string, dest: string) {
      const p = ref.replace(/^storage:/, "");
      if (!ref.startsWith("storage:") || !p.startsWith(`${base}/paid/`)) throw new Error("ARTEFACTO_AJENO");
      const { data } = await service.storage.from(BUCKET).download(p); if (!data) throw new Error("ARTEFACTO_NO_ENCONTRADO");
      const { writeFile } = await import("node:fs/promises"); await writeFile(dest, Buffer.from(await data.arrayBuffer()));
    },
  };
  // Arnés: inyección de un rechazo (sin cargo) en la N-ésima voz; solo con proveedores simulados, nunca en producción.
  const rejectTtsCall = Number(process.env.PODCAST_V3_MOCK_TTS_REJECT_CALL || 0);
  // Referencias del estilo de las ilustraciones (public/podcast/estilo/, sin personas): se suben a la carpeta del catálogo
  // y se firman; Recraft solo acepta URLs HTTPS. Solo se usan si el episodio todavía no tiene un estilo creado.
  const styleRefs = async () => {
    const dirRef = path.resolve("public/podcast/estilo");
    const { readdir } = await import("node:fs/promises");
    const urls: string[] = [];
    for (const f of (await readdir(dirRef)).filter((x) => /\.(jpe?g|png|webp)$/i.test(x)).slice(0, 4)) {
      const p = `podcast-catalog/estilo/${f}`;
      await service.storage.from(BUCKET).upload(p, await readFile(path.join(dirRef, f)), { contentType: f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "image/jpeg", upsert: true });
      const { data } = await service.storage.from(BUCKET).createSignedUrl(p, 3600);
      if (data?.signedUrl) urls.push(data.signedUrl);
    }
    if (!urls.length) throw new Error("Sin referencias de estilo para Recraft.");
    return urls;
  };
  // Modelo de recorte de personas (gratuito): se descarga y se comprueba su huella antes de usarlo.
  const matterModel = async () => {
    const f = path.join(os.tmpdir(), "rvm_mobilenetv3_fp32.onnx");
    const { createHash } = await import("node:crypto");
    const { existsSync } = await import("node:fs");
    const { writeFile } = await import("node:fs/promises");
    if (!existsSync(f)) { const r = await fetch(RVM_MODEL.url); if (!r.ok) throw new Error(`RECORTE_MODELO ${r.status}`); await writeFile(f, Buffer.from(await r.arrayBuffer())); }
    if (createHash("sha256").update(await readFile(f)).digest("hex") !== RVM_MODEL.sha256) throw new Error("RECORTE_MODELO_HUELLA");
    return f;
  };
  const providers = simulated ? mockProviders(Number.isInteger(rejectTtsCall) && rejectTtsCall > 0 ? { rejectTtsCall } : {}) : { tts: realTts(spec.language, rates?.voiceUsdPer1kChars), avatar: wrapped, readiness,
    // Recraft como proveedor de las ilustraciones (Pexels quedó fuera del estudio: sus etiquetas incluían las palabras de
    // la búsqueda y daban por pertinentes fotos ajenas). La pertinencia la decide el director visual mirando cada imagen.
    images: realRecraftImages({ styleRefs }), director: realDirector(owner, episodeId), matte: realMatter({ model: await matterModel() }) };
  console.log("STUDIO_PROVIDERS", simulated ? "mock" : "real adapter (untested live)");
  // Avance real (progress.ts) + latido: mientras un proveedor trabaja sin informar (un clip de avatar tarda minutos), el
  // último avance se reescribe con la hora actual para que la página distinga «trabajando» de «sin noticias».
  let last: import("../../src/lib/podcast/v3/progress").StudioProgress | null = null;
  const write = (p: import("../../src/lib/podcast/v3/progress").StudioProgress) => { last = p; void service.from(STUDIO_TABLE).update({ progress: p, updated_at: new Date().toISOString() }).eq("id", episodeId).eq("status", "generating"); };
  const progress = (p: import("../../src/lib/podcast/v3/progress").StudioProgress) => write(p);
  const beat = setInterval(() => { if (last) write({ ...last, updatedAt: new Date().toISOString() }); }, 45_000);
  try {
    const r = await runEpisode(spec, { owner, episode: episodeId, dir, providers, small: simulated, ledger: supabaseStudioLedger(service, owner), guard: supabaseRunGuard(service), authorizedUsd: Number(row.authorized_usd), onProgress: progress, artifacts, rates });
    // Guardado: la última etapa; el 100 % solo llega con «ready», cuando el archivo ya está en el almacenamiento.
    const stages = stagesFor({ video: !!r.mp4, images: r.plan.shots.some((x) => !!x.asset_id), avatars: r.plan.shots.some((x) => /avatar|two_shot|over_shoulder/.test(x.kind)) });
    write(progressRecord(stages, "guardado", 0, r.mp4 ? 2 : 1));
    const video = r.mp4 ? await upload(`${base}/episodio.mp4`, r.mp4, "video/mp4") : null; // solo audio: sin MP4
    if (r.mp4) write(progressRecord(stages, "guardado", 1, 2));
    const audio = await upload(`${base}/episodio.${spec.audio_export}`, r.audio, spec.audio_export === "mp3" ? "audio/mpeg" : "audio/wav");
    clearInterval(beat);
    await service.from(STUDIO_TABLE).update({ status: "ready", video_path: video, audio_path: audio, cost_usd: r.spentUsd, progress: { stage: "guardado", pct: 100, done: 1, total: 1, estimate: true, updatedAt: new Date().toISOString() },
      result: { duration: r.durationSeconds, lufs: r.lufs, true_peak: r.truePeak, music: r.musicTrack, mood: r.mood, shots: r.plan.shots.map((s) => ({ kind: s.kind, speaker: s.speaker, start: s.start, end: s.end, label: s.label ?? null })), providers: r.providers,
        // Podcast 2.1: línea de tiempo de labios por segmento y su verificación contra la voz real (nadie habla fuera de su turno).
        lips: lipTimeline(r.plan).map((x) => ({ start: x.start, end: x.end, shot: x.shot, A: x.lips.A, B: x.lips.B })), lip_violations: lipViolations(lipTimeline(r.plan), r.timeline), coverage: shotCoverage(r.plan) }, error: null, updated_at: new Date().toISOString() }).eq("id", episodeId);
    console.log("STUDIO_READY", JSON.stringify({ usd: r.spentUsd, paid: r.paidOps, reused: r.reusedOps }));
  } catch (e) {
    clearInterval(beat);
    if (!studioRunErrorFailsEpisode(e)) { console.log("STUDIO_DUPLICATE"); return; }
    const msg = e instanceof Error ? e.message.slice(0, 400) : "Error";
    await service.from(STUDIO_TABLE).update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", episodeId);
    console.log("STUDIO_FAILED", e instanceof Error ? e.name : "unknown", e instanceof Error && "detail" in e ? String((e as { detail?: string }).detail ?? "").slice(0, 200) : "");
    throw e;
  }
}
