/**
 * Muestra de calidad Long Form (M2) a partir de un manifiesto revisado
 * (src/lib/video/long-form/sample-manifest.ts). Usa la NARRACIÓN GUARDADA
 * (caché TTS, nunca vuelve a sintetizar) y recursos gratuitos (Pexels con
 * la clave existente, Wikimedia Commons de dominio público, mapa de datos
 * Natural Earth, biblioteca de música con procedencia registrada). Nunca
 * toca output/final.mp4 del documental: todo va a `manifest.outputPrefix`.
 *
 * Proveedores de pago (M3, solo escenas `veo-clip` del manifiesto): APAGADOS
 * por defecto — se monta el sustituto gratuito marcado como pendiente. Solo
 * con SAMPLE_ALLOW_PAID=true y SAMPLE_PAID_BUDGET_USD (el gasto aprobado)
 * se genera, con reserva previa en `state/paid-ledger.json`, idempotencia
 * por clave (nunca se reenvía la misma) y procedencia registrada (prompt,
 * proveedor, modelo, costo, referencia) junto al clip.
 *
 * PHASE=prepare  resuelve, recorta, deduplica, valida la duración de los
 *                clips y sube los recursos; emite una hoja de contacto de lo
 *                que realmente se va a ver (con los desfases elegidos).
 * PHASE=render   RENDER_PURPOSE=technical (ventana corta RENDER_WINDOW_SEC,
 *                marcas visibles si algo está pendiente) o approval (la
 *                muestra completa; se niega si hay escenas pendientes).
 */
export {};

/** Reserva por imagen IA: estimación publicada ($0.05) redondeada al alza con el costo real observado (~$0.055). */
const SAMPLE_IMAGE_RESERVE_USD = 0.06;
/** Tope absoluto por ejecución, aunque se pida más: una muestra nunca justifica un gasto mayor. */
const SAMPLE_PAID_HARD_CAP_USD = 10;

const UA = "AtomividQualitySample/1.0 (https://github.com/hanzmo16-png/Atomivid; hanzmo16-png)";

