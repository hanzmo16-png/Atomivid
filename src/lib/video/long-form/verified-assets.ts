/**
 * Verified Asset Foundation (planes v4). Un recurso "premium documental" exige
 * cuatro condiciones INDEPENDIENTES, todas deterministas y controladas por el
 * servidor:
 *
 *   LEGAL      — licencia/derechos en una lista CERRADA (licenseEligibility).
 *   AUTHENTIC  — procedencia y fuente registradas (VerifiedAssetRecord).
 *   RELEVANT   — vínculo CURADO con la identidad o la proposición exacta.
 *   QUALITY    — lado largo ≥ 1280 px, MIME permitido (qualityEligibility).
 *
 * La similitud no prueba ninguna. Un proveedor externo, un modelo o una
 * respuesta de búsqueda NUNCA crean un registro: solo la curaduría del
 * servidor (curateProposal / manualVerifiedRecord → VerifiedAssetRegistry).
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import type { BeatVisual } from "./visual-intents";
import { requiresEvidence, requiresIdentity } from "./visual-intents";
import { OPENING_CARD_RUN_MAX, OPENING_CARD_WINDOW_SEC, requiresSchematic, tierSeconds } from "./cinematic-director";

// --------------------------------------------------------------------------
// LEGAL — política de licencias V1 (cerrada)
// --------------------------------------------------------------------------

/** Únicas licencias abiertas admitidas en V1. CC BY-SA queda FUERA (sin decisión legal automática sobre share-alike). */
export const OPEN_LICENSE_ALLOWLIST = ["PD", "CC0", "CC_BY"] as const;
export type OpenLicense = (typeof OPEN_LICENSE_ALLOWLIST)[number];

export type LicenseInput = {
  /** Código de licencia de la fuente (p. ej. Commons extmetadata.License: "pd", "cc0", "cc-by-4.0"). */
  code?: string;
  /** Nombre corto (p. ej. "Public domain", "CC BY 4.0"). */
  shortName?: string;
  /** Restricciones explícitas (Commons extmetadata.Restrictions: "personality", "trademarked"...). */
  restrictions?: string;
  /** Términos de uso declarados. */
  usageTerms?: string;
  /** Commons extmetadata.Copyrighted ("True"/"False"). */
  copyrighted?: string;
};

export type LicenseVerdict = { eligible: true; license: OpenLicense } | { eligible: false; reason: string };

function classifyOne(text: string): OpenLicense | "DENY_NC" | "DENY_ND" | "DENY_SA" | "DENY_ARR" | null {
  const t = text.toLowerCase().replace(/[_\s]+/g, "-").trim();
  if (!t) return null;
  if (/all-rights-reserved|copyright-protected|non-free|fair-use/.test(t)) return "DENY_ARR";
  if (/(^|-)nc(-|$)|noncommercial|non-commercial/.test(t)) return "DENY_NC";
  if (/(^|-)nd(-|$)|noderiv|no-deriv/.test(t)) return "DENY_ND";
  if (/(^|-)sa(-|$)|sharealike|share-alike/.test(t)) return "DENY_SA";
  if (/^cc0|cc-zero|^cc-0/.test(t)) return "CC0";
  if (/^pd($|-)|public-domain|^publicdomain/.test(t)) return "PD";
  if (/^cc-by($|-\d)/.test(t)) return "CC_BY";
  return null;
}

/**
 * ¿Podemos USARLO? (no: ¿es el visual correcto?). Falla cerrada: ausencia,
 * ambigüedad, restricción explícita o licencia no reconocida → no elegible.
 */
