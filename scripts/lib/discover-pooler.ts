/**
 * Descubrimiento AUTÓNOMO del host del Connection Pooler de Supabase —
 * usado SOLO cuando la conexión DIRECTA (db.<ref>.supabase.co) falla con
 * un error de alcance de red (ENETUNREACH/ENOTFOUND/EHOSTUNREACH/ETIMEDOUT
 * — confirmado en ejecución real: ese host hoy resuelve solo a IPv6 y
 * GitHub Actions no tiene salida IPv6). Nunca se dispara ante un fallo de
 * autenticación (contraseña incorrecta) — eso se deja como error explícito,
 * nunca como excusa para "probar otro host".
 *
 * El pooler de Supabase (Supavisor) es un servicio COMPARTIDO por región de
 * AWS — su hostname sigue el patrón documentado `aws-0-<región>.pooler.supabase.com`,
 * pero solo enruta correctamente si <región> es la región REAL donde vive
 * el proyecto. Esta función NUNCA adivina la región a ciegas: la deriva de
 * datos públicos verificables (el prefijo IPv6 al que resuelve el host
 * directo del proyecto, cruzado contra el `ip-ranges.json` que AWS publica
 * oficialmente — no es información sensible, es routing público), y solo
 * considera un candidato "confirmado" tras una conexión Postgres real y
 * EXITOSA (SELECT 1, de solo lectura) con la contraseña real — una
 * autenticación exitosa es prueba criptográfica de que el proyecto/tenant
 * coincide, no una suposición. Un intento contra la región equivocada
 * falla limpio (Supavisor no reconoce el tenant `postgres.<ref>` fuera de
 * su propia región) — nunca conecta "por accidente" a otro proyecto.
 *
 * Nunca se aplica ninguna migración ni se modifica nada durante el
 * descubrimiento — todos los intentos son de solo lectura (SELECT 1).
 */
import dns from "node:dns/promises";

export type DiscoveryAttempt = {
  host: string;
  region: string;
  outcome: "auth_ok" | "rejected_by_server" | "unreachable" | "pooler_dns_not_found";
};

export type DiscoveryResult = {
  confirmedHost: string | null;
  confirmedRegion: string | null;
  attempts: DiscoveryAttempt[];
};

// --- Utilidades IPv6 (sin dependencias externas) ---------------------

function expandIPv6Groups(addr: string): string[] {
  const [head, tail] = addr.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  if (addr.includes("::")) {
    const missing = 8 - headParts.length - tailParts.length;
    return [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
  }
  return addr.split(":");
}

// BigInt() en vez de literales "0n"/"16n" — el target de tsconfig (ES2017)
// no admite la sintaxis de literal BigInt, solo el tipo/función en runtime.
const ZERO = BigInt(0);
const SIXTEEN = BigInt(16);
const ONE_TWENTY_EIGHT = BigInt(128);

function ipv6ToBigInt(addr: string): bigint {
  const groups = expandIPv6Groups(addr);
  let result = ZERO;
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ? BigInt(parseInt(groups[i], 16)) : ZERO;
    result = (result << SIXTEEN) | g;
  }
  return result;
}

/** Exportada solo para test — la lógica de match de prefijo es la parte crítica de seguridad de este archivo (un bug aquí podría derivar una región equivocada). */
export function ipv6InPrefix(addr: string, prefix: string): boolean {
  const [network, bitsStr] = prefix.split("/");
  const bits = BigInt(parseInt(bitsStr, 10));
  const shift = ONE_TWENTY_EIGHT - bits;
  return (ipv6ToBigInt(addr) >> shift) === (ipv6ToBigInt(network) >> shift);
}

/**
 * Cruza una IPv6 contra el ip-ranges.json PÚBLICO y oficial de AWS —
 * routing público, no información sensible del proyecto — para derivar de
 * forma verificable en qué región de AWS vive esa dirección. Devuelve
 * regiones candidatas (normalmente una sola) o [] si no se pudo determinar
 * (p. ej. sin salida de red hacia ip-ranges.amazonaws.com).
 */
async function resolveAwsRegionsForIpv6(addr: string): Promise<string[]> {
  const response = await fetch("https://ip-ranges.amazonaws.com/ip-ranges.json", { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return [];
  const data = (await response.json()) as { ipv6_prefixes?: Array<{ ipv6_prefix: string; region: string; service: string }> };
  const prefixes = data.ipv6_prefixes ?? [];
  const regions = new Set<string>();
  for (const entry of prefixes) {
    if (entry.service === "EC2" && ipv6InPrefix(addr, entry.ipv6_prefix)) {
      regions.add(entry.region);
    }
  }
  return Array.from(regions);
}

/** Exportada solo para test. */
export function classifyPgError(err: unknown): "rejected_by_server" | "unreachable" {
  const code = (err as { code?: string } | undefined)?.code;
  // Códigos SQLSTATE de Postgres (5 caracteres, p. ej. 28P01 = auth
  // fallida) indican que SÍ se alcanzó un servidor Postgres/Supavisor real
  // que respondió — informativo (probó el host, pero lo rechazó), muy
  // distinto de nunca haber podido conectar (ENOTFOUND/ENETUNREACH/etc,
  // códigos de `net`/`dns`, no de Postgres).
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "rejected_by_server";
  return "unreachable";
}

export function isNetworkReachabilityError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

/**
 * Intenta descubrir y CONFIRMAR (con una conexión real, exitosa y de solo
 * lectura) el host del Connection Pooler del proyecto `ref`, usando la
 * MISMA contraseña ya autorizada (SUPABASE_DB_PASSWORD). Nunca aplica SQL
 * de escritura. Devuelve el host confirmado solo si una autenticación real
 * tuvo éxito — si no, `confirmedHost` es null y `attempts` documenta,  de
 * forma saneada, cada candidato probado y por qué no sirvió.
 */
export async function discoverPoolerHost(ref: string, password: string): Promise<DiscoveryResult> {
  const attempts: DiscoveryAttempt[] = [];
  const directHost = `db.${ref}.supabase.co`;

  let ipv6Addrs: string[];
  try {
    ipv6Addrs = await dns.resolve6(directHost);
  } catch {
    return { confirmedHost: null, confirmedRegion: null, attempts };
  }
  if (ipv6Addrs.length === 0) return { confirmedHost: null, confirmedRegion: null, attempts };

  let regions: string[];
  try {
    regions = await resolveAwsRegionsForIpv6(ipv6Addrs[0]);
  } catch {
    regions = [];
  }
  if (regions.length === 0) return { confirmedHost: null, confirmedRegion: null, attempts };

  const { Client } = await import("pg");

  for (const region of regions) {
    const host = `aws-0-${region}.pooler.supabase.com`;

    try {
      await dns.resolve4(host);
    } catch {
      attempts.push({ host, region, outcome: "pooler_dns_not_found" });
      continue;
    }

    const client = new Client({
      connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`,
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      attempts.push({ host, region, outcome: "auth_ok" });
      return { confirmedHost: host, confirmedRegion: region, attempts };
    } catch (err) {
      attempts.push({ host, region, outcome: classifyPgError(err) });
      try {
        await client.end();
      } catch {
        // ya estaba cerrada o nunca llegó a abrir — ignorar.
      }
    }
  }

  return { confirmedHost: null, confirmedRegion: null, attempts };
}
