/**
 * Helper compartido para derivar una conexión DIRECTA a Postgres del
 * proyecto real de Supabase, usado tanto por apply-supabase-migration.ts
 * como por verify-remote-schema.ts — evita duplicar la lógica de
 * derivación del project ref entre ambos scripts.
 *
 * La service role key (SUPABASE_SERVICE_ROLE_KEY) NUNCA alcanza para esto
 * — solo habilita PostgREST (CRUD por REST/Storage), que no expone DDL ni
 * catálogos de Postgres (information_schema/pg_catalog). Se necesita UNA
 * de estas dos vías, en este orden de preferencia:
 *
 *   1. SUPABASE_DB_URL — cadena de conexión completa ya armada.
 *   2. SUPABASE_DB_PASSWORD + un project ref — el ref puede venir de
 *      SUPABASE_PROJECT_REF explícito, o derivarse de forma seudo-segura
 *      de SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL (que ya tiene la forma
 *      `https://<ref>.supabase.co` — el ref es la subcadena pública del
 *      proyecto, no un secreto, y es la MISMA URL que ya usa el resto del
 *      pipeline en producción vía REST).
 *
 * Nunca imprime ni expone la contraseña ni la cadena de conexión completa
 * — solo el ref (que no es secreto) y la fuente usada para construirla.
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
  source: "SUPABASE_DB_URL" | "SUPABASE_PROJECT_REF" | "SUPABASE_URL(derived)";
};

export function resolveConnection(): ResolvedConnection | null {
  if (process.env.SUPABASE_DB_URL) {
    return { connectionString: process.env.SUPABASE_DB_URL, ref: null, source: "SUPABASE_DB_URL" };
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) return null;

  const explicitRef = process.env.SUPABASE_PROJECT_REF;
  if (explicitRef) {
    return {
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@db.${explicitRef}.supabase.co:5432/postgres`,
      ref: explicitRef,
      source: "SUPABASE_PROJECT_REF",
    };
  }

  const derivedRef = deriveProjectRef(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (derivedRef) {
    return {
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@db.${derivedRef}.supabase.co:5432/postgres`,
      ref: derivedRef,
      source: "SUPABASE_URL(derived)",
    };
  }

  return null;
}

export const MISSING_CREDENTIAL_MESSAGE =
  "BLOQUEADO: falta una credencial de conexión directa a Postgres.\n" +
  "La service role key (SUPABASE_SERVICE_ROLE_KEY) NO alcanza — solo habilita PostgREST (CRUD por REST), " +
  "que no expone DDL (ALTER TABLE/CREATE TABLE) ni los catálogos de Postgres.\n" +
  "Configura UNA de estas opciones como GitHub Secret del repositorio:\n" +
  "  - SUPABASE_DB_URL: la cadena de conexión completa (Project Settings → Database → Connection string → URI), o\n" +
  "  - SUPABASE_DB_PASSWORD (la contraseña de la base de datos, no la service role key) junto con SUPABASE_URL " +
  "(ya existente — el project ref se deriva de ahí automáticamente) o, si prefieres ser explícito, SUPABASE_PROJECT_REF.\n" +
  "Ninguna combinación válida está configurada actualmente — no se ejecutó ninguna operación.";
