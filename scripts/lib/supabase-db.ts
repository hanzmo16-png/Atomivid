/**
 * Helper compartido para derivar una conexión a Postgres del proyecto real
 * de Supabase, usado tanto por apply-supabase-migration.ts como por
 * verify-remote-schema.ts — evita duplicar la lógica de derivación del
 * project ref/host entre ambos scripts.
 *
 * La service role key (SUPABASE_SERVICE_ROLE_KEY) NUNCA alcanza para esto
 * — solo habilita PostgREST (CRUD por REST/Storage), que no expone DDL ni
 * catálogos de Postgres (information_schema/pg_catalog). Se necesita UNA
 * de estas vías, en este orden de preferencia:
 *
 *   1. SUPABASE_DB_URL — cadena de conexión completa ya armada.
 *   2. SUPABASE_DB_PASSWORD + un project ref (SUPABASE_PROJECT_REF
 *      explícito, o derivado de SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL —
 *      que ya tiene la forma `https://<ref>.supabase.co`; el ref es la
 *      subcadena pública del proyecto, no un secreto) — construye por
 *      defecto la conexión DIRECTA `db.<ref>.supabase.co:5432`.
 *
 *      *** Restricción técnica comprobada (confirmada en ejecución real,
 *      2026-09-17): el host directo de Supabase resuelve HOY solo a una
 *      dirección IPv6, y los runners de GitHub Actions NO tienen salida
 *      IPv6 — la conexión falla con ENETUNREACH antes de siquiera llegar
 *      a autenticar (no es un problema de contraseña ni de proyecto). Es
 *      un problema de red conocido de Supabase (documentado por ellos
 *      mismos como motivo para usar el "Connection Pooler" en entornos sin
 *      IPv6, como GitHub Actions o Vercel) — no un error de esta
 *      implementación. ***
 *
 *      Solución sin exponer ni adivinar nada sensible: si además se
 *      configura SUPABASE_DB_HOST (p. ej. "aws-0-us-east-1.pooler.supabase.com",
 *      visible en Project Settings → Database → Connection Pooler del
 *      proyecto real — NO es secreto, es solo un nombre de host), este
 *      helper arma la conexión contra ESE host en vez del directo, y
 *      ajusta automáticamente el usuario a "postgres.<ref>" (formato que
 *      exige el pooler de Supabase — con usuario "postgres" a secas el
 *      pooler no puede enrutar al proyecto correcto). SUPABASE_DB_PORT es
 *      opcional (por defecto 5432, modo "session" — compatible con DDL
 *      dentro de una transacción, a diferencia del modo "transaction" en
 *      6543).
 *
 * Nunca imprime ni expone la contraseña ni la cadena de conexión completa
 * — solo el ref/host (no son secretos) y la fuente usada para construirla.
 */
export {};

export function deriveProjectRef(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = url.trim().match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
  return match ? match[1] : null;
}

export type ResolvedConnection = {
  connectionString: string;
  ref: string | null;
  host: string | null;
  source: "SUPABASE_DB_URL" | "SUPABASE_PROJECT_REF" | "SUPABASE_URL(derived)";
};

export function resolveConnection(): ResolvedConnection | null {
  if (process.env.SUPABASE_DB_URL) {
    return { connectionString: process.env.SUPABASE_DB_URL, ref: null, host: null, source: "SUPABASE_DB_URL" };
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) return null;

  const explicitRef = process.env.SUPABASE_PROJECT_REF;
  const ref = explicitRef || deriveProjectRef(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) return null;
  const source: ResolvedConnection["source"] = explicitRef ? "SUPABASE_PROJECT_REF" : "SUPABASE_URL(derived)";

  const poolerHost = process.env.SUPABASE_DB_HOST?.trim();
  if (poolerHost) {
    const port = process.env.SUPABASE_DB_PORT?.trim() || "5432";
    // El pooler de Supabase (Supavisor) identifica el proyecto por el
    // usuario "postgres.<ref>", no por el host — a diferencia de la
    // conexión directa, donde "postgres" a secas basta porque el host ya
    // es específico del proyecto.
    return {
      connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${poolerHost}:${port}/postgres`,
      ref,
      host: poolerHost,
      source,
    };
  }

  const directHost = `db.${ref}.supabase.co`;
  return {
    connectionString: `postgresql://postgres:${encodeURIComponent(password)}@${directHost}:5432/postgres`,
    ref,
    host: directHost,
    source,
  };
}

export const MISSING_CREDENTIAL_MESSAGE =
  "BLOQUEADO: falta una credencial de conexión directa a Postgres.\n" +
  "La service role key (SUPABASE_SERVICE_ROLE_KEY) NO alcanza — solo habilita PostgREST (CRUD por REST), " +
  "que no expone DDL (ALTER TABLE/CREATE TABLE) ni los catálogos de Postgres.\n" +
  "Configura UNA de estas opciones como GitHub Secret del repositorio:\n" +
  "  - SUPABASE_DB_URL: la cadena de conexión completa (Project Settings → Database → Connection string → URI), o\n" +
  "  - SUPABASE_DB_PASSWORD (la contraseña de la base de datos, no la service role key) junto con SUPABASE_URL " +
  "(ya existente — el project ref se deriva de ahí automáticamente) o, si prefieres ser explícito, SUPABASE_PROJECT_REF.\n" +
  "  - Si la conexión DIRECTA falla con ENETUNREACH (host solo IPv6, sin salida IPv6 en este runner): añade además " +
  "SUPABASE_DB_HOST con el host del Connection Pooler del proyecto (Project Settings → Database → Connection Pooler, " +
  "no es secreto) — opcionalmente SUPABASE_DB_PORT (5432 por defecto).\n" +
  "Ninguna combinación válida está configurada actualmente — no se ejecutó ninguna operación.";
