/**
 * Diagnóstico de SOLO LECTURA del estado de salida/almacenamiento de una
 * producción Long Form real (P0 2026-09-25: final.mp4 rechazado por tamaño).
 *
 * Lee: la fila de video_requests, generation_costs, la configuración del
 * bucket "videos", el inventario completo de objetos de la solicitud
 * (assets durables, caché TTS, estado, intentos) y los registros de
 * estado (presupuesto, shots, TTS) con sus timestamps — base del benchmark.
 *
 * NUNCA llama a un proveedor (Anthropic/ElevenLabs/OpenAI/Veo/Pexels) y
 * nunca escribe en la base de datos. Única escritura opcional
 * (PROBE_SIZE_LIMIT=true): objetos de prueba temporales bajo
 * `_diagnostics/size-probe/` — se borran de inmediato — para DEMOSTRAR el
 * tamaño máximo de objeto que Storage acepta hoy con el mismo método de
 * subida que usa la producción.
 */
export {};

type ListedObject = { name: string; id: string | null; metadata?: { size?: number; mimetype?: string } | null; created_at?: string; updated_at?: string };

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();
  const requestId = process.env.REQUEST_ID;
  if (!requestId) throw new Error("REQUEST_ID requerido");
  const bucket = "videos";
  const report: Record<string, unknown> = { requestId };

  // --- Fila ---
  const { data: row, error: rowError } = await service.from("video_requests").select("*").eq("id", requestId).maybeSingle();
  if (rowError) throw new Error(`request_read_failed: ${rowError.message}`);
  if (!row) throw new Error("request_not_found");
  const script = row.script_json as { topic?: string; beats?: { id: string; narration: string; visuals?: unknown[] }[] } | null;
  const plan = row.long_form_production_plan as Record<string, unknown> | null;
  report.request = {
    status: row.status,
    mode: row.mode,
    topic: row.topic,
    duration_seconds_requested: row.duration_seconds,
    aspect_ratio: row.aspect_ratio,
    long_form_stage: row.long_form_stage,
    long_form_progress: row.long_form_progress,
    long_form_confirmed_at: row.long_form_confirmed_at,
    progress_stage: row.progress_stage,
    render_attempts: row.render_attempts,
    render_worker: row.render_worker,
    render_started_at: row.render_started_at,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    video_path: row.video_path,
    error_message: row.error_message,
  };
  report.script = script?.beats
    ? {
        beats: script.beats.length,
        wordsPerBeat: script.beats.map((b) => b.narration.trim().split(/\s+/).filter(Boolean).length),
        totalWords: script.beats.reduce((s, b) => s + b.narration.trim().split(/\s+/).filter(Boolean).length, 0),
        totalChars: script.beats.reduce((s, b) => s + b.narration.length, 0),
        beatsWithDeclaredVisuals: script.beats.filter((b) => Array.isArray(b.visuals) && b.visuals.length > 0).length,
      }
    : null;
  report.plan = plan
    ? Object.fromEntries(
        Object.entries(plan).filter(([k]) => !["providers"].includes(k)),
      )
    : null;

  const { data: costs } = await service.from("generation_costs").select("*").eq("request_id", requestId);
  report.generation_costs = costs ?? [];

  // --- Bucket ---
  const { data: bucketInfo, error: bucketError } = await service.storage.getBucket(bucket);
  report.bucket = bucketError
    ? { error: bucketError.message }
    : { id: bucketInfo?.id, public: bucketInfo?.public, file_size_limit: bucketInfo?.file_size_limit ?? null, allowed_mime_types: bucketInfo?.allowed_mime_types ?? null };

  // --- Inventario de objetos ---
  async function walk(prefix: string): Promise<{ path: string; size: number; created_at?: string; updated_at?: string }[]> {
    const out: { path: string; size: number; created_at?: string; updated_at?: string }[] = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await service.storage.from(bucket).list(prefix, { limit: 1000, offset });
      if (error) throw new Error(`list_failed(${prefix}): ${error.message}`);
      const entries = (data ?? []) as ListedObject[];
      for (const e of entries) {
        const path = `${prefix}/${e.name}`;
        if (e.id === null) out.push(...(await walk(path)));
        else out.push({ path, size: e.metadata?.size ?? 0, created_at: e.created_at, updated_at: e.updated_at });
      }
      if (entries.length < 1000) break;
      offset += 1000;
    }
    return out;
  }
  const objects = [...(await walk(requestId)), ...(await walk(`long-form/${requestId}`))];
  const groups: Record<string, { count: number; bytes: number; first?: string; last?: string }> = {};
  for (const o of objects) {
    const rel = o.path.replace(`long-form/${requestId}/`, "LF/").replace(`${requestId}/`, "");
    const key = rel.startsWith("state/shots/")
      ? `state/shots/*.${rel.split(".").slice(-2, -1)[0]}.json`
      : rel.startsWith("assets/")
        ? `assets/*.${rel.split(".").slice(-2).join(".")}`
        : rel.startsWith("LF/state/tts/")
          ? "LF/state/tts/*.json"
          : rel.startsWith("LF/tts/")
            ? "LF/tts/*"
            : rel;
    const g = (groups[key] ??= { count: 0, bytes: 0 });
    g.count += 1;
    g.bytes += o.size;
    const t = o.created_at ?? o.updated_at;
    if (t && (!g.first || t < g.first)) g.first = t;
    if (t && (!g.last || t > g.last)) g.last = t;
  }
  report.objects = { total: objects.length, totalBytes: objects.reduce((s, o) => s + o.size, 0), groups };
  report.finalObjects = objects.filter((o) => /final|mastered/.test(o.path)).map((o) => ({ path: o.path, size: o.size }));

  async function readJson<T>(path: string): Promise<T | null> {
    const { data } = await service.storage.from(bucket).download(path);
    if (!data) return null;
    const text = await data.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  // --- Presupuesto durable ---
  const budget = await readJson<{ allocation: unknown; used: unknown; deviations: { shotId: string; planned: string; executed: string; reason: string }[]; updatedAtIso: string }>(
    `${requestId}/state/production-budget.json`,
  );
  report.budget = budget
    ? {
        allocation: budget.allocation,
        used: budget.used,
        deviationsCount: budget.deviations.length,
        deviations: budget.deviations.slice(0, 20),
        updatedAtIso: budget.updatedAtIso,
      }
    : null;

  // --- Registros por shot ---
  const shotRecords = objects.filter((o) => o.path.startsWith(`${requestId}/state/shots/`));
  const shotStatus: Record<string, number> = {};
  const shotTimes: string[] = [];
  for (const o of shotRecords) {
    const r = await readJson<{ kind: string; status: string; updatedAtIso: string; costUsd?: number }>(o.path);
    if (!r) continue;
    shotStatus[`${r.kind}:${r.status}`] = (shotStatus[`${r.kind}:${r.status}`] ?? 0) + 1;
    shotTimes.push(r.updatedAtIso);
  }
  shotTimes.sort();
  report.shots = { byKindStatus: shotStatus, firstRecord: shotTimes[0] ?? null, lastRecord: shotTimes.at(-1) ?? null };

  // --- TTS ---
  const ttsRecords = objects.filter((o) => o.path.startsWith(`long-form/${requestId}/state/tts/`));
  const tts: { status: string; beatId?: string; durationSeconds?: number; words?: number; createdAtIso?: string; updatedAtIso?: string }[] = [];
  for (const o of ttsRecords) {
    const r = await readJson<{ status: string; identity?: { beatId: string; text: string }; durationSeconds?: number; createdAtIso?: string; updatedAtIso?: string }>(o.path);
    if (r)
      tts.push({
        status: r.status,
        beatId: r.identity?.beatId,
        durationSeconds: r.durationSeconds,
        words: r.identity?.text.trim().split(/\s+/).filter(Boolean).length,
        createdAtIso: r.createdAtIso,
        updatedAtIso: r.updatedAtIso,
      });
  }
  tts.sort((a, b) => (a.beatId ?? "").localeCompare(b.beatId ?? ""));
  const narratedSeconds = tts.reduce((s, t) => s + (t.durationSeconds ?? 0), 0);
  const narratedWords = tts.reduce((s, t) => s + (t.words ?? 0), 0);
  report.tts = {
    records: tts,
    narratedSeconds,
    narratedWords,
    observedWordsPerSecond: narratedSeconds > 0 ? narratedWords / narratedSeconds : null,
  };

  // --- Probe opcional del límite real de Storage ---
  if (process.env.PROBE_SIZE_LIMIT === "true") {
    const probes: { mb: number; ok: boolean; error?: string }[] = [];
    for (const mb of [10, 49, 51, 100, 250, 520, 1100]) {
      const path = `_diagnostics/size-probe/${Date.now()}-${mb}mb.bin`;
      const { error } = await service.storage.from(bucket).upload(path, Buffer.alloc(mb * 1024 * 1024), { contentType: "application/octet-stream", upsert: true });
      probes.push({ mb, ok: !error, error: error?.message });
      if (!error) await service.storage.from(bucket).remove([path]);
      else break;
    }
    report.sizeProbe = probes;
  }

  console.log("===DIAGNOSTIC_JSON_BEGIN===");
  console.log(JSON.stringify(report, null, 2));
  console.log("===DIAGNOSTIC_JSON_END===");
}

main().catch((err) => {
  console.error("diagnostic_failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
