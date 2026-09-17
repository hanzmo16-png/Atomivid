/**
 * Verificación del esquema remoto de Supabase contra TODO el historial de
 * migraciones (0001-0013).
 *
 * Modo AUTORITATIVO (preferido): si hay una credencial de conexión directa
 * a Postgres (ver scripts/lib/supabase-db.ts), consulta directamente
 * information_schema/pg_catalog — la única forma de verificar constraints,
 * índices y policies de RLS (PostgREST no los expone en absoluto) y la
 * única forma de distinguir "la tabla no existe" de "la tabla existe pero
 * le falta esta columna" (una limitación real de la versión anterior de
 * este script, que solo podía hacer HEAD requests vía REST).
 *
 * Modo de respaldo (si NO hay conexión directa): usa únicamente la service
 * role key vía REST/PostgREST (igual que antes) — solo cubre
 * existencia de tablas/columnas, en modo "mejor esfuerzo", y lo indica
 * explícitamente en la salida.
 *
 * Uso: npx tsx scripts/verify-remote-schema.ts
 */
import { resolveConnection } from "./lib/supabase-db";

export {};

type ObjectCheck = { kind: "table" | "column" | "constraint" | "index" | "policy" | "rls"; table: string; name?: string; migration: string };

// Mapa completo y exhaustivo de TODO lo que las 13 migraciones crean o
// modifican — construido leyendo el contenido íntegro de cada archivo en
// supabase/migrations/ (no de memoria). Cada entrada indica en qué
// migración se originó, para poder reportar el estado por migración.
const CHECKS: ObjectCheck[] = [
  // --- 0001_init.sql ---
  { kind: "table", table: "video_requests", migration: "0001" },
  { kind: "column", table: "video_requests", name: "id", migration: "0001" },
  { kind: "column", table: "video_requests", name: "user_id", migration: "0001" },
  { kind: "column", table: "video_requests", name: "topic", migration: "0001" },
  { kind: "column", table: "video_requests", name: "style", migration: "0001" },
  { kind: "column", table: "video_requests", name: "duration_seconds", migration: "0001" },
  { kind: "column", table: "video_requests", name: "status", migration: "0001" },
  { kind: "column", table: "video_requests", name: "video_url", migration: "0001" },
  { kind: "column", table: "video_requests", name: "created_at", migration: "0001" },
  { kind: "index", table: "video_requests", name: "video_requests_user_id_created_at_idx", migration: "0001" },
  { kind: "rls", table: "video_requests", migration: "0001" },
  { kind: "policy", table: "video_requests", name: "Users can view their own video requests", migration: "0001" },
  { kind: "policy", table: "video_requests", name: "Users can insert their own video requests", migration: "0001" },

  // --- 0002_generation.sql ---
  { kind: "column", table: "video_requests", name: "error_message", migration: "0002" },

  // --- 0003_billing.sql ---
  { kind: "table", table: "subscriptions", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "user_id", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "stripe_customer_id", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "stripe_subscription_id", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "status", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "price_id", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "current_period_end", migration: "0003" },
  { kind: "column", table: "subscriptions", name: "cancel_at_period_end", migration: "0003" },
  { kind: "rls", table: "subscriptions", migration: "0003" },
  { kind: "policy", table: "subscriptions", name: "Users can view their own subscription", migration: "0003" },

  // --- 0004_script_review.sql ---
  { kind: "column", table: "video_requests", name: "script_json", migration: "0004" },
  { kind: "constraint", table: "video_requests", name: "video_requests_status_check", migration: "0004" },

  // --- 0005_render_progress.sql ---
  { kind: "column", table: "video_requests", name: "progress_stage", migration: "0005" },

  // --- 0006_render_worker.sql ---
  { kind: "column", table: "video_requests", name: "render_attempts", migration: "0006" },
  { kind: "column", table: "video_requests", name: "render_started_at", migration: "0006" },
  { kind: "column", table: "video_requests", name: "render_worker", migration: "0006" },
  { kind: "column", table: "video_requests", name: "video_path", migration: "0006" },

  // --- 0007_input_limits.sql ---
  { kind: "constraint", table: "video_requests", name: "video_requests_duration_seconds_check", migration: "0007" },
  { kind: "constraint", table: "video_requests", name: "video_requests_topic_length_check", migration: "0007" },
  { kind: "constraint", table: "video_requests", name: "video_requests_style_length_check", migration: "0007" },

  // --- 0008_language_and_costs.sql ---
  { kind: "column", table: "video_requests", name: "language", migration: "0008" },
  { kind: "table", table: "generation_costs", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "request_id", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "script_calls", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "voice_provider", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "footage_provider", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "music_provider", migration: "0008" },
  { kind: "column", table: "generation_costs", name: "estimated_cost_usd", migration: "0008" },
  { kind: "rls", table: "generation_costs", migration: "0008" },
  { kind: "policy", table: "generation_costs", name: "Users can view their own generation costs", migration: "0008" },

  // --- 0009_music_traceability.sql ---
  { kind: "column", table: "generation_costs", name: "music_track_id", migration: "0009" },
  { kind: "column", table: "generation_costs", name: "music_track_title", migration: "0009" },
  { kind: "column", table: "generation_costs", name: "music_track_author", migration: "0009" },
  { kind: "column", table: "generation_costs", name: "music_track_license", migration: "0009" },
  { kind: "column", table: "generation_costs", name: "music_track_source_url", migration: "0009" },
  { kind: "column", table: "generation_costs", name: "music_fallback_reason", migration: "0009" },

  // --- 0010_visual_director.sql ---
  { kind: "column", table: "video_requests", name: "storyboard_json", migration: "0010" },
  { kind: "column", table: "video_requests", name: "storyboard_source", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "image_provider", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "image_generation_count", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "image_cost_usd", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "premium_video_provider", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "premium_video_clip_count", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "premium_video_cost_usd", migration: "0010" },
  { kind: "column", table: "generation_costs", name: "premium_video_fallback_reason", migration: "0010" },

  // --- 0011_video_modes_avatar.sql ---
  { kind: "column", table: "video_requests", name: "mode", migration: "0011" },
  { kind: "constraint", table: "video_requests", name: "video_requests_mode_check", migration: "0011" },
  { kind: "column", table: "video_requests", name: "idempotency_key", migration: "0011" },
  { kind: "index", table: "video_requests", name: "video_requests_idempotency_key_uidx", migration: "0011" },
  { kind: "table", table: "avatars", migration: "0011" },
  { kind: "column", table: "avatars", name: "id", migration: "0011" },
  { kind: "column", table: "avatars", name: "user_id", migration: "0011" },
  { kind: "column", table: "avatars", name: "provider", migration: "0011" },
  { kind: "column", table: "avatars", name: "provider_avatar_id", migration: "0011" },
  { kind: "column", table: "avatars", name: "provider_job_id", migration: "0011" },
  { kind: "column", table: "avatars", name: "source_photo_path", migration: "0011" },
  { kind: "column", table: "avatars", name: "status", migration: "0011" },
  { kind: "column", table: "avatars", name: "consent_given", migration: "0011" },
  { kind: "column", table: "avatars", name: "consent_given_at", migration: "0011" },
  { kind: "column", table: "avatars", name: "consent_policy_version", migration: "0011" },
  { kind: "index", table: "avatars", name: "avatars_user_id_created_at_idx", migration: "0011" },
  { kind: "rls", table: "avatars", migration: "0011" },
  { kind: "policy", table: "avatars", name: "Users can view their own avatars", migration: "0011" },
  { kind: "policy", table: "avatars", name: "Users can insert their own avatars", migration: "0011" },
  { kind: "column", table: "video_requests", name: "avatar_id", migration: "0011" },
  { kind: "column", table: "video_requests", name: "avatar_provider_video_job_id", migration: "0011" },
  { kind: "column", table: "video_requests", name: "avatar_render_status", migration: "0011" },
  { kind: "constraint", table: "video_requests", name: "video_requests_avatar_render_status_check", migration: "0011" },
  { kind: "column", table: "video_requests", name: "avatar_voice_id", migration: "0011" },
  { kind: "column", table: "generation_costs", name: "avatar_provider", migration: "0011" },
  { kind: "column", table: "generation_costs", name: "avatar_provider_job_id", migration: "0011" },
  { kind: "column", table: "generation_costs", name: "avatar_cost_usd", migration: "0011" },

  // --- 0012_visual_resource_planner.sql ---
  { kind: "column", table: "generation_costs", name: "image_requested_count", migration: "0012" },
  { kind: "column", table: "generation_costs", name: "image_reused_count", migration: "0012" },
  { kind: "column", table: "generation_costs", name: "image_dry_run", migration: "0012" },
  { kind: "column", table: "generation_costs", name: "image_model", migration: "0012" },
  { kind: "column", table: "generation_costs", name: "image_size", migration: "0012" },

  // --- 0013_avatar_state_taxonomy.sql (verificado por CONTENIDO del constraint, no solo su nombre — ver checkConstraintContent) ---
  { kind: "constraint", table: "avatars", name: "avatars_status_check", migration: "0013" },
];

