/**
 * Diagnóstico de SOLO LECTURA de solicitudes Long Form (QA real, 2026-09-25:
 * "GENERAR GUION NO HACE NADA EN PRODUCTION"). NUNCA escribe en
 * video_requests. NUNCA llama a Anthropic ni a ningún proveedor — solo lee
 * las filas mode='long_form' más recientes (por defecto, o filtradas por
 * TOPIC_CONTAINS) para determinar si el submit de Hans creó 0, 1 o 2
 * solicitudes antes de tocar código o volver a probar desde la UI.
 *
 * Uso: [TOPIC_CONTAINS=<substring>] [LIMIT=<n>] npx tsx scripts/diagnose-long-form-request.ts
 */
export {};

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const topicContains = process.env.TOPIC_CONTAINS?.trim();
  const limit = Number(process.env.LIMIT) || 10;

  type Row = {
    id: string;
    user_id: string;
    mode: string;
    topic: string;
    style: string;
    duration_seconds: number;
    aspect_ratio: string;
    language: string | null;
    status: string;
    error_message: string | null;
    long_form_stage: string | null;
    script_json: unknown;
    video_path: string | null;
    created_at: string;
  };

  const COLUMNS =
    "id, user_id, mode, topic, style, duration_seconds, aspect_ratio, language, status, error_message, long_form_stage, script_json, video_path, created_at";

  let query = service
    .from("video_requests")
    .select(COLUMNS)
    .eq("mode", "long_form")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (topicContains) {
    query = query.ilike("topic", `%${topicContains}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`long_form_query_failed: ${error.message}`);

  const rows = (data as Row[] | null) ?? [];

  const summary = rows.map((row) => ({
    id: row.id,
    status: row.status,
    has_script_json: row.script_json != null,
    error_message: row.error_message,
    long_form_stage: row.long_form_stage,
    duration_seconds: row.duration_seconds,
    aspect_ratio: row.aspect_ratio,
    video_path: row.video_path,
    created_at: row.created_at,
  }));

  console.log(
    JSON.stringify(
      {
        found: rows.length,
        topic_filter: topicContains ?? null,
        requests: summary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("DIAGNOSE_FAILED", err instanceof Error ? err.message : err);
  process.exit(1);
});
