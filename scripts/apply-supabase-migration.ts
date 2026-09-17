/**
 * Aplica TODAS las migraciones de supabase/migrations/*.sql que todavía no
 * estén registradas como aplicadas, en orden numérico, al proyecto real de
 * Supabase — mecanismo AUTÓNOMO (sin copiar/pegar SQL a mano en el SQL
 * Editor) pensado para ejecutarse dentro de un workflow de GitHub Actions
 * con las credenciales ya configuradas como Secrets.
 *
 * NO usa la service role key para esto (PostgREST, que es lo único que la
 * service role key habilita, NO expone DDL) — usa una conexión directa a
 * Postgres vía `pg` (ver scripts/lib/supabase-db.ts para cómo se resuelve
 * la cadena de conexión). Si no hay ninguna credencial válida, este script
 * falla de forma clara y explícita — nunca intenta un atajo inseguro ni
 * asume una credencial que no está.
 *
 * Salvaguardas:
 *  - Antes de aplicar CUALQUIER migración pendiente, escanea su SQL en
 *    busca de patrones destructivos (DROP TABLE/COLUMN, TRUNCATE, DELETE
 *    FROM, UPDATE público masivo, ALTER COLUMN ... TYPE, RENAME). Si
 *    encuentra alguno fuera de un comentario `--`, se detiene sin aplicar
 *    NADA de esa migración en adelante — nunca ejecuta SQL potencialmente
 *    destructivo de forma automática.
 *  - Nunca ejecuta una migración cuyo nombre de archivo ya esté registrado
 *    en la tabla de control `public._migrations_applied` (se crea sola si
 *    no existe) — evita reaplicar por accidente (idempotencia).
 *  - Cada migración corre en su propia transacción — si algo falla a
 *    mitad, se revierte entera; nunca deja el esquema a medias. Se detiene
 *    inmediatamente en el primer fallo, sin intentar las siguientes.
 *
 * Uso: npx tsx scripts/apply-supabase-migration.ts
 *      (opcional: pasa un nombre de archivo puntual como argv[2] para
 *      aplicar solo esa migración, si ya está pendiente)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConnection, connectResolved, MISSING_CREDENTIAL_MESSAGE } from "./lib/supabase-db";

export {};

// Mismo patrón usado para el escaneo de seguridad manual de todo el
// historial de migraciones — cualquier coincidencia fuera de una línea
// comentada con `--` bloquea la aplicación automática de esa migración.
const DESTRUCTIVE_PATTERN = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|update\s+public\.|alter\s+column\s+\w+\s+type|rename\s+(table|column))\b/i;

function findDestructiveLines(sql: string): string[] {
  return sql
    .split("\n")
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => {
      const withoutComment = line.split("--")[0];
      return DESTRUCTIVE_PATTERN.test(withoutComment);
    })
    .map(({ line, i }) => `  línea ${i}: ${line.trim()}`);
}

async function main() {
  if (!resolveConnection()) {
    console.error(`[apply-supabase-migration] ${MISSING_CREDENTIAL_MESSAGE}`);
    process.exitCode = 2;
    return;
  }

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const onlyFile = process.argv[2];
  const allFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const files = onlyFile ? allFiles.filter((f) => f === onlyFile) : allFiles;
  if (onlyFile && files.length === 0) {
    throw new Error(`No se encontró "${onlyFile}" en supabase/migrations/`);
  }

  // connectResolved() intenta la conexión resuelta (directa o pooler
  // explícito vía SUPABASE_DB_HOST). Si falla por alcance de red, NUNCA
  // intenta autenticarse contra un host inferido automáticamente — el
  // error incluye un candidato derivado solo de datos públicos, para que
  // un operador lo confirme y lo configure explícitamente.
  let client: import("pg").Client;
  try {
    const result = await connectResolved();
    client = result.client;
    console.log(
      `[apply-supabase-migration] Conexión resuelta vía ${result.connection.source}${result.connection.ref ? ` (ref: ${result.connection.ref})` : ""} — host/credenciales nunca se imprimen.`,
    );
  } catch (err) {
    console.error(`[apply-supabase-migration] BLOQUEADO: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 4;
    return;
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      create table if not exists public._migrations_applied (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    for (const migrationName of files) {
      const already = await client.query("select 1 from public._migrations_applied where name = $1", [migrationName]);
      if ((already.rowCount ?? 0) > 0) {
        console.log(`[apply-supabase-migration] "${migrationName}" ya está registrada como aplicada — se omite.`);
        skipped.push(migrationName);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, migrationName), "utf8");
      const destructiveLines = findDestructiveLines(sql);
      if (destructiveLines.length > 0) {
        console.error(
          `[apply-supabase-migration] DETENIDO antes de "${migrationName}": contiene SQL potencialmente destructivo fuera de comentarios:\n${destructiveLines.join("\n")}\n` +
            "No se aplica automáticamente. Revísala manualmente y, si es intencional, aplícala por un mecanismo separado con revisión humana explícita.",
        );
        process.exitCode = 3;
        return;
      }

      console.log(`[apply-supabase-migration] Aplicando "${migrationName}"...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into public._migrations_applied (name) values ($1)", [migrationName]);
        await client.query("COMMIT");
        console.log(`[apply-supabase-migration] "${migrationName}" aplicada y confirmada correctamente.`);
        applied.push(migrationName);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[apply-supabase-migration] FALLÓ "${migrationName}" — revertida, no se intentan las siguientes.`);
        throw err;
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    `\n[apply-supabase-migration] Resumen: ${applied.length} aplicada(s) [${applied.join(", ") || "-"}], ${skipped.length} ya presente(s) [${skipped.join(", ") || "-"}].`,
  );
}

main().catch((err) => {
  console.error("[apply-supabase-migration] FALLÓ:", err instanceof Error ? err.message : err);
  process.exit(1);
});