export function licenseEligibility(input: LicenseInput): LicenseVerdict {
  const fromCode = input.code ? classifyOne(input.code) : null;
  const fromName = input.shortName ? classifyOne(input.shortName) : null;
  if (!input.code?.trim() && !input.shortName?.trim()) return { eligible: false, reason: "licencia ausente" };
  for (const v of [fromCode, fromName]) {
    if (v === "DENY_NC") return { eligible: false, reason: "uso no comercial (NC)" };
    if (v === "DENY_ND") return { eligible: false, reason: "sin obras derivadas (ND)" };
    if (v === "DENY_SA") return { eligible: false, reason: "compartir-igual (SA): no elegible en V1" };
    if (v === "DENY_ARR") return { eligible: false, reason: "todos los derechos reservados / no libre" };
  }
  const known = [fromCode, fromName].filter((v): v is OpenLicense => v !== null);
  if (known.length === 0) return { eligible: false, reason: `licencia no reconocida (${input.code ?? input.shortName})` };
  if (new Set(known).size > 1) return { eligible: false, reason: `licencia ambigua (${input.code} / ${input.shortName})` };
  if ((input.code && fromCode === null) || (input.shortName && fromName === null)) return { eligible: false, reason: `licencia ambigua (${input.code} / ${input.shortName})` };
  if (input.restrictions?.trim()) return { eligible: false, reason: `restricciones explícitas (${input.restrictions.trim().slice(0, 60)})` };
  if (known[0] === "PD" && /^true$/i.test(input.copyrighted ?? "")) return { eligible: false, reason: "dominio público contradicho por 'Copyrighted'" };
  return { eligible: true, license: known[0] };
}

// --------------------------------------------------------------------------
// QUALITY — elegibilidad técnica (no estética)
// --------------------------------------------------------------------------

export const HERO_MIN_LONG_SIDE_PX = 1280;
export const ALLOWED_MEDIA_MIME = ["image/jpeg", "image/png", "image/webp", "video/mp4"] as const;

export type QualityVerdict = { status: "QUALITY_ELIGIBLE" } | { status: "QUALITY_INELIGIBLE"; reason: string };

/** Sin reescalado: un recurso pequeño no se vuelve elegible. */
export function qualityEligibility(input: { width?: number; height?: number; mime?: string; orientation?: number }): QualityVerdict {
  const { width, height, mime } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width! > 0) || !(height! > 0)) return { status: "QUALITY_INELIGIBLE", reason: "dimensiones ausentes o inválidas" };
  if (!mime || !(ALLOWED_MEDIA_MIME as readonly string[]).includes(mime.toLowerCase())) return { status: "QUALITY_INELIGIBLE", reason: `MIME no permitido (${mime ?? "ausente"})` };
  // EXIF 5-8 = girada 90°: las dimensiones declaradas pueden estar traspuestas; el lado largo no cambia.
  const longSide = Math.max(width!, height!);
  if (longSide < HERO_MIN_LONG_SIDE_PX) return { status: "QUALITY_INELIGIBLE", reason: `lado largo ${longSide} px < ${HERO_MIN_LONG_SIDE_PX} px` };
  return { status: "QUALITY_ELIGIBLE" };
}

// --------------------------------------------------------------------------
// AUTHENTIC + RELEVANT — registro verificado (solo servidor)
// --------------------------------------------------------------------------

/** Derechos: licencias abiertas de la lista cerrada, o derechos licenciados/propios con referencia contractual (solo vía manual). */
export type AssetRights =
  | { kind: OpenLicense; licenseUrl?: string }
  | { kind: "LICENSED" | "OWNED"; rightsReference: string; licenseUrl?: string };

/** Región curada (coordenadas normalizadas 0–1) — preparada para animación de documentos; nunca la inventa un modelo. */
export type AssetRegion = { label: "headline" | "date" | "subject" | "detail"; x: number; y: number; w: number; h: number };

