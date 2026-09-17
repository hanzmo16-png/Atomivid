/**
 * Deriva un host CANDIDATO del Connection Pooler de Supabase a partir de
 * datos 100% públicos — nunca intenta autenticarse contra él.
 *
 * Usado SOLO como ayuda diagnóstica cuando la conexión DIRECTA
 * (db.<ref>.supabase.co) falla con un error de alcance de red (confirmado
 * en ejecución real: ese host hoy resuelve solo a IPv6, y GitHub Actions
 * no tiene salida IPv6). El pooler de Supabase (Supavisor) es un servicio
 * compartido por región de AWS — su hostname sigue el patrón documentado
 * `aws-0-<región>.pooler.supabase.com`, pero solo enruta correctamente si
 * <región> es la región REAL donde vive el proyecto.
 *
 * Esta función deriva esa región de forma verificable, SIN adivinar y SIN
 * usar ninguna credencial: resuelve el prefijo IPv6 real al que apunta el
 * host directo del proyecto (DNS, público) y lo cruza contra el
 * `ip-ranges.json` que AWS publica oficialmente (routing público, no
 * información sensible). El resultado es un CANDIDATO a revisar por un
 * operador humano (o a usar vía SUPABASE_DB_HOST tras confirmarlo) — nunca
 * se usa automáticamente para autenticar. Intentar una conexión real con
 * la contraseña del proyecto contra un host derivado, sin ese paso de
 * confirmación humana, es exactamente el patrón que este archivo evita a
 * propósito.
 */
import dns from "node:dns/promises";

export type PoolerCandidate = { host: string; region: string; allRegions: string[] };

// BigInt() en vez de literales "0n"/"16n" — el target de tsconfig (ES2017)
// no admite la sintaxis de literal BigInt, solo el tipo/función en runtime.
const ZERO = BigInt(0);
const SIXTEEN = BigInt(16);
const ONE_TWENTY_EIGHT = BigInt(128);

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

function ipv6ToBigInt(addr: string): bigint {
  const groups = expandIPv6Groups(addr);
  let result = ZERO;
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ? BigInt(parseInt(groups[i], 16)) : ZERO;
    result = (result << SIXTEEN) | g;
  }
  return result;
}

/** Exportada solo para test — la lógica de match de prefijo es la parte crítica de seguridad de este archivo (un bug aquí podría sugerir una región equivocada). */
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

export function isNetworkReachabilityError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

/**
 * Deriva (sin conectar nunca, sin usar ninguna credencial) un candidato de
 * host de Connection Pooler para `ref`, a partir de DNS público + el
 * ip-ranges.json público de AWS. Devuelve null si no se pudo derivar nada
 * (p. ej. el host directo no resuelve, o no hay salida de red hacia
 * ip-ranges.amazonaws.com) — nunca lanza.
 */
export async function deriveCandidatePoolerHost(ref: string): Promise<PoolerCandidate | null> {
  const directHost = `db.${ref}.supabase.co`;

  let ipv6Addrs: string[];
  try {
    ipv6Addrs = await dns.resolve6(directHost);
  } catch {
    return null;
  }
  if (ipv6Addrs.length === 0) return null;

  let regions: string[];
  try {
    regions = await resolveAwsRegionsForIpv6(ipv6Addrs[0]);
  } catch {
    regions = [];
  }
  if (regions.length === 0) return null;

  return { host: `aws-0-${regions[0]}.pooler.supabase.com`, region: regions[0], allRegions: regions };
}
