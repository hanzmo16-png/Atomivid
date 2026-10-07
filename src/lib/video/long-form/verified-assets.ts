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
 * La similitud no prueba ninguna. Un proveedor externo, un modelo, una
 * respuesta de búsqueda o un JSON persistido NUNCA crean un registro de
 * confianza: solo la rehidratación del servidor a partir de una decisión
 * humana sobre el par EXACTO recurso ↔ contrato (asset-curation.ts).
 */
import { createHash } from "node:crypto";
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
// AUTHENTIC + RELEVANT — frontera de confianza
//
//   REGISTRO PERSISTIDO (no confiable) → VALIDACIÓN DEL SERVIDOR → VALIDACIÓN
//   DE CURADURÍA → REGISTRO DE CONFIANZA EN MEMORIA.
//
// Lo persistido (CurationFile) NUNCA lleva autoridad: no hay booleano, token
// ni cadena mágica que la conceda. La concede `VerifiedAssetRegistry.rehydrate`
// (código del servidor) cada vez que carga, revalidando licencia, derechos,
// calidad, crédito, huella del recurso, curador autorizado, estado ACTIVE y
// el contrato exacto (identidad o proposición) aprobado por una persona.
// --------------------------------------------------------------------------

/** Derechos: licencias abiertas de la lista cerrada, o derechos licenciados/propios con referencia contractual (solo vía manual). */
export type AssetRights =
  | { kind: OpenLicense; licenseUrl?: string }
  | { kind: "LICENSED" | "OWNED"; rightsReference: string; licenseUrl?: string };

/** Región curada (coordenadas normalizadas 0–1): solo se muestra; nunca la inventa un modelo. */
export type AssetRegion = { label: "headline" | "date" | "subject" | "detail"; x: number; y: number; w: number; h: number };

export const ASSET_SOURCES = ["commons", "manual", "licensed_archive", "owned"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/** Recurso PERSISTIDO (no confiable): metadata de la fuente, sin ningún vínculo. */
export type CuratableAsset = {
  id: string;
  /** Commons (propuesta filtrada) o ingesta manual de archivo licenciado/propio/curado: mismo contrato. */
  source: AssetSource;
  sourceUrl: string;
  mediaUrl: string;
  mediaType: "image" | "video";
  mime: string;
  width: number;
  height: number;
  rights: AssetRights;
  /** Commons: metadata de licencia de la fuente; se reevalúa en cada carga y debe coincidir con `rights.kind`. */
  licenseEvidence?: LicenseInput;
  creator?: string;
  /** Crédito visible (obligatorio con CC BY). */
  creditText?: string;
  description?: string;
  regions?: AssetRegion[];
  /** SHA-256 del contenido, si se conoce: el selector lo exige tras la descarga (mutación del recurso). */
  contentSha256?: string;
};

/** El contrato EXACTO que pidió el recurso: una persona o una proposición. El curador solo puede aprobarlo o rechazarlo. */
export type LinkContract =
  | { kind: "IDENTITY"; name: string }
  | { kind: "EVIDENCE"; sourceIds: string[]; claimIds?: string[]; proposition: string };

export type LinkProposal = { id: string; assetId: string; contract: LinkContract; origin: "commons" | "manual"; proposedAt: string };

export type CurationDecisionEntry = {
  id: string;
  proposalId: string;
  assetId: string;
  /** Huella del recurso tal como lo vio el curador: si cambia, la aprobación no se conserva. */
  assetFingerprint: string;
  contractKey: string;
  contract: LinkContract;
  requestId: string;
  verdict: "APPROVED" | "REJECTED";
  status: "ACTIVE" | "REVOKED";
  decidedBy: string;
  decidedAt: string;
  version: number;
  /** Metadata aprobada por el curador (p. ej. el crédito CC BY). */
  approved?: { creditText?: string };
  revokedBy?: string;
  revokedAt?: string;
};

/** Archivo de curaduría por solicitud (`{requestId}/state/curation.json`). Datos, no autoridad. */
export type CurationFile = { version: 1; requestId: string; assets: CuratableAsset[]; proposals: LinkProposal[]; decisions: CurationDecisionEntry[] };

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const sortedUnique = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))].sort();

/** Clave canónica del contrato: identidad por nombre; prueba por el conjunto EXACTO de fuentes (+ afirmaciones). */
export function contractKey(contract: LinkContract): string {
  if (contract.kind === "IDENTITY") return `IDENTITY:${norm(contract.name)}`;
  const claims = sortedUnique(contract.claimIds);
  return `EVIDENCE:${sortedUnique(contract.sourceIds).join("+")}${claims.length ? `|${claims.join("+")}` : ""}`;
}

