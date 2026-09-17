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
 *      *** Descubrimiento autónomo (2026-09-17): si NO se configura
 *      SUPABASE_DB_HOST explícitamente y la conexión directa falla con un
 *      error de alcance de red, `connectResolved()` (abajo) intenta
 *      descubrir el pooler correcto por su cuenta — nunca adivinando a
 *      ciegas: deriva la región de AWS a partir del prefijo IPv6 real al
 *      que resuelve el host directo del proyecto (dato público, cruzado
 *      contra el ip-ranges.json oficial de AWS) y solo confirma un
 *      candidato tras autenticar con éxito (SELECT 1, de solo lectura) con
 *      la contraseña ya autorizada. Ver scripts/lib/discover-pooler.ts. ***
 *
 * Nunca imprime ni expone la contraseña ni la cadena de conexión completa
 * — solo el ref/host (no son secretos) y la fuente usada para construirla.
 */
import { discoverPoolerHost, isNetworkReachabilityError } from "./discover-pooler";

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

/** Se lanza cuando la conexión directa falla por red Y el descubrimiento autónomo del pooler tampoco pudo confirmar un host — lleva la evidencia saneada de cada candidato probado, para poder reportarla sin exponer nada sensible. */
export class PoolerDiscoveryFailedError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly attempts: import("./discover-pooler").DiscoveryAttempt[],
  ) {
    super(
      "La conexión directa falló por red y el descubrimiento autónomo del Connection Pooler no pudo confirmar ningún host " +
        `(${attempts.length} candidato(s) probado(s): ${attempts.map((a) => `${a.host}→${a.outcome}`).join(", ") || "ninguno — no se pudo derivar la región desde el prefijo IPv6"}).`,
    );
    this.name = "PoolerDiscoveryFailedError";
  }
}

/**
 * Resuelve la conexión y devuelve un cliente `pg` YA CONECTADO. Si la
 * conexión directa (derivada, sin SUPABASE_DB_HOST/SUPABASE_DB_URL
 * explícitos) falla con un error de alcance de red, intenta el
 * descubrimiento autónomo del pooler (ver cabecera del archivo) antes de
 * rendirse. Nunca reintenta ante un fallo de autenticación (contraseña
 * incorrecta) — eso se propaga tal cual, como error explícito.
 */
export async function connectResolved(): Promise<{
  client: import("pg").Client;
  connection: ResolvedConnection;
  discovery?: { confirmedHost: string; confirmedRegion: string; attempts: import("./discover-pooler").DiscoveryAttempt[] };
}> {
  const connection = resolveConnection();
  if (!connection) throw new Error(MISSING_CREDENTIAL_MESSAGE);

  const { Client } = await import("pg");

  async function connect(conn: ResolvedConnection) {
    const client = new Client({ connectionString: conn.connectionString, connectionTimeoutMillis: 15000 });
    await client.connect();
    return client;
  }

  try {
    const client = await connect(connection);
    return { client, connection };
  } catch (err) {
    const password = process.env.SUPABASE_DB_PASSWORD;
    const canAutoDiscover =
      isNetworkReachabilityError(err) &&
      !process.env.SUPABASE_DB_URL &&
      !process.env.SUPABASE_DB_HOST?.trim() &&
      Boolean(connection.ref) &&
      Boolean(password);
    if (!canAutoDiscover) throw err;

    const discovery = await discoverPoolerHost(connection.ref!, password!);
    if (!discovery.confirmedHost || !discovery.confirmedRegion) {
      throw new PoolerDiscoveryFailedError(err, discovery.attempts);
    }

    const poolerConnection: ResolvedConnection = {
      connectionString: `postgresql://postgres.${connection.ref}:${encodeURIComponent(password!)}@${discovery.confirmedHost}:5432/postgres`,
      ref: connection.ref,
      host: discovery.confirmedHost,
      source: connection.source,
    };
    const client = await connect(poolerConnection);
    return {
      client,
      connection: poolerConnection,
      discovery: { confirmedHost: discovery.confirmedHost, confirmedRegion: discovery.confirmedRegion, attempts: discovery.attempts },
    };
  }
}

export const MISSING_CREDENTIAL_MESSAGE =
  "BLOQUEADO: falta una credencial de conexión directa a Postgres.\n" +
  "La service role key (SUPABASE_SERVICE_ROLE_KEY) NO alcanza — solo habilita PostgREST (CRUD por REST), " +
  "que no expone DDL (ALTER TABLE/CREATE TABLE) ni los catálogos de Postgres.\n" +
  "Configura UNA de estas opciones como GitHub Secret del repositorio:\n" +
  "  - SUPABASE_DB_URL: la cadena de conexión completa (Project Settings → Database → Connection string → URI), o\n" +
  "  - SUPABASE_DB_PASSWORD (la contraseña de la base de datos, no la service role key) junto con SUPABASE_URL " +
  "(ya existente — el project ref se deriva de ahí automáticamente) o, si prefieres ser explícito, SUPABASE_PROJECT_REF.\n" +
  "Con SUPABASE_DB_PASSWORD presente, si la conexión DIRECTA falla por red (host solo IPv6, sin salida IPv6 en este " +
  "runner) el mecanismo intenta descubrir y confirmar el Connection Pooler correcto por su cuenta antes de rendirse " +
  "(ver scripts/lib/discover-pooler.ts) — solo hace falta configurar SUPABASE_DB_HOST manualmente si ese " +
  "descubrimiento autónomo no logra confirmar ningún host.\n" +
  "Ninguna combinación válida está configurada actualmente — no se ejecutó ninguna operación.";