export type VerifiedAssetRecord = {
  id: string;
  /** Origen: Commons (propuesta curada) o ingesta manual de archivo licenciado/propio/curado. El selector no los distingue en verdad. */
  source: "commons" | "manual" | "licensed_archive" | "owned";
  sourceUrl: string;
  mediaUrl: string;
  mediaType: "image" | "video";
  mime: string;
  width: number;
  height: number;
  rights: AssetRights;
  creator?: string;
  /** Crédito visible (obligatorio con CC BY). */
  creditText?: string;
  description?: string;
  /** Persona que el recurso muestra (curado). `ref` admite un identificador estable futuro (p. ej. QID). */
  entityLink?: { name: string; ref?: string };
  /** Proposición que el recurso documenta (curado): fuentes del research pack. */
  evidenceLink?: { sourceIds: string[]; claimIds?: string[] };
  regions?: AssetRegion[];
  /** Quién y con qué base lo curó: sin esto no hay registro. */
  curation: { curatedBy: string; curatedAt: string; basis: string };
};

export type RecordVerdict = { ok: true; record: VerifiedAssetRecord; license: OpenLicense | "LICENSED" | "OWNED" } | { ok: false; reasons: string[] };

/** Valida un registro: LEGAL + QUALITY + vínculo + curaduría. Todo o nada. */
export function validateVerifiedRecord(record: VerifiedAssetRecord): RecordVerdict {
  const reasons: string[] = [];
  if (!record.id?.trim() || !record.sourceUrl?.trim() || !record.mediaUrl?.trim()) reasons.push("identificación incompleta (id/sourceUrl/mediaUrl)");
  const rights = record.rights;
  if (!rights) reasons.push("derechos ausentes");
  else if (rights.kind === "LICENSED" || rights.kind === "OWNED") {
    if (!rights.rightsReference?.trim()) reasons.push("derechos licenciados/propios sin referencia contractual");
    if (record.source === "commons") reasons.push("Commons solo admite licencias abiertas de la lista");
  } else if (!(OPEN_LICENSE_ALLOWLIST as readonly string[]).includes(rights.kind)) {
    reasons.push(`licencia fuera de la lista V1 (${String((rights as { kind: string }).kind)})`);
  }
  if (rights?.kind === "CC_BY" && !record.creditText?.trim()) reasons.push("CC BY exige crédito visible (creditText)");
  const quality = qualityEligibility({ width: record.width, height: record.height, mime: record.mime });
  if (quality.status === "QUALITY_INELIGIBLE") reasons.push(`calidad: ${quality.reason}`);
  if (!record.entityLink?.name?.trim() && !(record.evidenceLink?.sourceIds?.length)) reasons.push("sin vínculo curado de identidad ni de prueba");
  if (!record.curation?.curatedBy?.trim() || !record.curation.basis?.trim()) reasons.push("sin curaduría registrada (curatedBy/basis)");
  for (const r of record.regions ?? []) {
    if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) reasons.push(`región fuera de 0–1 (${r.label})`);
  }
  if (reasons.length > 0 || !rights) return { ok: false, reasons };
  return { ok: true, record, license: rights.kind };
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const VERIFIED_PREFIX = "verified:";

/**
 * Registro de recursos verificados del servidor. Solo se construye desde
 * registros curados (load). Los candidatos que ofrece al selector son objetos
 * EMITIDOS por él: la confianza se reconoce por identidad de objeto, así que un
 * proveedor no puede autodeclararla imitando un id, una URL o un nombre.
 */
export class VerifiedAssetRegistry {
  private readonly records: VerifiedAssetRecord[];
  private readonly issued = new WeakMap<FootageCandidate, VerifiedAssetRecord>();
  readonly rejected: { id: string; reasons: string[] }[];

  private constructor(records: VerifiedAssetRecord[], rejected: { id: string; reasons: string[] }[]) {
    this.records = records;
    this.rejected = rejected;
  }

  static empty(): VerifiedAssetRegistry {
    return new VerifiedAssetRegistry([], []);
  }