const MIGRATIONS_APPLIED_TABLE = { kind: "table" as const, table: "_migrations_applied", migration: "(control)" };

async function verifyDirect() {
  const connection = resolveConnection()!;
  const { Client } = await import("pg");
  const client = new Client({ connectionString: connection.connectionString, connectionTimeoutMillis: 15000 });
  await client.connect();

  try {
    const [tables, columns, constraints, indexes, policies, rls] = await Promise.all([
      client.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'"),
      client.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'public'",
      ),
      client.query<{ table_name: string; conname: string; def: string }>(
        `select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as def
         from pg_constraint where connamespace = 'public'::regnamespace`,
      ),
      client.query<{ tablename: string; indexname: string }>("select tablename, indexname from pg_indexes where schemaname = 'public'"),
      client.query<{ tablename: string; policyname: string }>("select tablename, policyname from pg_policies where schemaname = 'public'"),
      client.query<{ relname: string; relrowsecurity: boolean }>(
        "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'",
      ),
    ]);

    const tableSet = new Set(tables.rows.map((r) => r.table_name));
    const columnSet = new Set(columns.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const constraintByName = new Map(constraints.rows.map((r) => [`${r.table_name}.${r.conname}`, r.def]));
    const indexSet = new Set(indexes.rows.map((r) => `${r.tablename}.${r.indexname}`));
    const policySet = new Set(policies.rows.map((r) => `${r.tablename}.${r.policyname}`));
    const rlsEnabled = new Set(rls.rows.filter((r) => r.relrowsecurity).map((r) => r.relname));

    function exists(check: ObjectCheck): boolean {
      switch (check.kind) {
        case "table":
          return tableSet.has(check.table);
        case "column":
          return columnSet.has(`${check.table}.${check.name}`);
        case "constraint":
          return constraintByName.has(`${check.table}.${check.name}`);
        case "index":
          return indexSet.has(`${check.table}.${check.name}`);
        case "policy":
          return policySet.has(`${check.table}.${check.name}`);
        case "rls":
          return rlsEnabled.has(check.table);
      }
    }

    const results = CHECKS.map((c) => ({ ...c, exists: exists(c) }));
    const controlTableExists = tableSet.has(MIGRATIONS_APPLIED_TABLE.table);

    // Chequeo específico del contenido del constraint de 0013 — el NOMBRE
    // del constraint es el mismo en 0011 y 0013 (0013 lo dropea y recrea
    // con la lista de valores ampliada), así que "existe" no basta para
    // saber si 0013 se aplicó: hace falta que su definición incluya 'draft'.
    const avatarsStatusCheckDef = constraintByName.get("avatars.avatars_status_check") ?? null;
    const migration0013Applied = avatarsStatusCheckDef !== null && avatarsStatusCheckDef.includes("draft");

    // Agrupa por migración para un veredicto claro.
    const byMigration = new Map<string, { total: number; present: number }>();
    for (const r of results) {
      const bucket = byMigration.get(r.migration) ?? { total: 0, present: 0 };
      bucket.total += 1;
      if (r.exists) bucket.present += 1;
      byMigration.set(r.migration, bucket);
    }

    const migrationSummary = Array.from(byMigration.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([migration, { total, present }]) => {
        let status: "applied" | "partial" | "not_applied";
        if (present === 0) status = "not_applied";
        else if (present === total) status = "applied";
        else status = "partial";
        // 0013 necesita también el chequeo de contenido, no solo nombre.
        if (migration === "0013" && status === "applied" && !migration0013Applied) status = "partial";
        return { migration, total, present, status };
      });

    console.log(
      JSON.stringify(
        {
          mode: "direct-postgres (autoritativo: information_schema + pg_catalog)",
          connectionSource: connection.source,
          projectRef: connection.ref,
          controlTableExists,
          migration0013ConstraintIncludesDraft: migration0013Applied,
          migrationSummary,
          details: results,
        },
        null,
        2,
      ),
    );

    const notApplied = migrationSummary.filter((m) => m.status !== "applied");
    if (notApplied.length > 0) {
      console.log(`\n${notApplied.length} migración(es) NO completamente aplicada(s): ${notApplied.map((m) => `${m.migration} (${m.status})`).join(", ")}`);
    } else {
      console.log("\nTodas las migraciones verificadas (0001-0013) están completamente aplicadas.");
    }
  } finally {
    await client.end();
  }
}