async function main() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const sharp = (await import("sharp")).default;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { loadProductionCachedBeatNarration } = await import("../src/lib/video/long-form/production-tts-cache");
  const { getVoiceIdentity } = await import("../src/lib/ai/voice");
  const { validateSampleManifest, blockingIssues, requiredClipSeconds } = await import("../src/lib/video/long-form/sample-manifest");
  const { contentIdentity, DocumentAssetRegistry } = await import("../src/lib/video/long-form/asset-identity");
  const { buildDataMapSvg } = await import("../src/lib/video/long-form/data-map");
  const { MUSIC_MANIFEST } = await import("../src/lib/providers/music/manifest");
  const { MUSIC_LIBRARY_BUCKET, normalizeObjectPath } = await import("../src/lib/providers/music/storage");
  const { buildContactSheet, emitSheet, frameAt, probeDuration } = await import("./lib/contact-sheet");
  const { paidPlan, reservePaid, settlePaid, releasePaid, committedUsd, VEO_CLIP_SECONDS } = await import("../src/lib/video/long-form/sample-manifest");
  const { AI_VIDEO_STORAGE_BUCKET, readAiVideoClipRecord, validateExistingAiVideoClip } = await import("../src/lib/video/long-form/ai-video-storage");
  const { wrapDurableVideoProvider } = await import("../src/lib/video/long-form/ai-video-durable-provider");
  const { validateReferenceImageBuffer } = await import("../src/lib/video/long-form/ai-video-reference-image");
  const { veoVideoProvider, getVeoCostUsdPerSecond, VEO_MODEL } = await import("../src/lib/providers/video-gen/veo");
  const { GenerativeProviderError } = await import("../src/lib/providers/types");
  /** Fallos que el adaptador lanza ANTES de cualquier petición HTTP al proveedor: nada pudo cobrarse. */
  const failedBeforeSubmit = (err: unknown) =>
    err instanceof GenerativeProviderError && !err.providerJobId && (err.reason === "not_configured" || err.reason === "budget_exceeded");
  const { openaiImageProvider } = await import("../src/lib/providers/image/openai");
  type SampleManifest = import("../src/lib/video/long-form/sample-manifest").SampleManifest;
  type FreeSampleSource = import("../src/lib/video/long-form/sample-manifest").FreeSampleSource;
  type VeoClipSource = import("../src/lib/video/long-form/sample-manifest").VeoClipSource;
  type PaidLedger = import("../src/lib/video/long-form/sample-manifest").PaidLedger;

  const phase = process.env.PHASE ?? "prepare";
  // Gasto: apagado por defecto. Solo PHASE=prepare con SAMPLE_ALLOW_PAID=true y un presupuesto aprobado explícito.
  const allowPaid = process.env.SAMPLE_ALLOW_PAID === "true";
  const budgetUsd = Number(process.env.SAMPLE_PAID_BUDGET_USD ?? "0");
  for (const key of ["ELEVENLABS_API_KEY", "ANTHROPIC_API_KEY", ...(allowPaid ? [] : ["OPENAI_API_KEY", "VEO_API_KEY"])]) {
    if (process.env[key]) throw new Error(`${key} presente — esta ejecución no está autorizada a usar ese proveedor de pago.`);
  }
  if (allowPaid) {
    if (phase !== "prepare") throw new Error("SAMPLE_ALLOW_PAID solo se admite en PHASE=prepare");
    if (!(budgetUsd > 0 && budgetUsd <= SAMPLE_PAID_HARD_CAP_USD)) throw new Error(`SAMPLE_PAID_BUDGET_USD debe ser el presupuesto aprobado (0 < x ≤ ${SAMPLE_PAID_HARD_CAP_USD})`);
  }
  const paidCalls: { key: string; provider: string; costUsd: number }[] = [];
  const manifestPath = process.env.SAMPLE_MANIFEST ?? "docs/quality/m2-panama-opening/sample-manifest.json";
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as SampleManifest;
  const outDir = process.env.SAMPLE_OUT_DIR ?? path.join(process.cwd(), "quality-sample");
  await fs.mkdir(outDir, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-sample-"));
  const service = createServiceClient();
  const bucket = "videos";
  const prefix = manifest.outputPrefix;
  if (!prefix.startsWith(`${manifest.requestId}/samples/`)) throw new Error("outputPrefix debe estar bajo <requestId>/samples/ (nunca la salida del documental)");

  const upload = async (objectPath: string, body: Buffer, contentType: string) => {
    const { error } = await service.storage.from(bucket).upload(objectPath, body, { contentType, upsert: true });
    if (error) throw new Error(`upload ${objectPath}: ${error.message}`);
  };
  const sign = async (b: string, objectPath: string) => {
    const { data, error } = await service.storage.from(b).createSignedUrl(objectPath, 3 * 3600);
    if (error || !data) throw new Error(`sign ${objectPath}: ${error?.message}`);
    return data.signedUrl;
  };
  const readJson = async <T,>(objectPath: string): Promise<T | undefined> => {
    const { data } = await service.storage.from(bucket).download(objectPath);
    return data ? (JSON.parse(await data.text()) as T) : undefined;
  };
  const fetchBuffer = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    if (!res.ok) throw new Error(`GET ${res.status} ${url.slice(0, 100)}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(cmd, args);
      let err = "";
      p.stderr.on("data", (c: Buffer) => (err += c.toString()));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} ${code}: ${err.slice(-400)}`))));
    });

  // --- Narración guardada (solo lectura; sin síntesis) ---
  const { data: row, error: rowError } = await service.from("video_requests").select("language,script_json").eq("id", manifest.requestId).single();
  if (rowError || !row) throw new Error(`request_read_failed: ${rowError?.message}`);
  const script = row.script_json as { beats: { id: string; narration: string }[] };
  const language = ((row.language as "es" | "en" | null) ?? "es") as "es" | "en";
  if (manifest.beats.length !== 1 || script.beats[0]?.id !== manifest.beats[0]) {
    throw new Error("esta herramienta renderiza un único beat inicial (la narración empieza en 0)");
  }
  const beat = script.beats[0];
  const narrated = await loadProductionCachedBeatNarration(service, "elevenlabs", beat, language, { videoId: manifest.requestId, voiceIdentity: getVoiceIdentity(language) });
  const words = narrated.words;

  const issues = validateSampleManifest(manifest, words, narrated.durationSeconds);
  for (const issue of issues) console.log(`@@ISSUE ${JSON.stringify(issue)}`);
  const blocking = blockingIssues(issues);
  if (blocking.length > 0) throw new Error(`manifiesto inválido: ${blocking.map((i) => `${i.sceneId}:${i.code}`).join(", ")}`);

  if (phase === "prepare") {
    const registry = new DocumentAssetRegistry();
    const prepared: Record<string, unknown>[] = [];
    const tiles: { image: Buffer; label: string }[] = [];
    type Resolved = { buffer: Buffer; ext: string; mediaType: "image" | "video"; meta: Record<string, unknown> };
    const resolveFree = async (sceneId: string, src: FreeSampleSource): Promise<Resolved> => {
      let buffer: Buffer;
      let ext: string;
      let mediaType: "image" | "video" = "image";
      let meta: Record<string, unknown> = {};
      if (src.kind === "pexels-video") {
        const key = process.env.PEXELS_API_KEY;
        if (!key) throw new Error("PEXELS_API_KEY requerido");
        const video = (await (await fetch(`https://api.pexels.com/videos/videos/${src.id}`, { headers: { Authorization: key } })).json()) as {
          url: string; duration: number; user?: { name?: string; url?: string };
          video_files: { link: string; width: number | null; height: number | null; file_type: string }[];
        };
        const files = video.video_files.filter((f) => f.file_type === "video/mp4" && (f.width ?? 0) >= (f.height ?? 0));
        const file = files.find((f) => f.width === 1920) ?? files.sort((a, b) => (b.width ?? 0) - (a.width ?? 0)).find((f) => (f.width ?? 0) <= 2560) ?? files[0];
        buffer = await fetchBuffer(file.link);
        ext = "mp4";
        mediaType = "video";
        meta = { provider: "pexels", sourceId: `pexels-video-${src.id}`, pageUrl: video.url, author: video.user?.name, license: "Pexels License (uso gratuito, sin atribución obligatoria)", file: { width: file.width, height: file.height } };
      } else if (src.kind === "pexels-photo") {
        const key = process.env.PEXELS_API_KEY;
        if (!key) throw new Error("PEXELS_API_KEY requerido");
        const photo = (await (await fetch(`https://api.pexels.com/v1/photos/${src.id}`, { headers: { Authorization: key } })).json()) as {
          url: string; alt?: string; photographer: string; width: number; height: number; src: { original: string; large2x: string };
        };
        const raw = await fetchBuffer(photo.src.original);
        buffer = await sharp(raw).rotate().resize({ width: 3200, height: 3200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        ext = "jpg";
        meta = { provider: "pexels", sourceId: `pexels-photo-${src.id}`, pageUrl: photo.url, author: photo.photographer, title: photo.alt, license: "Pexels License (uso gratuito, sin atribución obligatoria)", original: { width: photo.width, height: photo.height } };
      } else if (src.kind === "commons") {
        const params = new URLSearchParams({ action: "query", format: "json", titles: src.title, prop: "imageinfo", iiprop: "url|size|extmetadata|sha1" });
        const body = (await (await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA } })).json()) as {
          query: { pages: Record<string, { imageinfo?: { url: string; descriptionurl: string; width: number; height: number; sha1: string; extmetadata?: Record<string, { value?: string }> }[] }> };
        };
        const info = Object.values(body.query.pages)[0]?.imageinfo?.[0];
        if (!info) throw new Error(`${sceneId}: no existe ${src.title}`);
        const strip = (s?: string) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const m = info.extmetadata ?? {};
        const license = strip(m.LicenseShortName?.value);
        if (!/public domain|^pd|cc0/i.test(license)) throw new Error(`${sceneId}: licencia no apta (${license})`);
        let img = sharp(await fetchBuffer(info.url)).rotate();
        const md = await img.metadata();
        if (src.crop && md.width && md.height) {
          const left = Math.round(src.crop.x0 * md.width);
          const top = Math.round(src.crop.y0 * md.height);
          img = sharp(await img.extract({ left, top, width: Math.round((src.crop.x1 - src.crop.x0) * md.width), height: Math.round((src.crop.y1 - src.crop.y0) * md.height) }).toBuffer());
        }
        buffer = await img.resize({ width: 3200, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        ext = "jpg";
        meta = {
          provider: "wikimedia-commons", sourceId: `commons:${src.title}`, pageUrl: info.descriptionurl, commonsSha1: info.sha1,
          license, author: strip(m.Artist?.value).slice(0, 160), date: strip(m.DateTimeOriginal?.value).slice(0, 60),
          credit: strip(m.Credit?.value).slice(0, 240), description: strip(m.ImageDescription?.value).slice(0, 400),
          original: { width: info.width, height: info.height }, crop: src.crop ?? null,
        };
      } else if (src.kind === "data-map") {
        const geo = JSON.parse(await fs.readFile(src.geo, "utf8"));
        const spec = JSON.parse(await fs.readFile(src.spec, "utf8"));
        const map = buildDataMapSvg({ bbox: geo.bbox, land: geo.land, lakes: geo.lakes, route: { points: spec.route, label: spec.routeLabel, approximate: true }, markers: spec.markers, waterLabels: spec.waterLabels, narratedKm: spec.narratedKm, source: spec.source });
        buffer = await sharp(Buffer.from(map.svg)).png().toBuffer();
        ext = "png";
        meta = { provider: "natural-earth", license: "Dominio público (Natural Earth)", dataSource: geo.source, measuredKm: map.measuredKm, labeledKm: map.labeledKm };
      } else {
        const { data } = await service.storage.from(bucket).download(src.path);
        if (!data) throw new Error(`${sceneId}: no existe ${src.path}`);
        buffer = Buffer.from(await data.arrayBuffer());
        ext = src.path.split(".").pop() ?? "bin";
        mediaType = ext === "mp4" ? "video" : "image";
        meta = { provider: "existing", path: src.path };
      }
      return { buffer, ext, mediaType, meta };
    };

    // --- Clips IA (M3): selectivos, de pago y solo con presupuesto aprobado ---
    const rates = { imageUsd: SAMPLE_IMAGE_RESERVE_USD, veoClipUsd: VEO_CLIP_SECONDS * getVeoCostUsdPerSecond() };
    const plan = paidPlan(manifest, rates);
    const scopeId = `sample-${prefix.replace(/[^a-zA-Z0-9]+/g, "-")}`;
    const ledgerPath = `${prefix}/state/paid-ledger.json`;
    let ledger: PaidLedger = (await readJson<PaidLedger>(ledgerPath)) ?? { entries: [] };
    const saveLedger = () => upload(ledgerPath, Buffer.from(JSON.stringify(ledger, null, 2)), "application/json");
    // Reparación explícita (SAMPLE_LEDGER_RELEASE=clave,…): solo reservas fallidas sin id de operación y,
    // para Veo, sin registro durable (el registro STARTED se escribe en cuanto el proveedor acepta la operación).
    for (const key of (process.env.SAMPLE_LEDGER_RELEASE ?? "").split(",").map((k) => k.trim()).filter(Boolean)) {
      const entry = ledger.entries.find((e) => e.key === key && e.status === "failed");
      if (!entry) throw new Error(`${key}: no hay una reserva fallida que liberar`);
      if (entry.provider === "veo" && (await readAiVideoClipRecord(service, AI_VIDEO_STORAGE_BUCKET, scopeId, key.replace(/:veo$/, "")))) {
        throw new Error(`${key}: existe un registro durable de la operación — pudo enviarse, no se libera`);
      }
      ledger = releasePaid(ledger, key, `liberada: nunca se envió (${entry.note ?? "sin detalle"})`, new Date().toISOString());
      await saveLedger();
      console.log(`@@LEDGER_RELEASE ${JSON.stringify({ key, previousNote: entry.note })}`);
    }
    const committedAtStart = committedUsd(ledger);
    console.log(`@@PAIDPLAN ${JSON.stringify({ allowPaid, budgetUsd, rates, items: plan, totalEstimateUsd: +plan.reduce((a, i) => a + i.estimateUsd, 0).toFixed(4), committedUsd: committedAtStart, ledger: ledger.entries })}`);
    if (allowPaid) {
      // Antes de CUALQUIER gasto: qué falta realmente por pagar (lo ya generado se reutiliza gratis) y si
      // el workflow recibe las claves necesarias. Falla cerrado: nunca se paga una parte si otra no puede ejecutarse.
      const needs = { openai: false, veo: false };
      for (const scene of manifest.scenes) {
        if (scene.source.kind !== "veo-clip") continue;
        const src = scene.source;
        const record = await readAiVideoClipRecord(service, AI_VIDEO_STORAGE_BUCKET, scopeId, src.key);
        if (record?.status === "COMPLETED" || record?.status === "FAILED") continue;
        needs.veo = true;
        if (src.reference.kind === "ai-still" && !(await service.storage.from(bucket).download(`${prefix}/ai/${src.key}-still.png`)).data) needs.openai = true;
      }
      const has = { openai: Boolean(process.env.OPENAI_API_KEY?.trim()), veo: Boolean(process.env.VEO_API_KEY?.trim()) };
      // Comprobación GRATUITA de la clave de Veo: lectura de metadatos del modelo (no genera nada).
      let veoKeyStatus: number | null = null;
      if (has.veo) {
        const res = await fetch(`${process.env.VEO_API_BASE || "https://generativelanguage.googleapis.com/v1beta"}/models/${VEO_MODEL}`, {
          headers: { "x-goog-api-key": process.env.VEO_API_KEY!.trim() },
        }).catch(() => null);
        veoKeyStatus = res?.status ?? 0;
      }
      const veoKeyRejected = veoKeyStatus !== null && [0, 400, 401, 403].includes(veoKeyStatus);
      console.log(`@@KEYCHECK ${JSON.stringify({ needs, has, veoModel: VEO_MODEL, veoKeyStatus, veoKeyRejected })}`);
      if ((needs.veo && (!has.veo || veoKeyRejected)) || (needs.openai && !has.openai)) {
        throw new Error("preflight de gasto: falta una clave necesaria o el proveedor la rechaza — no se hace ninguna llamada de pago");
      }
      if (process.env.SAMPLE_PAID_PREFLIGHT_ONLY === "true") {
        console.log("PAID_PREFLIGHT_OK (sin llamadas de pago)");
        return;
      }
    }
    const settleOpen = async (key: string, outcome: Parameters<typeof settlePaid>[2]) => {
      if (!ledger.entries.some((e) => e.key === key && e.status === "reserved")) return;
      ledger = settlePaid(ledger, key, outcome, new Date().toISOString());
      await saveLedger();
    };
    const closeFailed = async (key: string, err: unknown) => {
      if (!ledger.entries.some((e) => e.key === key && e.status === "reserved")) return;
      const note = err instanceof Error ? err.message.slice(0, 200) : "error";
      ledger = failedBeforeSubmit(err)
        ? releasePaid(ledger, key, `liberada: nunca se envió (${note})`, new Date().toISOString())
        : settlePaid(ledger, key, { status: "failed", providerJobId: (err as { providerJobId?: string }).providerJobId, note }, new Date().toISOString());
      await saveLedger();
    };
    const reserve = async (key: string) => {
      const item = plan.find((i) => i.key === key);
      if (!item) throw new Error(`${key}: no está en el plan de gasto`);
      ledger = reservePaid(ledger, item, budgetUsd, new Date().toISOString());
      await saveLedger(); // write-ahead: la reserva existe antes de la llamada
    };
    // Veo recibe 16:9 (±2 %): recorte centrado, sin deformar.
    const toSixteenNine = async (input: Buffer) => {
      const img = sharp(input).rotate();
      const { width = 0, height = 0 } = await img.metadata();
      const target = 16 / 9;
      const w = width / height > target ? Math.round(height * target) : width;
      const h = width / height > target ? height : Math.round(width / target);
      return sharp(await img.extract({ left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h }).toBuffer())
        .resize({ width: 1920, height: 1080, fit: "fill" })
        .jpeg({ quality: 92 })
        .toBuffer();
    };

    const resolveVeoClip = async (sceneId: string, src: VeoClipSource) => {
      const provenancePath = `${prefix}/ai/${src.key}.provenance.json`;
      const record = await readAiVideoClipRecord(service, AI_VIDEO_STORAGE_BUCKET, scopeId, src.key);
      if (record?.status === "COMPLETED" && (await validateExistingAiVideoClip(service, AI_VIDEO_STORAGE_BUCKET, record))) {
        const { data } = await service.storage.from(AI_VIDEO_STORAGE_BUCKET).download(record.storagePath!);
        if (!data) throw new Error(`${sceneId}: clip IA registrado pero ilegible (${record.storagePath})`);
        const provenance = (await readJson<Record<string, unknown>>(provenancePath)) ?? {};
        const resolved: Resolved = { buffer: Buffer.from(await data.arrayBuffer()), ext: "mp4", mediaType: "video", meta: { ...provenance, provider: "veo", sourceId: `veo:${src.key}`, reusedClip: true } };
        return { resolved, override: {} as Record<string, unknown>, referenceTile: undefined as { image: Buffer; label: string } | undefined };
      }

      // Imagen de partida: fotografía de archivo (gratis) o imagen IA (de pago, reutilizada si ya existe).
      let reference: { buffer: Buffer; meta: Record<string, unknown> } | null = null;
      if (src.reference.kind === "commons") {
        const r = await resolveFree(sceneId, { kind: "commons", title: src.reference.title, crop: src.reference.crop });
        reference = { buffer: await toSixteenNine(r.buffer), meta: { kind: "archival_photo", ...r.meta } };
      } else {
        const stillPath = `${prefix}/ai/${src.key}-still.png`;
        const stillMetaPath = `${prefix}/ai/${src.key}-still.json`;
        const { data: existing } = await service.storage.from(bucket).download(stillPath);
        if (existing) {
          reference = { buffer: await toSixteenNine(Buffer.from(await existing.arrayBuffer())), meta: { kind: "ai_still", ...((await readJson<Record<string, unknown>>(stillMetaPath)) ?? {}), reusedStill: true } };
        } else if (allowPaid) {
          const key = `${src.key}:still`;
          await reserve(key);
          let asset;
          try {
            asset = await openaiImageProvider.generateImage({ prompt: src.reference.prompt, negativePrompt: src.reference.negativePrompt, aspectRatio: "16:9", maxCostUsd: rates.imageUsd });
          } catch (err) {
            await closeFailed(key, err);
            throw err;
          }
          paidCalls.push({ key, provider: "openai-image", costUsd: asset.costUsd });
          const meta = { kind: "ai_still", provider: "openai-image", model: asset.model, prompt: src.reference.prompt, negativePrompt: src.reference.negativePrompt, costUsd: asset.costUsd, width: asset.width, height: asset.height, generatedAtIso: new Date().toISOString(), storagePath: stillPath };
          await upload(stillPath, asset.buffer, asset.mimeType);
          await upload(stillMetaPath, Buffer.from(JSON.stringify(meta, null, 2)), "application/json");
          await settleOpen(key, { status: "spent", actualUsd: asset.costUsd });
          reference = { buffer: await toSixteenNine(asset.buffer), meta };
        }
      }
      const referencePath = `${prefix}/ai/${src.key}-ref.jpg`;
      const referenceTile = reference ? { image: reference.buffer, label: `${sceneId} | referencia 16:9 del clip IA (${src.key})` } : undefined;
      if (reference) await upload(referencePath, reference.buffer, "image/jpeg");

      if (!allowPaid || !reference || record?.status === "FAILED") {
        const r = await resolveFree(sceneId, src.placeholder.source);
        const why = record?.status === "FAILED" ? "el clip IA tuvo un fallo terminal" : "clip IA sin generar (gasto pendiente de aprobación)";
        return {
          resolved: r,
          override: { placeholder: true, provenance: src.placeholder.provenance, creditText: src.placeholder.creditText, camera: src.placeholder.camera ?? "push", pending: `${why}: se muestra el sustituto` } as Record<string, unknown>,
          referenceTile,
        };
      }

      const check = validateReferenceImageBuffer(reference.buffer, "image/jpeg");
      if (!check.valid) throw new Error(`${sceneId}: referencia no apta para Veo: ${check.reason}`);
      const veoKey = `${src.key}:veo`;
      const provider = wrapDurableVideoProvider(veoVideoProvider, {
        supabase: service,
        scopeId,
        executionMode: "real",
        maxInAttemptResumes: 2,
        beforeSubmit: async () => {
          await reserve(veoKey);
          return true;
        },
      });
      let asset;
      try {
        asset = await provider.generateVideo({
          prompt: src.prompt,
          negativePrompt: src.negativePrompt,
          aspectRatio: "16:9",
          durationSeconds: VEO_CLIP_SECONDS,
          maxCostUsd: rates.veoClipUsd,
          referenceImageUrl: await sign(bucket, referencePath),
          metadata: { shotId: src.key, sceneId },
        });
      } catch (err) {
        await closeFailed(veoKey, err);
        throw err;
      }
      paidCalls.push({ key: veoKey, provider: "veo", costUsd: asset.costUsd });
      await settleOpen(veoKey, { status: "spent", actualUsd: asset.costUsd, providerJobId: asset.providerJobId });
      const provenance = {
        provider: "veo", model: asset.model, prompt: src.prompt, negativePrompt: src.negativePrompt, aspectRatio: "16:9", durationSeconds: asset.durationSeconds,
        costUsd: asset.costUsd, providerJobId: asset.providerJobId, generatedAtIso: new Date().toISOString(), referencePath, reference: reference.meta,
        generatedAudio: "descartado (el clip se monta en silencio)", license: "Generado para ATOMIVID — Recreación IA",
      };
      await upload(provenancePath, Buffer.from(JSON.stringify(provenance, null, 2)), "application/json");
      const resolved: Resolved = { buffer: asset.buffer, ext: "mp4", mediaType: "video", meta: { ...provenance, sourceId: `veo:${src.key}` } };
      return { resolved, override: {} as Record<string, unknown>, referenceTile };
    };

    for (const [index, scene] of manifest.scenes.entries()) {
      const src = scene.source;
      let resolved: Resolved;
      let override: Record<string, unknown> = {};
      if (src.kind === "veo-clip") {
        const out = await resolveVeoClip(scene.id, src);
        resolved = out.resolved;
        override = out.override;
        if (out.referenceTile) tiles.push(out.referenceTile);
      } else {
        resolved = await resolveFree(scene.id, src);
      }
      const { buffer, ext, mediaType, meta } = resolved;
      // Identidad de contenido: ningún recurso repetido dentro de la muestra (hash exacto o perceptual).
      const identity = { ...(await contentIdentity(buffer, mediaType)), provider: String(meta.provider ?? ""), sourceId: meta.sourceId as string | undefined };
      const byRef = registry.findByReference(identity, scene.repeatOf);
      const byContent = registry.findByContent(identity, scene.repeatOf);
      if (byRef || byContent) throw new Error(`${scene.id}: recurso repetido (igual a ${(byRef ?? byContent)?.shotId})`);
      registry.register(scene.id, identity);

      const local = path.join(tmp, `${scene.id}.${ext}`);
      await fs.writeFile(local, buffer);
      let durationSeconds: number | undefined;
      if (mediaType === "video") {
        durationSeconds = await probeDuration(local);
        const needed = requiredClipSeconds(manifest.scenes, index);
        if (durationSeconds + 1e-3 < needed) throw new Error(`${scene.id}: clip de ${durationSeconds.toFixed(2)} s < ${needed.toFixed(2)} s (desfase + escena + cola de fundido)`);
        const start = scene.direction.mediaStartSeconds ?? 0;
        const len = scene.endSeconds - scene.startSeconds;
        for (const f of [0.05, 0.5, 0.95]) {
          const image = await frameAt(local, start + len * f, 480).catch(() => null);
          if (image) tiles.push({ image, label: `${scene.id} @${(start + len * f).toFixed(1)}s | ${scene.narration}` });
        }
      } else {
        tiles.push({ image: buffer, label: `${scene.id} | ${scene.narration}` });
      }
      const objectPath = `${prefix}/assets/${scene.id}.${ext}`;
      await upload(objectPath, buffer, mediaType === "video" ? "video/mp4" : ext === "png" ? "image/png" : "image/jpeg");
      prepared.push({ sceneId: scene.id, objectPath, mediaType, durationSeconds, identity, ...meta, ...override });
      console.log(`@@PREPARED ${JSON.stringify({ sceneId: scene.id, objectPath, mediaType, durationSeconds, sha: identity.sha256?.slice(0, 12), license: meta.license, ...override })}`);
    }

    // Pistas: biblioteca con procedencia registrada; duración verificada (sin bucles salvo que se pidan).
    const sounds: Record<string, unknown>[] = [];
    for (const cue of manifest.soundCues) {
      const entry = MUSIC_MANIFEST.find((t) => t.id === cue.track);
      if (!entry) throw new Error(`${cue.id}: pista ${cue.track} no está en el banco con procedencia registrada`);
      const { data } = await service.storage.from(MUSIC_LIBRARY_BUCKET).download(normalizeObjectPath(entry.storagePath));
      if (!data) throw new Error(`${cue.id}: no se pudo leer ${entry.storagePath}`);
      const local = path.join(tmp, `${cue.id}.mp3`);
      await fs.writeFile(local, Buffer.from(await data.arrayBuffer()));
      const duration = await probeDuration(local);
      const needed = (cue.sourceStartSeconds ?? 0) + (cue.endSeconds - cue.startSeconds);
      if (!cue.loop && duration + 1e-3 < needed) throw new Error(`${cue.id}: pista de ${duration.toFixed(1)} s < ${needed.toFixed(1)} s necesarios`);
      sounds.push({ ...cue, storagePath: entry.storagePath, title: entry.title, author: entry.author, license: entry.license, sourceUrl: entry.sourceUrl, provider: entry.provider, trackDurationSeconds: duration });
      console.log(`@@SOUND ${JSON.stringify(sounds[sounds.length - 1])}`);
    }

    // Voz: el audio guardado del beat (bytes idénticos a la caché).
    const voicePath = `${prefix}/voice.${narrated.extension}`;
    await upload(voicePath, narrated.audioBuffer, narrated.mimeType);

    const state = { manifest: manifestPath, preparedAt: new Date().toISOString(), narrationSeconds: narrated.durationSeconds, voicePath, voiceMime: narrated.mimeType, scenes: prepared, sounds, issues, missingSound: manifest.missingSound, providerCalls: { paid: paidCalls.length, calls: paidCalls, spentThisRunUsd: +paidCalls.reduce((a, c) => a + c.costUsd, 0).toFixed(4), committedUsd: committedUsd(ledger) } };
    await upload(`${prefix}/state/prepared.json`, Buffer.from(JSON.stringify(state, null, 2)), "application/json");
    await fs.writeFile(path.join(outDir, "prepared.json"), JSON.stringify(state, null, 2));
    for (let i = 0; i < tiles.length; i += 15) {
      emitSheet(`prepared-${i / 15 + 1}`, await buildContactSheet(tiles.slice(i, i + 15), { columns: 3, tileWidth: 480, tileHeight: 270, title: `Recursos preparados (${i + 1}-${Math.min(i + 15, tiles.length)})` }));
    }
    console.log("PREPARE_OK");
    return;
  }

  // --- RENDER ---
  const { renderLongFormDoc } = await import("../src/lib/video/long-form/render");
  const { buildCaptions } = await import("../src/lib/video/captions");
  const { buildEmphasisSet } = await import("../src/lib/video/caption-emphasis");
  const { computeNarrationGaps } = await import("../remotion/audio-mix");
  const { masterAudioLoudness, measureLoudness } = await import("../src/lib/video/audio-master");
  const purpose = (process.env.RENDER_PURPOSE ?? "technical") as "technical" | "approval";
  const { data: stateBlob } = await service.storage.from(bucket).download(`${prefix}/state/prepared.json`);
  if (!stateBlob) throw new Error("falta prepared.json — ejecutar PHASE=prepare primero");
  const stateText = await stateBlob.text();
  console.log(`@@STATE ${JSON.stringify(JSON.parse(stateText))}`);
  const state = JSON.parse(stateText) as {
    voicePath: string;
    scenes: {
      sceneId: string; objectPath: string; mediaType: "image" | "video";
      placeholder?: boolean; provenance?: import("../remotion/long-form-card-fit").SceneProvenance; creditText?: string;
      camera?: import("../remotion/long-form-direction").SceneDirection["camera"]; pending?: string;
    }[];
    sounds: { id: string; storagePath: string; role: "music" | "ambience" | "effect"; startSeconds: number; endSeconds: number; sourceStartSeconds?: number; gain?: number; fadeInSeconds?: number; fadeOutSeconds?: number; loop?: boolean }[];
  };
  const fullDuration = narrated.durationSeconds + manifest.tailSeconds;
  // Ventana: el técnico es corto por defecto; una ventana explícita permite comparar aperturas (A/B) también en aprobación.
  const requestedWindow = Number(process.env.RENDER_WINDOW_SEC || (purpose === "technical" ? 12 : fullDuration));
  const windowSec = Math.min(fullDuration, requestedWindow > 0 ? requestedWindow : fullDuration);
  const outSuffix = windowSec < fullDuration - 0.01 ? `-${Math.round(windowSec)}s` : "";

  const scenes = [];
  for (const scene of manifest.scenes) {
    if (scene.startSeconds >= windowSec) break;
    const prep = state.scenes.find((s) => s.sceneId === scene.id);
    if (!prep) throw new Error(`${scene.id}: no preparado`);
    scenes.push({
      id: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: Math.min(scene.endSeconds, windowSec),
      asset: { kind: "media" as const, mediaType: prep.mediaType, url: await sign(bucket, prep.objectPath), fit: scene.fit },
      motion: "static" as const,
      // Un sustituto se muestra con SU procedencia real (nunca «Recreación IA» sobre una foto de stock) y queda pendiente.
      direction: prep.camera ? { ...scene.direction, camera: prep.camera } : scene.direction,
      provenance: prep.provenance ?? scene.provenance,
      creditText: prep.placeholder ? prep.creditText : scene.creditText,
      pending: [scene.review.status === "approved" ? undefined : scene.review.note || "revisión pendiente", prep.pending].filter(Boolean).join(" · ") || undefined,
    });
  }
  const soundCues = [];
  for (const s of state.sounds) {
    if (s.startSeconds >= windowSec) continue;
    soundCues.push({
      id: s.id, src: await sign(MUSIC_LIBRARY_BUCKET, normalizeObjectPath(s.storagePath)), role: s.role,
      startSeconds: s.startSeconds, endSeconds: Math.min(s.endSeconds, windowSec), sourceStartSeconds: s.sourceStartSeconds,
      gain: s.gain, fadeInSeconds: s.fadeInSeconds, fadeOutSeconds: s.endSeconds > windowSec ? 0.6 : s.fadeOutSeconds, loop: s.loop,
    });
  }
  const { captionsWithinScenes } = await import("../src/lib/video/long-form/scene-captions");
  const emphasis = buildEmphasisSet([]);
  const captions = captionsWithinScenes(words, scenes, (w) => buildCaptions(w, emphasis));
  const narrationGaps = computeNarrationGaps(words);

  const raw = await renderLongFormDoc({
    audioUrl: await sign(bucket, state.voicePath),
    soundCues,
    scenes,
    captions,
    narrationGaps,
    durationSeconds: windowSec,
    purpose,
  });
  const mastered = raw.replace(/\.mp4$/, ".mastered.mp4");
  const { LONG_FORM_TRUE_PEAK_MARGIN_DB } = await import("../src/lib/video/long-form/produce");
  const mastering = await masterAudioLoudness(raw, mastered, { faststart: true, truePeakMarginDb: LONG_FORM_TRUE_PEAK_MARGIN_DB });
  console.log(`@@MASTERING ${JSON.stringify(mastering)}`);

  // --- QC: negro, cortes, rótulos, subtítulos, mezcla ---
  const black = await run("ffmpeg", ["-v", "info", "-i", mastered, "-vf", "blackdetect=d=0.02:pic_th=0.90:pix_th=0.08", "-an", "-f", "null", "-"]).catch((e) => String(e));
  const blackRuns = [...black.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  console.log(`@@BLACK ${JSON.stringify(blackRuns)}`);
  const finalLoudness = await measureLoudness(mastered);
  console.log(`@@LOUDNESS ${JSON.stringify(finalLoudness)}`);
  // Perfil de la mezcla (sin escucha): sonoridad momentánea cada 0.5 s y nivel en los silencios de
  // narración (ahí solo suena la música) — detecta saltos en los cambios de pista y huecos sin sonido.
  const eb = await run("ffmpeg", ["-nostats", "-v", "info", "-i", mastered, "-af", "ebur128=framelog=info", "-f", "null", "-"]).catch((e) => String(e));
  const frames = [...eb.matchAll(/t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-inf)/g)].map((m) => [Number(m[1]), m[2] === "-inf" ? -120 : Number(m[2])] as [number, number]);
  const profile = frames.filter(([t]) => Math.abs(t * 2 - Math.round(t * 2)) < 0.051).map(([t, m]) => [+t.toFixed(1), m]);
  console.log(`@@MIXPROFILE ${JSON.stringify(profile)}`);
  const gapLevels = narrationGaps
    .filter((g) => g.endSeconds <= windowSec)
    .map((g) => {
      const inside = frames.filter(([t]) => t >= g.startSeconds + 0.4 && t <= g.endSeconds);
      return { ...g, momentaryLufs: inside.length ? +(inside.reduce((a, [, m]) => a + m, 0) / inside.length).toFixed(1) : null };
    });
  console.log(`@@GAPLEVELS ${JSON.stringify(gapLevels)}`);
  // Nivel del bus sin voz no se puede aislar tras la mezcla: se mide el nivel por ventana para detectar saltos.
  const tiles: { image: Buffer; label: string }[] = [];
  for (const [i, scene] of scenes.entries()) {
    const probes = i === 0 ? [scene.startSeconds + 0.3] : [scene.startSeconds - 0.08, scene.startSeconds + 0.08, (scene.startSeconds + scene.endSeconds) / 2];
    for (const t of probes) {
      if (t < 0 || t >= windowSec) continue;
      const image = await frameAt(mastered, t, 480).catch(() => null);
      if (image) tiles.push({ image, label: `${scene.id} @${t.toFixed(2)}s` });
    }
  }
  for (let i = 0; i < tiles.length; i += 15) {
    emitSheet(`render-${purpose}-${i / 15 + 1}`, await buildContactSheet(tiles.slice(i, i + 15), { columns: 3, tileWidth: 480, tileHeight: 270, title: `Render ${purpose} — cortes y centro de escena` }));
  }
  const bytes = (await fs.stat(mastered)).size;
  const outName = `sample-${purpose}${outSuffix}.mp4`;
  const buf = await fs.readFile(mastered);
  await upload(`${prefix}/${outName}`, buf, "video/mp4");
  await fs.copyFile(mastered, path.join(outDir, outName));
  const report = { purpose, windowSeconds: windowSec, bytes, objectPath: `${prefix}/${outName}`, blackRuns, loudness: finalLoudness, mastering, scenes: scenes.length, soundCues: soundCues.map((c) => c.id), providerCalls: { paid: 0 } };
  await upload(`${prefix}/state/render-${purpose}${outSuffix}.json`, Buffer.from(JSON.stringify(report, null, 2)), "application/json");
  await fs.writeFile(path.join(outDir, `render-${purpose}${outSuffix}.json`), JSON.stringify(report, null, 2));
  console.log(`@@RENDER ${JSON.stringify(report)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
