/**
 * Curador humano mínimo (ADMIN/INTERNO). Lógica pura sobre el archivo de
 * curaduría de una solicitud; la página y las acciones del servidor solo la
 * llaman tras comprobar la sesión del curador.
 *
 * Reglas:
 *   - UN par (recurso ↔ contrato) cada vez; no existe aprobación en bloque.
 *   - El contrato lo trae la escena que pidió el recurso (no hay lista libre
 *     de afirmaciones): el curador solo APRUEBA o RECHAZA ESTE vínculo.
 *   - Licencia fuera de la lista V1, calidad < 1280 px o derechos incompletos
 *     nunca llegan a aprobación (sin excepción manual).
 *   - CC BY no se aprueba sin atribución.
 *   - Lo que se persiste es la decisión (huella del recurso, contrato, curador,
 *     fecha, versión), nunca autoridad: la confianza la recalcula el servidor
 *     en cada carga (VerifiedAssetRegistry.rehydrate).
 */
import type { BeatVisual } from "./visual-intents";
import {
  assetFingerprint,
  contractForVisual,
  contractKey,
  validateAsset,
  type CoverageShot,
  type CuratableAsset,
  type CurationDecisionEntry,
  type CurationFile,
  type LinkContract,
  type LinkProposal,
} from "./verified-assets";
import { tierSeconds } from "./cinematic-director";

export const CURATION_FILE_PATH = (requestId: string) => `${requestId}/state/curation.json`;

export function emptyCurationFile(requestId: string): CurationFile {
  return { version: 1, requestId, assets: [], proposals: [], decisions: [] };
}

/** Forma del archivo (NO confianza): lo ilegible se trata como vacío. */
export function parseCurationFile(raw: unknown, requestId: string): CurationFile {
  const f = raw && typeof raw === "object" ? (raw as Partial<CurationFile>) : null;
  if (!f || f.requestId !== requestId) return emptyCurationFile(requestId);
  return {
    version: 1,
    requestId,
    assets: Array.isArray(f.assets) ? f.assets : [],
    proposals: Array.isArray(f.proposals) ? f.proposals : [],
    decisions: Array.isArray(f.decisions) ? f.decisions : [],
  };
}

export type RequestedContract = { key: string; contract: LinkContract; shotIds: string[]; heroSeconds: number };

/** Contratos que el plan pide (identidades y proposiciones de prueba), con su peso en HERO. */
export function requestedContracts(shots: CoverageShot[]): Map<string, RequestedContract> {
  const out = new Map<string, RequestedContract>();
  for (const s of shots) {
    const contract = contractForVisual(s.anchoredVisual as BeatVisual | undefined);
    if (!contract) continue;
    const key = contractKey(contract);
    const prev = out.get(key) ?? { key, contract, shotIds: [], heroSeconds: 0 };
    prev.shotIds.push(s.id);
    prev.heroSeconds += tierSeconds(s.startSec, s.endSec).HERO;
    out.set(key, prev);
  }
  return out;
}

/** La frase EXACTA que ve el curador junto a la imagen. */
export function contractSentence(contract: LinkContract): string {
  if (contract.kind === "IDENTITY") return `This asset is being approved to represent: ${contract.name}`;
  return `This asset is being approved to support: «${contract.proposition}» (sources: ${contract.sourceIds.join(", ")}${contract.claimIds?.length ? `; claims: ${contract.claimIds.join(", ")}` : ""})`;
}

type Result = { file: CurationFile } | { error: string };

/**
 * Propone UN recurso para UN contrato pedido por el plan. Lo que no pasa los
 * filtros (licencia, calidad, derechos) no entra al archivo y nunca aparece.
 */
export function proposeAsset(
  file: CurationFile,
  input: { asset: CuratableAsset; contractKey: string; origin: "commons" | "manual"; now: string },
  requested: Map<string, RequestedContract>,
): Result {
  const req = requested.get(input.contractKey);
  if (!req) return { error: "contrato que el plan no pide" };
  const reasons = validateAsset(input.asset);
  if (reasons.length) return { error: reasons.join("; ") };
  const existing = file.assets.find((a) => a.id === input.asset.id);
  if (existing && assetFingerprint(existing) !== assetFingerprint(input.asset)) return { error: "ya existe un recurso con ese id y otro contenido/metadata: usa un id nuevo" };
  if (file.proposals.some((p) => p.assetId === input.asset.id && contractKey(p.contract) === input.contractKey)) return { file };
  const proposal: LinkProposal = { id: `p-${file.proposals.length + 1}`, assetId: input.asset.id, contract: req.contract, origin: input.origin, proposedAt: input.now };
  return { file: { ...file, assets: existing ? file.assets : [...file.assets, structuredClone(input.asset)], proposals: [...file.proposals, proposal] } };
}

export type CuratorReview = {
  proposal: LinkProposal;
  asset: CuratableAsset;
  contract: LinkContract;
  contractKey: string;
  sentence: string;
  fingerprint: string;
  /** Lo que impide APROBAR ahora (p. ej. falta la atribución CC BY); rechazar siempre es posible. */
  approvalBlockers: string[];
};