async function verifyViaRest() {
  console.log(
    "[verify-remote-schema] Sin credencial de conexión directa a Postgres — usando modo de respaldo vía REST " +
      "(solo existencia de tablas/columnas, mejor esfuerzo; no puede ver constraints/índices/RLS).",
  );
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const tableColumnChecks = CHECKS.filter((c) => c.kind === "table" || c.kind === "column");
  const results: Array<{ label: string; table: string; column?: string; exists: boolean; error: string | null }> = [];

  for (const check of tableColumnChecks) {
    const { error } = await service
      .from(check.table)
      .select(check.kind === "column" ? check.name! : "*", { head: true, count: "exact" })
      .limit(1);
    results.push({
      label: `${check.migration}: ${check.table}${check.kind === "column" ? `.${check.name}` : ""}`,
      table: check.table,
      column: check.kind === "column" ? check.name : undefined,
      exists: !error,
      error: error ? `${error.code ?? ""} ${error.message}`.trim() : null,
    });
  }

  const missing = results.filter((r) => !r.exists);
  console.log(JSON.stringify({ mode: "rest-fallback (mejor esfuerzo)", totalChecked: results.length, missingCount: missing.length, results }, null, 2));
  if (missing.length > 0) {
    console.log(`\n${missing.length} de ${results.length} columnas/tablas verificadas todavía NO existen en el esquema remoto (según REST).`);
  } else {
    console.log("\nTodas las columnas/tablas verificadas (según REST) ya existen en el esquema remoto.");
  }
}

async function main() {
  const connection = resolveConnection();
  if (connection) {
    await verifyDirect();
  } else {
    await verifyViaRest();
  }
}

main().catch((err) => {
  console.error("verify-remote-schema falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
