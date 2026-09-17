/**
 * Aplica una migración de supabase/migrations/*.sql al proyecto real de
 * Supabase — mecanismo AUTÓNOMO (sin copiar/pegar SQL a mano en el SQL
 * Editor) pensado para ejecutarse dentro de un workflow de GitHub Actions
 * con las credenciales ya configuradas como Secrets.
 *
 * NO usa la service role key para esto (PostgREST, que es lo único que la
 * service role key habilita, NO expone DDL — "ALTER TABLE" no es una
 * operación REST) — usa una conexión directa a Postgres vía `pg`, con la
 * cadena de conexión que exige explícitamente SUPABASE_DB_URL (o, en su
 * defecto, SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD
 * para construirla). Si NINGUNA de esas credenciales está configurada,
 * este script falla de forma clara y explícita — nunca intenta un atajo
 * inseguro ni asume una credencial que no está.
 *
 * Nunca ejecuta una migración cuyo nombre de archivo ya esté registrado
 * en la tabla de control `public._migrations_applied` (se crea sola si no
 * existe) — evita reaplicar por accidente. Corre TODO el archivo dentro
 * de una única transacción — si algo falla a mitad, se revierte entero,
 * nunca deja el esquema a medias.
 *
 * Uso: npx tsx scripts/apply-supabase-migration.ts <archivo.sql>
 */
import fs from "node:fs/promises";
import path from "node:path";

export {};

function buildConnectionString(): string | null {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const ref = process.env.SUPABASE_PROJECT_REF;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (ref && password) {
    // Conexión DIRECTA (no el connection pooler, cuyo host depende de la
    // región del proyecto y no se puede derivar solo del ref — adivinarla
    // sería tan arriesgado como no tener la credencial). El host directo
    // `db.<ref>.supabase.co` SÍ es un formato fijo y documentado por
    // Supabase para cualquier proyecto, sin necesidad de conocer su región.
    return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
  }
  return null;
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    throw new Error("Uso: npx tsx scripts/apply-supabase-migration.ts <archivo.sql> (relativo a supabase/migrations/)");
  }

  const connectionString = buildConnectionString();
  if (!connectionString) {
    console.error(
      "[apply-supabase-migration] BLOQUEADO: falta una credencial de conexión directa a Postgres.\n" +
        "La service role key (SUPABASE_SERVICE_ROLE_KEY) NO alcanza — solo habilita PostgREST (CRUD por REST), " +
        "que no expone DDL (ALTER TABLE/CREATE TABLE).\n" +
        "Configura UNA de estas opciones como GitHub Secret del repositorio:\n" +
        "  - SUPABASE_DB_URL: la cadena de conexión completa (Project Settings → Database → Connection string → URI), o\n" +
        "  - SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD (la contraseña de la base de datos, no la service role key).\n" +
        "Ninguna de las dos está configurada actualmente — no se ejecutó ninguna operación.",
    );
    process.exitCode = 2;
    return;
  }

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const filePath = path.join(migrationsDir, fileArg);
  const sql = await fs.readFile(filePath, "utf8");
  const migrationName = path.basename(fileArg);

  // Import dinámico — `pg` es una dependencia opcional para este script
  // puntual, no del resto de la app (que nunca conecta directo a Postgres,
  // solo vía Supabase REST/Storage) — ver package.json.
  const { Client } = await import("pg");
  const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });

  await client.connect();
  try {
    await client.query(`
      create table if not exists public._migrations_applied (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const already = await client.query("select 1 from public._migrations_applied where name = $1", [migrationName]);
    if ((already.rowCount ?? 0) > 0) {
      console.log(`[apply-supabase-migration] "${migrationName}" ya está registrada como aplicada — no se repite.`);
      return;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("insert into public._migrations_applied (name) values ($1)", [migrationName]);
      await client.query("COMMIT");
      console.log(`[apply-supabase-migration] "${migrationName}" aplicada y confirmada correctamente.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[apply-supabase-migration] FALLÓ:", err instanceof Error ? err.message : err);
  process.exit(1);
});