/** Contrato que una escena protegida exige (null: la escena no pide material verificado). */
export function contractForVisual(visual: BeatVisual | undefined): LinkContract | null {
  if (!visual) return null;
  if (visual.identity && requiresIdentity(visual)) return { kind: "IDENTITY", name: visual.identity.name };
  if (requiresEvidence(visual) && visual.evidence?.sourceIds?.length) {
    return { kind: "EVIDENCE", sourceIds: [...visual.evidence.sourceIds], ...(visual.evidence.claimIds?.length ? { claimIds: [...visual.evidence.claimIds] } : {}), proposition: visual.quote ?? visual.description };
  }
  return null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Huella de los campos MATERIALES del recurso (fuente, medio, dimensiones, derechos, crédito, contenido). */
export function assetFingerprint(asset: CuratableAsset): string {
  const { id, source, sourceUrl, mediaUrl, mediaType, mime, width, height, rights, licenseEvidence, creator, creditText, contentSha256 } = asset;
  return createHash("sha256").update(canonical({ id, source, sourceUrl, mediaUrl, mediaType, mime, width, height, rights, licenseEvidence, creator, creditText, contentSha256 })).digest("hex");
}

/**
 * ¿Puede este recurso llegar a aprobación? LEGAL + QUALITY + derechos. Con
 * `forApproval`, además el crédito CC BY (del recurso o aprobado por el curador).
 */
export function validateAsset(asset: CuratableAsset, opts: { forApproval?: boolean; creditText?: string } = {}): string[] {
  const reasons: string[] = [];
  if (!asset || typeof asset !== "object") return ["no es un recurso"];
  if (!asset.id?.trim() || !asset.sourceUrl?.trim() || !asset.mediaUrl?.trim()) reasons.push("identificación incompleta (id/sourceUrl/mediaUrl)");
  if (!(ASSET_SOURCES as readonly string[]).includes(asset.source)) reasons.push(`fuente desconocida (${String(asset.source)})`);
  const rights = asset.rights;
  if (!rights) reasons.push("derechos ausentes");
  else if (rights.kind === "LICENSED" || rights.kind === "OWNED") {
    if (!rights.rightsReference?.trim()) reasons.push("derechos licenciados/propios sin referencia contractual");
    if (asset.source === "commons") reasons.push("Commons solo admite licencias abiertas de la lista");
  } else if (!(OPEN_LICENSE_ALLOWLIST as readonly string[]).includes(rights.kind)) {
    reasons.push(`licencia fuera de la lista V1 (${String((rights as { kind: string }).kind)})`);
  }
  if (asset.source === "commons") {
    const legal = asset.licenseEvidence ? licenseEligibility(asset.licenseEvidence) : null;
    if (!legal) reasons.push("Commons sin metadata de licencia de la fuente");
    else if (!legal.eligible) reasons.push(`licencia: ${legal.reason}`);
    else if (rights && legal.license !== rights.kind) reasons.push(`licencia declarada (${rights.kind}) ≠ licencia de la fuente (${legal.license})`);
  }
  const quality = qualityEligibility({ width: asset.width, height: asset.height, mime: asset.mime });
  if (quality.status === "QUALITY_INELIGIBLE") reasons.push(`calidad: ${quality.reason}`);
  if (asset.mediaType !== (asset.mime?.startsWith("video/") ? "video" : "image")) reasons.push("tipo de medio incoherente con el MIME");
  for (const r of asset.regions ?? []) {
    if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) reasons.push(`región fuera de 0–1 (${r.label})`);
  }
  if (opts.forApproval && rights?.kind === "CC_BY" && !(opts.creditText ?? asset.creditText)?.trim()) reasons.push("CC BY exige crédito visible (atribución)");
  return reasons;
}

/** Registro de CONFIANZA en memoria: solo lo crea `rehydrate`; congelado; lleva únicamente el vínculo aprobado. */
export type VerifiedAssetRecord = Readonly<{
  id: string;
  decisionId: string;
  contractKey: string;
  source: AssetSource;
  sourceUrl: string;
  mediaUrl: string;
  mediaType: "image" | "video";
  mime: string;
  width: number;
  height: number;
  rights: AssetRights;
  creator?: string;
  creditText?: string;
  description?: string;
  regions?: readonly AssetRegion[];
  contentSha256?: string;
  entityLink?: Readonly<{ name: string }>;
  evidenceLink?: Readonly<{ sourceIds: readonly string[]; claimIds?: readonly string[] }>;
  curatedBy: string;
  curatedAt: string;
}>;

