/**
 * Verificación de solo lectura del esquema remoto de Supabase — usa
 * ÚNICAMENTE la service role key (REST/PostgREST vía supabase-js, ya
 * usada en producción por el resto del pipeline), sin SQL crudo ni
 * conexión directa a Postgres. Por cada tabla/columna candidata hace un
 * HEAD request (`head: true`, cero filas transferidas) — si la columna no
 * existe, PostgREST responde con un error (42703 u otro) que se reporta
 * tal cual, nunca se oculta ni se asume.
 *
 * Uso: npx tsx scripts/verify-remote-schema.ts
 * Requiere NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (las
 * mismas que ya usa el resto del pipeline en producción).
 */
export {};

type Check = { table: string; column?: string; label: string };

const CHECKS: Check[] = [
  { table: "video_requests", label: "tabla video_requests (base)" },
  { table: "video_requests", column: "mode", label: "video_requests.mode (migración 0011)" },
  { table: "video_requests", column: "avatar_id", label: "video_requests.avatar_id (migración 0011)" },
  { table: "video_requests", column: "avatar_provider_video_job_id", label: "video_requests.avatar_provider_video_job_id (migración 0011)" },
  { table: "video_requests", column: "avatar_render_status", label: "video_requests.avatar_render_status (migración 0011)" },
  { table: "video_requests", column: "avatar_voice_id", label: "video_requests.avatar_voice_id (migración 0011)" },
  { table: "video_requests", column: "idempotency_key", label: "video_requests.idempotency_key (migración 0011)" },
  { table: "avatars", label: "tabla avatars (migración 0011)" },
  { table: "generation_costs", column: "image_provider", label: "generation_costs.image_provider (migración 0010)" },
  { table: "generation_costs", column: "image_generation_count", label: "generation_costs.image_generation_count (migración 0010)" },
  { table: "generation_costs", column: "image_cost_usd", label: "generation_costs.image_cost_usd (migración 0010)" },
  { table: "generation_costs", column: "avatar_provider", label: "generation_costs.avatar_provider (migración 0011)" },
  { table: "generation_costs", column: "image_requested_count", label: "generation_costs.image_requested_count (migración 0012)" },
  { table: "generation_costs", column: "image_reused_count", label: "generation_costs.image_reused_count (migración 0012)" },
  { table: "generation_costs", column: "image_dry_run", label: "generation_costs.image_dry_run (migración 0012)" },
  { table: "generation_costs", column: "image_model", label: "generation_costs.image_model (migración 0012)" },
  { table: "generation_costs", column: "image_size", label: "generation_costs.image_size (migración 0012)" },
];

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();

  const results: Array<{ label: string; table: string; column?: string; exists: boolean; error: string | null }> = [];

  for (const check of CHECKS) {
    const { error } = await service
      .from(check.table)
      .select(check.column ?? "id", { head: true, count: "exact" })
      .limit(1);
    results.push({
      label: check.label,
      table: check.table,
      column: check.column,
      exists: !error,
      error: error ? `${error.code ?? ""} ${error.message}`.trim() : null,
    });
  }

  const missing = results.filter((r) => !r.exists);
  console.log(
    JSON.stringify(
      {
        totalChecked: results.length,
        missingCount: missing.length,
        results,
      },
      null,
      2,
    ),
  );

  if (missing.length > 0) {
    console.log(`\n${missing.length} de ${results.length} columnas/tablas verificadas todavía NO existen en el esquema remoto.`);
  } else {
    console.log("\nTodas las columnas/tablas verificadas ya existen en el esquema remoto.");
  }
}

main().catch((err) => {
  console.error("verify-remote-schema falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