  /** Carga en el servidor (configuración/almacenamiento controlado). Un registro inválido se descarta, nunca se "repara". */
  static load(input: unknown): VerifiedAssetRegistry {
    const list = Array.isArray(input) ? input : [];
    const ok: VerifiedAssetRecord[] = [];
    const rejected: { id: string; reasons: string[] }[] = [];
    for (const raw of list) {
      const verdict = raw && typeof raw === "object" ? validateVerifiedRecord(raw as VerifiedAssetRecord) : ({ ok: false, reasons: ["no es un registro"] } as RecordVerdict);
      if (verdict.ok) ok.push(verdict.record);
      else rejected.push({ id: String((raw as { id?: unknown })?.id ?? "?"), reasons: verdict.reasons });
    }
    return new VerifiedAssetRegistry(ok, rejected);
  }

  get size(): number {
    return this.records.length;
  }

  recordsFor(visual: BeatVisual): VerifiedAssetRecord[] {
    return this.records.filter((r) => matchesIdentity(r, visual) || matchesEvidence(r, visual));
  }

  /** ¿Hay material verificado para esta identidad/proposición? (preflight de cobertura) */
  covers(visual: BeatVisual): boolean {
    return this.recordsFor(visual).length > 0;
  }

  private issue(record: VerifiedAssetRecord): FootageCandidate {
    const candidate: FootageCandidate = {
      url: record.mediaUrl,
      sourceId: `${VERIFIED_PREFIX}${record.id}`,
      mediaType: record.mediaType,
      mimeType: record.mime,
      extension: record.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "bin",
      width: record.width,
      height: record.height,
      description: record.description,
      pageUrl: record.sourceUrl,
      photographer: record.creator,
    };
    this.issued.set(candidate, record);
    return candidate;
  }

  /** Registro detrás de un candidato EMITIDO por este registro (null para cualquier otro, aunque copie id/URL). */
  recordOf(candidate: FootageCandidate): VerifiedAssetRecord | null {
    return this.issued.get(candidate) ?? null;
  }

  verifyEntityLink = (candidate: FootageCandidate): { name: string } | null => {
    const record = this.recordOf(candidate);
    return record?.entityLink ? { name: record.entityLink.name } : null;
  };

  verifyEvidenceLink = (candidate: FootageCandidate): { sourceIds: string[] } | null => {
    const record = this.recordOf(candidate);
    return record?.evidenceLink ? { sourceIds: [...record.evidenceLink.sourceIds] } : null;
  };

  /**
   * Proveedor para UNA escena: los resultados del proveedor base (con su ranking de similitud intacto) y, al
   * final, los recursos verificados que le corresponden. La similitud nomina; la verificación decide.
   */
  providerFor(visual: BeatVisual, base: FootageProvider): FootageProvider {
    const matching = this.recordsFor(visual);
    if (matching.length === 0) return base;
    const verified = (type: "image" | "video") => matching.filter((r) => r.mediaType === type).map((r) => this.issue(r));
    return {
      name: base.name,
      fetchFootage: (...args) => base.fetchFootage(...args),
      downloadFootage: (url) => base.downloadFootage(url),
      searchImageCandidates: async (query, orientation) => [...((await base.searchImageCandidates?.(query, orientation)) ?? []), ...verified("image")],
      ...(base.searchVideoCandidates
        ? { searchVideoCandidates: async (query: string, min: number, orientation?: "portrait" | "landscape") => [...(await base.searchVideoCandidates!(query, min, orientation)), ...verified("video")] }
        : {}),
    };
  }
}

function matchesIdentity(r: VerifiedAssetRecord, visual: BeatVisual): boolean {
  return !!r.entityLink && !!visual.identity && norm(r.entityLink.name) === norm(visual.identity.name);
}

function matchesEvidence(r: VerifiedAssetRecord, visual: BeatVisual): boolean {
  if (!r.evidenceLink || !visual.evidence || !requiresEvidence(visual)) return false;
  const want = new Set(visual.evidence.sourceIds);
  return r.evidenceLink.sourceIds.some((id) => want.has(id));
}

/** Crédito visible del registro (CC BY lo exige; otras licencias lo conservan si existe). */
export function creditFor(record: VerifiedAssetRecord): string | undefined {
  return record.creditText?.trim() || undefined;
}