/** Marca interna NO serializable: un objeto copiado, deserializado o fabricado nunca la tiene. */
const TRUSTED = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export type RehydrationPolicy = {
  /** Solicitud cuyo archivo se carga: una decisión de otra solicitud no vale aquí. */
  requestId: string;
  /** Autoridad del SERVIDOR (configuración actual), nunca del archivo: quién puede curar hoy. */
  isAuthorizedCurator: (decidedBy: string) => boolean;
  /** Contratos que el plan pide; una decisión sobre otro contrato no se rehidrata. */
  requestedContracts?: ReadonlySet<string>;
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function sameContract(a: unknown, b: LinkContract): boolean {
  const c = obj(a);
  if (!c || (c.kind !== "IDENTITY" && c.kind !== "EVIDENCE")) return false;
  try {
    return contractKey(c as LinkContract) === contractKey(b);
  } catch {
    return false;
  }
}

const VERIFIED_PREFIX = "verified:";

/**
 * Registro de recursos verificados del servidor. Solo se construye por
 * rehidratación (o vacío). Los candidatos que ofrece al selector son objetos
 * EMITIDOS por él: la confianza se reconoce por identidad de objeto, así que un
 * proveedor no puede autodeclararla imitando un id, una URL o un nombre.
 */
export class VerifiedAssetRegistry {
  private readonly records: VerifiedAssetRecord[];
  private readonly issued = new WeakMap<FootageCandidate, VerifiedAssetRecord>();
  readonly rejected: { id: string; reasons: string[] }[];

  private constructor(records: VerifiedAssetRecord[], rejected: { id: string; reasons: string[] }[]) {
    this.records = records.filter((r) => TRUSTED.has(r));
    this.rejected = rejected;
  }

  static empty(): VerifiedAssetRegistry {
    return new VerifiedAssetRegistry([], []);
  }

  /**
   * UNTRUSTED PERSISTED RECORD → SERVER VALIDATION → CURATION VALIDATION →
   * TRUSTED RUNTIME RECORD. Cada decisión se revalida entera en cada carga;
   * nada del archivo se acepta por estar ahí (ni `trusted`, ni `curation`, ni
   * un registro "verificado" serializado).
   */
  static rehydrate(input: unknown, policy: RehydrationPolicy): VerifiedAssetRegistry {
    const file = obj(input);
    const rejected: { id: string; reasons: string[] }[] = [];
    if (!file) return new VerifiedAssetRegistry([], [{ id: "?", reasons: ["archivo de curaduría ilegible"] }]);
    const assets = new Map<string, CuratableAsset>();
    for (const a of arr(file.assets)) {
      const asset = obj(a);
      if (asset && typeof asset.id === "string") assets.set(asset.id, asset as unknown as CuratableAsset);
    }
    const proposals = new Map<string, LinkProposal>();
    for (const p of arr(file.proposals)) {
      const proposal = obj(p);
      if (proposal && typeof proposal.id === "string") proposals.set(proposal.id, proposal as unknown as LinkProposal);
    }
    // La decisión EFECTIVA de cada par (recurso, contrato) es la de mayor versión.
    const effective = new Map<string, Record<string, unknown>>();
    for (const d of arr(file.decisions)) {
      const decision = obj(d);
      if (!decision) continue;
      const pair = `${String(decision.assetId)}::${String(decision.contractKey)}`;
      const prev = effective.get(pair);
      if (!prev || Number(decision.version) > Number(prev.version)) effective.set(pair, decision);
    }
    const records: VerifiedAssetRecord[] = [];
    for (const decision of effective.values()) {
      const id = String(decision.id ?? "?");
      const reasons: string[] = [];
      if (decision.verdict !== "APPROVED") reasons.push("decisión no aprobada");
      if (decision.status !== "ACTIVE") reasons.push("aprobación revocada o inactiva");
      if (decision.requestId !== policy.requestId || file.requestId !== policy.requestId) reasons.push("decisión de otra solicitud");
      if (typeof decision.decidedBy !== "string" || !policy.isAuthorizedCurator(decision.decidedBy)) reasons.push("curador no autorizado por el servidor");
      const proposal = proposals.get(String(decision.proposalId));
      const contract = obj(decision.contract) as LinkContract | null;
      if (!proposal || !contract) reasons.push("sin propuesta o contrato de origen");
      else {
        if (proposal.assetId !== decision.assetId) reasons.push("la decisión no corresponde al recurso propuesto");
        if (!sameContract(contract, proposal.contract) || contractKey(proposal.contract) !== decision.contractKey) reasons.push("contrato distinto del que pidió el recurso");
      }
      if (policy.requestedContracts && !policy.requestedContracts.has(String(decision.contractKey))) reasons.push("contrato que el plan no pide");
      const asset = assets.get(String(decision.assetId));
      if (!asset) reasons.push("recurso ausente");
      else {
        const approved = obj(decision.approved);
        const credit = typeof approved?.creditText === "string" ? approved.creditText : undefined;
        reasons.push(...validateAsset(asset, { forApproval: true, creditText: credit }));
        if (reasons.length === 0 && assetFingerprint(asset) !== decision.assetFingerprint) reasons.push("el recurso cambió desde la aprobación (huella distinta)");
      }
      if (reasons.length > 0 || !asset || !proposal) {
        rejected.push({ id, reasons });
        continue;
      }
      const approved = obj(decision.approved);
      const credit = (typeof approved?.creditText === "string" && approved.creditText.trim()) || asset.creditText?.trim() || undefined;
      const c = proposal.contract;
      const record: VerifiedAssetRecord = deepFreeze({
        id: asset.id,
        decisionId: id,
        contractKey: contractKey(c),
        source: asset.source,
        sourceUrl: asset.sourceUrl,
        mediaUrl: asset.mediaUrl,
        mediaType: asset.mediaType,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        rights: structuredClone(asset.rights),
        ...(asset.creator ? { creator: asset.creator } : {}),
        ...(credit ? { creditText: credit } : {}),
        ...(asset.description ? { description: asset.description } : {}),
        ...(asset.regions?.length ? { regions: structuredClone(asset.regions) } : {}),
        ...(asset.contentSha256 ? { contentSha256: asset.contentSha256 } : {}),
        ...(c.kind === "IDENTITY"
          ? { entityLink: { name: c.name } }
          : { evidenceLink: { sourceIds: sortedUnique(c.sourceIds), ...(c.claimIds?.length ? { claimIds: sortedUnique(c.claimIds) } : {}) } }),
        curatedBy: String(decision.decidedBy),
        curatedAt: String(decision.decidedAt),
      });
      TRUSTED.add(record);
      records.push(record);
    }
    return new VerifiedAssetRegistry(records, rejected);
  }

  get size(): number {
    return this.records.length;
  }

  /** Registros cuyo contrato aprobado es EXACTAMENTE el que pide la escena (identidad ≠ prueba; prueba X ≠ prueba Y). */
  recordsFor(visual: BeatVisual): VerifiedAssetRecord[] {
    const contract = contractForVisual(visual);
    if (!contract) return [];
    const key = contractKey(contract);
    return this.records.filter((r) => r.contractKey === key);
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
    const record = this.issued.get(candidate) ?? null;
    return record && TRUSTED.has(record) ? record : null;
  }

  verifyEntityLink = (candidate: FootageCandidate): { name: string } | null => {
    const record = this.recordOf(candidate);
    return record?.entityLink ? { name: record.entityLink.name } : null;
  };

  verifyEvidenceLink = (candidate: FootageCandidate): { sourceIds: string[] } | null => {
    const record = this.recordOf(candidate);
    return record?.evidenceLink ? { sourceIds: [...record.evidenceLink.sourceIds] } : null;
  };

  /** Tras la descarga: si el registro conoce el SHA-256 del contenido, el recurso descargado debe coincidir. */
  verifyContent = (candidate: FootageCandidate, sha256: string): string | null => {
    const record = this.recordOf(candidate);
    if (!record?.contentSha256) return null;
    return record.contentSha256 === sha256 ? null : "el contenido descargado no coincide con el aprobado (SHA-256)";
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

/** Crédito visible del registro (CC BY lo exige; otras licencias lo conservan si existe). */
export function creditFor(record: VerifiedAssetRecord): string | undefined {
  return record.creditText?.trim() || undefined;
}

// --------------------------------------------------------------------------
// Vía de ingreso de Commons: PROPUESTA filtrada (nunca confianza)
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

/** Propuesta de Commons → recurso curable (sin vínculo), o el motivo exacto por el que nunca llega al curador. */
export function assetFromProposal(proposal: AssetProposal): { asset: CuratableAsset } | { rejected: string } {
  const license = licenseEligibility(proposal.license);
  if (!license.eligible) return { rejected: `licencia: ${license.reason}` };
  const asset: CuratableAsset = {
    id: `commons:${proposal.title}`,
    source: "commons",
    sourceUrl: proposal.sourceUrl,
    mediaUrl: proposal.mediaUrl,
    mediaType: proposal.mime.startsWith("video/") ? "video" : "image",
    mime: proposal.mime,
    width: proposal.width,
    height: proposal.height,
    rights: { kind: license.license, ...(proposal.licenseUrl ? { licenseUrl: proposal.licenseUrl } : {}) },
    licenseEvidence: { ...proposal.license },
    ...(proposal.creator ? { creator: proposal.creator } : {}),
    // CC BY: la atribución de la fuente (o el autor) — el curador la ve y puede fijarla; sin ella no hay aprobación.
    ...(proposal.attribution || (license.license === "CC_BY" && proposal.creator)
      ? { creditText: proposal.attribution || `${proposal.creator} · CC BY · Wikimedia Commons` }
      : {}),
    ...(proposal.description ? { description: proposal.description } : {}),
  };
  const reasons = validateAsset(asset);
  return reasons.length ? { rejected: reasons.join("; ") } : { asset };
}

// --------------------------------------------------------------------------
// Preflight de cobertura HERO (v4, antes de cualquier llamada pagada)
// --------------------------------------------------------------------------

export type CoverageShot = { id: string; startSec: number; endSec: number; type: string; anchoredVisual?: BeatVisual };

export type HeroCoverage = {
  /** Segundos de la ventana HERO (0–120 s) que ocupa el plan. */
  heroDuration: number;
  heroIdentitySeconds: number;
  heroEvidenceSeconds: number;
  /** PLACE/PROCESS/... por cubrir con material de contexto legal (su disponibilidad solo se sabe al buscar). */
  heroContextSeconds: number;
  /** Ausencias seguras y verdaderas (sin material verificado, esquema sin datos, tarjeta pedida). */
  heroTruthfulAbstentionSeconds: number;
  /** Fallos del planner/clasificación: tarjetas que no son una buena abstención. */
  heroUnresolvedSeconds: number;
  /** Segundos HERO que acabarán SEGURO en tarjeta (abstención + sin resolver + texto + esquema). */
  heroTextCardSeconds: number;
  heroTextCardRatio: number;
  heroTextCardCount: number;
  /** Proposiciones de prueba que HERO exige sin material aprobado: "EVIDENCE:web-3 — «cita»". */
  heroMissingRequiredEvidence: string[];
  heroMissingRequiredIdentities: string[];
  /** Proporción de escenas que acabarán SEGURO en tarjeta por carencia (toda la producción; guarda existente). */
  estimatedTextCardRatio: number;
  threeCardRunRisk: boolean;
  /** Toda la producción. */
  missingIdentities: string[];
  missingEvidence: string[];
  /** Fallos inevitables con las reglas: si hay alguno, no se gasta nada. */
  blockers: string[];
};

/**
 * Cobertura del opening (HERO) con material legal y verdadero (no movimiento).
 * Bloquea por CONTRATOS sin cubrir, no por porcentajes cosméticos:
 *   - HERO_EVIDENCE_COVERAGE_MISSING: HERO exige pruebas y NINGUNA tiene material aprobado
 *     (un retrato de IDENTITY, un PLACE o un documento genérico no son cobertura de prueba);
 *   - HERO_IDENTITY_COVERAGE_MISSING: HERO exige personas y NINGUNA tiene material aprobado;
 *   - reglas existentes: 3 tarjetas seguidas en los primeros 30 s; proporción global de tarjetas.
 * Una proposición sin cubrir entre varias cubiertas se informa con exactitud, sin bloquear por sí sola.
 */
export function heroCoverage(shots: CoverageShot[], registry: VerifiedAssetRegistry | undefined, maxTextFallbackRatio: number): HeroCoverage {
  const reg = registry ?? VerifiedAssetRegistry.empty();
  const out: HeroCoverage = {
    heroDuration: 0,
    heroIdentitySeconds: 0,
    heroEvidenceSeconds: 0,
    heroContextSeconds: 0,
    heroTruthfulAbstentionSeconds: 0,
    heroUnresolvedSeconds: 0,
    heroTextCardSeconds: 0,
    heroTextCardRatio: 0,
    heroTextCardCount: 0,
    heroMissingRequiredEvidence: [],
    heroMissingRequiredIdentities: [],
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
  // Contratos que HERO exige: clave → { etiqueta, cubierto }.
  const heroIdentity = new Map<string, { label: string; covered: boolean }>();
  const heroEvidence = new Map<string, { label: string; covered: boolean }>();
  for (const s of shots) {
    const hero = tierSeconds(s.startSec, s.endSec).HERO;
    const v = s.anchoredVisual;
    const card = certainCard(s);
    const contract = contractForVisual(v);
    if (card) degraded++;
    if (card === "abstention" && v?.identity && !reg.covers(v)) missingId.add(v.identity.name);
    if (card === "abstention" && contract?.kind === "EVIDENCE") missingEv.add(contractKey(contract).replace(/^EVIDENCE:/, ""));
    const isCard = !!card || s.type === "text" || requiresSchematic(v);
    if (s.startSec < OPENING_CARD_WINDOW_SEC && isCard) run.push(s.id);
    else {
      if (run.length >= OPENING_CARD_RUN_MAX) out.threeCardRunRisk = true;
      run = [];
    }
    if (hero <= 0) continue;
    out.heroDuration += hero;
    if (contract && v) {
      const key = contractKey(contract);
      const label = contract.kind === "IDENTITY" ? contract.name : `${key} — «${contract.proposition}»`;
      const target = contract.kind === "IDENTITY" ? heroIdentity : heroEvidence;
      const prev = target.get(key);
      target.set(key, { label: prev?.label ?? label, covered: (prev?.covered ?? false) || reg.covers(v) });
    }
    if (isCard) {
      out.heroTextCardSeconds += hero;
      out.heroTextCardCount++;
    }
    if (card === "unresolved") out.heroUnresolvedSeconds += hero;
    else if (card === "abstention" || requiresSchematic(v)) out.heroTruthfulAbstentionSeconds += hero;
    else if (v && requiresIdentity(v)) out.heroIdentitySeconds += hero;
    else if (v && requiresEvidence(v)) out.heroEvidenceSeconds += hero;
    else if (s.type === "text") out.heroTruthfulAbstentionSeconds += hero;
    else out.heroContextSeconds += hero;
  }
  if (run.length >= OPENING_CARD_RUN_MAX) out.threeCardRunRisk = true;
  out.estimatedTextCardRatio = shots.length > 0 ? degraded / shots.length : 0;
  out.heroTextCardRatio = out.heroDuration > 0 ? out.heroTextCardSeconds / out.heroDuration : 0;
  out.missingIdentities = [...missingId];
  out.missingEvidence = [...missingEv];
  out.heroMissingRequiredIdentities = [...heroIdentity.values()].filter((c) => !c.covered).map((c) => c.label);
  out.heroMissingRequiredEvidence = [...heroEvidence.values()].filter((c) => !c.covered).map((c) => c.label);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  for (const k of ["heroDuration", "heroIdentitySeconds", "heroEvidenceSeconds", "heroContextSeconds", "heroTruthfulAbstentionSeconds", "heroUnresolvedSeconds", "heroTextCardSeconds", "heroTextCardRatio", "estimatedTextCardRatio"] as const) out[k] = r(out[k]);
  if (heroEvidence.size > 0 && out.heroMissingRequiredEvidence.length === heroEvidence.size) {
    out.blockers.push(`HERO_EVIDENCE_COVERAGE_MISSING: ninguna de las ${heroEvidence.size} proposiciones de prueba de HERO tiene material aprobado`);
  }
  if (heroIdentity.size > 0 && out.heroMissingRequiredIdentities.length === heroIdentity.size) {
    out.blockers.push(`HERO_IDENTITY_COVERAGE_MISSING: ninguna de las ${heroIdentity.size} identidades de HERO tiene material aprobado`);
  }
  if (out.threeCardRunRisk) out.blockers.push(`OPENING_TEXT_CARD_RUN: ${OPENING_CARD_RUN_MAX}+ tarjetas seguras seguidas en los primeros ${OPENING_CARD_WINDOW_SEC} s sin material verificado`);
  if (out.estimatedTextCardRatio > maxTextFallbackRatio) {
    out.blockers.push(`TEXT_FALLBACK_RATIO: ${Math.round(out.estimatedTextCardRatio * 100)} % de escenas acabarán seguro en tarjeta (máximo ${Math.round(maxTextFallbackRatio * 100)} %)`);
  }
  return out;
}