function effectiveDecision(file: CurationFile, assetId: string, key: string): CurationDecisionEntry | undefined {
  return file.decisions.filter((d) => d.assetId === assetId && d.contractKey === key).sort((a, b) => b.version - a.version)[0];
}

/** Pares pendientes de decisión que pasan los filtros, en orden de propuesta. */
export function pendingReviews(file: CurationFile, requested: Map<string, RequestedContract>): CuratorReview[] {
  const out: CuratorReview[] = [];
  for (const proposal of file.proposals) {
    const key = contractKey(proposal.contract);
    if (!requested.has(key)) continue;
    const asset = file.assets.find((a) => a.id === proposal.assetId);
    if (!asset || validateAsset(asset).length > 0) continue;
    const decided = effectiveDecision(file, asset.id, key);
    if (decided && decided.status === "ACTIVE" && decided.assetFingerprint === assetFingerprint(asset)) continue;
    out.push({ proposal, asset, contract: proposal.contract, contractKey: key, sentence: contractSentence(proposal.contract), fingerprint: assetFingerprint(asset), approvalBlockers: validateAsset(asset, { forApproval: true }) });
  }
  return out;
}

/** El siguiente par a revisar: el curador nunca ve ni decide más de uno a la vez. */
export function nextReview(file: CurationFile, requested: Map<string, RequestedContract>): CuratorReview | null {
  return pendingReviews(file, requested)[0] ?? null;
}

/**
 * Decide UN par. `expectedFingerprint` es la huella que el curador tenía en
 * pantalla: si el recurso cambió entretanto, la decisión no se registra.
 */
export function decideLink(
  file: CurationFile,
  input: { proposalId: string; verdict: "APPROVED" | "REJECTED"; curator: string; now: string; expectedFingerprint: string; creditText?: string },
  requested: Map<string, RequestedContract>,
): { file: CurationFile; decision: CurationDecisionEntry } | { error: string } {
  if (!input.curator.trim()) return { error: "curador ausente" };
  const proposal = file.proposals.find((p) => p.id === input.proposalId);
  if (!proposal) return { error: "propuesta inexistente" };
  const key = contractKey(proposal.contract);
  if (!requested.has(key)) return { error: "contrato que el plan no pide" };
  const asset = file.assets.find((a) => a.id === proposal.assetId);
  if (!asset) return { error: "recurso ausente" };
  const fingerprint = assetFingerprint(asset);
  if (fingerprint !== input.expectedFingerprint) return { error: "el recurso cambió desde que se mostró: vuelve a revisarlo" };
  const credit = input.creditText?.trim() || undefined;
  if (input.verdict === "APPROVED") {
    const reasons = validateAsset(asset, { forApproval: true, creditText: credit });
    if (reasons.length) return { error: reasons.join("; ") };
  }
  const prev = effectiveDecision(file, asset.id, key);
  const decision: CurationDecisionEntry = {
    id: `d-${file.decisions.length + 1}`,
    proposalId: proposal.id,
    assetId: asset.id,
    assetFingerprint: fingerprint,
    contractKey: key,
    contract: structuredClone(proposal.contract),
    requestId: file.requestId,
    verdict: input.verdict,
    status: "ACTIVE",
    decidedBy: input.curator,
    decidedAt: input.now,
    version: (prev?.version ?? 0) + 1,
    ...(input.verdict === "APPROVED" && credit ? { approved: { creditText: credit } } : {}),
  };
  return { file: { ...file, decisions: [...file.decisions, decision] }, decision };
}

/** ACTIVE → REVOKED. Una aprobación revocada no se rehidrata. */
export function revokeDecision(file: CurationFile, input: { decisionId: string; curator: string; now: string }): Result {
  const target = file.decisions.find((d) => d.id === input.decisionId);
  if (!target) return { error: "decisión inexistente" };
  if (target.status === "REVOKED") return { file };
  return { file: { ...file, decisions: file.decisions.map((d) => (d.id === target.id ? { ...d, status: "REVOKED" as const, revokedBy: input.curator, revokedAt: input.now } : d)) } };
}

/** Decisiones aprobadas y vigentes (para listarlas con su botón de revocación). */
export function activeApprovals(file: CurationFile): CurationDecisionEntry[] {
  return file.decisions.filter((d) => d.verdict === "APPROVED" && d.status === "ACTIVE" && effectiveDecision(file, d.assetId, d.contractKey)?.id === d.id);
}

/** Autoridad de curaduría (servidor): correos confirmados en ASSET_CURATOR_EMAILS. Sin configurar = nadie (falla cerrada). */
export function isAuthorizedCurator(email: string | undefined | null, env: Record<string, string | undefined> = process.env): boolean {
  const allowed = (env.ASSET_CURATOR_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && allowed.includes(email.trim().toLowerCase());
}

export function canCurateAssets(user: { email?: string; email_confirmed_at?: string } | null, env: Record<string, string | undefined> = process.env): boolean {
  return !!user?.email_confirmed_at && isAuthorizedCurator(user.email, env);
}