// --------------------------------------------------------------------------
// Vías de ingreso controladas: propuesta curada (Commons) y manual (licenciado/propio)
// --------------------------------------------------------------------------

/** Lo que una fuente PROPONE. Su metadata (P180, título, categoría, descripción) nunca crea un vínculo. */
export type AssetProposal = {
  source: "commons";
  title: string;
  sourceUrl: string;
  mediaUrl: string;
  mime: string;
  width: number;
  height: number;
  license: LicenseInput;
  licenseUrl?: string;
  creator?: string;
  attribution?: string;
  description?: string;
  categories?: string[];
  depicts?: string[];
};

/** Decisión del curador del servidor: el vínculo es SUYO, no del candidato. */
export type CurationDecision = {
  curatedBy: string;
  basis: string;
  curatedAt: string;
  entityLink?: { name: string; ref?: string };
  evidenceLink?: { sourceIds: string[]; claimIds?: string[] };
  regions?: AssetRegion[];
};

/** Propuesta + decisión explícita del curador → registro verificado (o rechazo). */
export function curateProposal(proposal: AssetProposal, decision: CurationDecision): RecordVerdict {
  const license = licenseEligibility(proposal.license);
  if (!license.eligible) return { ok: false, reasons: [`licencia: ${license.reason}`] };
  return validateVerifiedRecord({
    id: `commons:${proposal.title}`,
    source: "commons",
    sourceUrl: proposal.sourceUrl,
    mediaUrl: proposal.mediaUrl,
    mediaType: proposal.mime.startsWith("video/") ? "video" : "image",
    mime: proposal.mime,
    width: proposal.width,
    height: proposal.height,
    rights: { kind: license.license, licenseUrl: proposal.licenseUrl },
    creator: proposal.creator,
    creditText: license.license === "CC_BY" ? (proposal.attribution || [proposal.creator, "CC BY", "Wikimedia Commons"].filter(Boolean).join(" · ")) : proposal.attribution,
    description: proposal.description,
    entityLink: decision.entityLink,
    evidenceLink: decision.evidenceLink,
    regions: decision.regions,
    curation: { curatedBy: decision.curatedBy, curatedAt: decision.curatedAt, basis: decision.basis },
  });
}

/** Ingesta manual (archivo licenciado, agencia, material propio, fuente curada): MISMO contrato y validación. */
export function manualVerifiedRecord(record: Omit<VerifiedAssetRecord, "source"> & { source: "manual" | "licensed_archive" | "owned" }): RecordVerdict {
  return validateVerifiedRecord(record);
}

// --------------------------------------------------------------------------
// Preflight de cobertura HERO (v4, antes de cualquier llamada pagada)
// --------------------------------------------------------------------------

export type CoverageShot = { id: string; startSec: number; endSec: number; type: string; anchoredVisual?: BeatVisual };

export type HeroCoverage = {
  heroSeconds: number;
  verifiedIdentitySeconds: number;
  verifiedEvidenceSeconds: number;
  /** PLACE/PROCESS/... por cubrir con material de contexto legal (su disponibilidad solo se sabe al buscar). */
  legalContextualSeconds: number;
  /** Ausencias seguras y verdaderas (sin material verificado, esquema sin datos). */
  truthfulAbstentionSeconds: number;
  /** Fallos del planner/clasificación: tarjetas que no son una buena abstención. */
  unresolvedSeconds: number;
  /** Proporción de escenas que acabarán SEGURO en tarjeta por carencia (toda la producción). */
  estimatedTextCardRatio: number;
  threeCardRunRisk: boolean;
  missingIdentities: string[];
  missingEvidence: string[];
  /** Fallos que las reglas YA existentes hacen inevitables: si hay alguno, no se gasta nada. */
  blockers: string[];
};

/**
 * Cobertura del opening con material legal y verdadero (no movimiento). Sin
 * fórmulas nuevas: solo bloquea por reglas existentes (3 tarjetas en los
 * primeros 30 s; proporción de tarjetas por carencia sobre MAX_TEXT_FALLBACK_RATIO).
 */
