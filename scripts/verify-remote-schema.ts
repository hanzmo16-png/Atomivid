/**
 * Verificación del esquema remoto de Supabase contra TODO el historial de
 * migraciones (0001-0014).
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
import { resolveConnection, connectResolved } from "./lib/supabase-db";
import { CHECKS, computeSchemaSnapshot } from "./lib/migration-schema-map";

export {};

async function verifyDirect() {
  const { client, connection } = await connectResolved();
  try {
    const snapshot = await computeSchemaSnapshot(client, connection.source, connection.ref);
    console.log(JSON.stringify({ mode: "direct-postgres (autoritativo: information_schema + pg_catalog)", ...snapshot }, null, 2));

    const notApplied = snapshot.migrationSummary.filter((m) => m.status !== "applied");
    if (notApplied.length > 0) {
      console.log(`\n${notApplied.length} migración(es) NO completamente aplicada(s): ${notApplied.map((m) => `${m.migration} (${m.status})`).join(", ")}`);
    } else {
      console.log("\nTodas las migraciones verificadas (0001-0014) están completamente aplicadas.");
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
  if (!connection) {
    await verifyViaRest();
    return;
  }
  try {
    await verifyDirect();
  } catch (err) {
    // La verificación es de solo lectura y "mejor esfuerzo" por diseño —
    // si la conexión directa/pooler no está disponible (p. ej. red, o
    // SUPABASE_DB_HOST aún no configurado), cae a REST en vez de fallar
    // todo el script; el error ya queda registrado, sin exponer secretos.
    console.error(`[verify-remote-schema] Conexión autoritativa no disponible: ${err instanceof Error ? err.message : err}`);
    console.error("[verify-remote-schema] Cayendo a modo REST de mejor esfuerzo — el diagnóstico autoritativo de constraints/índices/RLS no está disponible.");
    await verifyViaRest();
  }
}

main().catch((err) => {
  console.error("verify-remote-schema falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
