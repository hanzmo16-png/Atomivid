/**
 * Wikimedia Commons como fuente de PROPUESTAS (nunca de confianza).
 *
 * Commons → propuesta → filtro de licencia (lista cerrada V1) → filtro de
 * calidad (lado largo ≥ 1280 px) → [curaduría del servidor] → registro
 * verificado → selector existente → puertas de Visual Excellence.
 *
 * Nada de lo que devuelve Commons (P180/depicts, título, categoría,
 * descripción) crea un vínculo de identidad o de prueba: eso solo lo hace
 * la decisión de un curador humano sobre el par exacto (asset-curation.ts),
 * rehidratada por el servidor. Este módulo no
 * se conecta al selector.
 */
import type { BeatVisual } from "@/lib/video/long-form/visual-intents";
import { requiresEvidence, requiresIdentity } from "@/lib/video/long-form/visual-intents";
import { licenseEligibility, qualityEligibility, type AssetProposal } from "@/lib/video/long-form/verified-assets";

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "Atomivid/1.0 (documentary research; https://atomivid.com)";

/**
 * Consulta para una escena PROTEGIDA. IDENTITY: la persona (nunca su acción
 * subordinada). EVIDENCE: solo si declaró su proposición. Otras clases: nada.
 */
export function commonsQueryFor(visual: BeatVisual): string | null {
  if (visual.identity) return visual.identity.name;
  if (requiresIdentity(visual)) return null;
  if (requiresEvidence(visual)) return visual.evidence ? [visual.subject ?? visual.description, visual.era].filter(Boolean).join(" ") : null;
  return null;
}

type ExtValue = { value?: string } | undefined;
export type CommonsPage = {
  title: string;
  imageinfo?: { url?: string; descriptionurl?: string; width?: number; height?: number; mime?: string; extmetadata?: Record<string, ExtValue> }[];
};

const strip = (html: string | undefined) => (html ?? "").replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

/** Una página de Commons → propuesta, o el motivo exacto del rechazo (licencia, calidad, metadatos). */
export function proposalFromCommonsPage(page: CommonsPage): { proposal: AssetProposal } | { rejected: string } {
  const info = page.imageinfo?.[0];
  if (!info?.url || !info.descriptionurl) return { rejected: "sin URL de medio o de descripción" };
  const meta = info.extmetadata ?? {};
  const get = (k: string) => strip((meta[k] as ExtValue)?.value);
  const license = { code: get("License"), shortName: get("LicenseShortName"), restrictions: get("Restrictions"), usageTerms: get("UsageTerms"), copyrighted: get("Copyrighted") };
  const legal = licenseEligibility(license);
  if (!legal.eligible) return { rejected: `licencia: ${legal.reason}` };
  const quality = qualityEligibility({ width: info.width, height: info.height, mime: info.mime });
  if (quality.status === "QUALITY_INELIGIBLE") return { rejected: `calidad: ${quality.reason}` };
  return {
    proposal: {
      source: "commons",
      title: page.title,
      sourceUrl: info.descriptionurl,
      mediaUrl: info.url,
      mime: info.mime!,
      width: info.width!,
      height: info.height!,
      license,
      licenseUrl: get("LicenseUrl") || undefined,
      creator: get("Artist") || undefined,
      attribution: get("Attribution") || get("Credit") || undefined,
      description: get("ImageDescription") || get("ObjectName") || undefined,
      categories: get("Categories") ? get("Categories").split("|").map((c) => c.trim()).filter(Boolean) : undefined,
    },
  };
}

/** Búsqueda (gratuita, sin credenciales). Solo para herramientas de curaduría; los tests usan `fetchImpl` falso. */
export async function searchCommonsProposals(
  query: string,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<{ proposals: AssetProposal[]; rejected: { title: string; reason: string }[] }> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(opts.limit ?? 20),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
  });
  const res = await (opts.fetchImpl ?? fetch)(`${COMMONS_API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Commons ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: Record<string, CommonsPage & { index?: number }> } };
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const proposals: AssetProposal[] = [];
  const rejected: { title: string; reason: string }[] = [];
  for (const page of pages) {
    const out = proposalFromCommonsPage(page);
    if ("proposal" in out) proposals.push(out.proposal);
    else rejected.push({ title: page.title, reason: out.rejected });
  }
  return { proposals, rejected };
}