export function heroCoverage(shots: CoverageShot[], registry: VerifiedAssetRegistry | undefined, maxTextFallbackRatio: number): HeroCoverage {
  const reg = registry ?? VerifiedAssetRegistry.empty();
  const out: HeroCoverage = {
    heroSeconds: 0,
    verifiedIdentitySeconds: 0,
    verifiedEvidenceSeconds: 0,
    legalContextualSeconds: 0,
    truthfulAbstentionSeconds: 0,
    unresolvedSeconds: 0,
    estimatedTextCardRatio: 0,
    threeCardRunRisk: false,
    missingIdentities: [],
    missingEvidence: [],
    blockers: [],
  };
  const certainCard = (s: CoverageShot): "abstention" | "unresolved" | null => {
    const v = s.anchoredVisual;
    if (!v) return null;
    if (v.classificationGap || (v.beatClass === "IDENTITY" && !v.identity) || (requiresEvidence(v) && !v.evidence)) return "unresolved";
    if (requiresIdentity(v) && !reg.covers(v)) return "abstention";
    if (requiresEvidence(v) && !reg.covers(v)) return "abstention";
    return null;
  };
  let degraded = 0;
  let run: string[] = [];
  const missingId = new Set<string>();
  const missingEv = new Set<string>();
  for (const s of shots) {
    const hero = tierSeconds(s.startSec, s.endSec).HERO;
    const v = s.anchoredVisual;
    const card = certainCard(s);
    if (card) degraded++;
    if (card === "abstention" && v?.identity && !reg.covers(v)) missingId.add(v.identity.name);
    if (card === "abstention" && v && requiresEvidence(v) && v.evidence) missingEv.add(v.evidence.sourceIds.join("+"));
    const isCard = !!card || s.type === "text" || requiresSchematic(v);
    if (s.startSec < OPENING_CARD_WINDOW_SEC && isCard) run.push(s.id);
    else {
      if (run.length >= OPENING_CARD_RUN_MAX) out.threeCardRunRisk = true;
      run = [];
    }
    if (hero <= 0) continue;
    out.heroSeconds += hero;
    if (card === "unresolved") out.unresolvedSeconds += hero;
    else if (card === "abstention" || requiresSchematic(v)) out.truthfulAbstentionSeconds += hero;
    else if (v && requiresIdentity(v)) out.verifiedIdentitySeconds += hero;
    else if (v && requiresEvidence(v)) out.verifiedEvidenceSeconds += hero;
    else if (s.type === "text") out.truthfulAbstentionSeconds += hero;
    else out.legalContextualSeconds += hero;
  }
  if (run.length >= OPENING_CARD_RUN_MAX) out.threeCardRunRisk = true;
  out.estimatedTextCardRatio = shots.length > 0 ? degraded / shots.length : 0;
  out.missingIdentities = [...missingId];
  out.missingEvidence = [...missingEv];
  const r = (n: number) => Math.round(n * 1000) / 1000;
  for (const k of ["heroSeconds", "verifiedIdentitySeconds", "verifiedEvidenceSeconds", "legalContextualSeconds", "truthfulAbstentionSeconds", "unresolvedSeconds", "estimatedTextCardRatio"] as const) out[k] = r(out[k]);
  if (out.threeCardRunRisk) out.blockers.push(`OPENING_TEXT_CARD_RUN: ${OPENING_CARD_RUN_MAX}+ tarjetas seguras seguidas en los primeros ${OPENING_CARD_WINDOW_SEC} s sin material verificado`);
  if (out.estimatedTextCardRatio > maxTextFallbackRatio) {
    out.blockers.push(`TEXT_FALLBACK_RATIO: ${Math.round(out.estimatedTextCardRatio * 100)} % de escenas acabarán seguro en tarjeta (máximo ${Math.round(maxTextFallbackRatio * 100)} %)`);
  }
  return out;
}
