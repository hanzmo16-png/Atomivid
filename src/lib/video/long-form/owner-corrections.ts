/**
 * Correcciones del PROPIETARIO sobre un guion ya aprobado (recuperación de e8048599, 2026-10-24).
 *
 * `applyNarrationPatches` corrige la narración, las citas de escena y las marcas de edición. Un guion persistido tiene
 * además anclas que viven FUERA de los beats y que `editorialApprovalError` comprueba antes de configurar y producir:
 *  - las citas de la revisión editorial (secciones, primera respuesta, cierre, hallazgos, ubicaciones de citas);
 *  - `editorial.creativeDirection` (las marcas de edición se guardan en el informe, no en el guion);
 *  - `editorial.scriptHash`, que liga el informe al contenido exacto de los beats.
 * Sin esto, el guion corregido se rechazaría con «El guion cambió después de la revisión editorial» y la producción
 * saldría SIN las correcciones (o no saldría). Aquí se aplican todas juntas, todo o nada:
 *  - las citas de la revisión se corrigen con las MISMAS reglas que las de escena (se transportan como escenas
 *    sombra de su beat, así una cita editorial que deja de localizarse anula la corrección completa);
 *  - las afirmaciones (`claims`) que repiten el dato corregido se reemplazan por id, con su motivo;
 *  - el hash se recalcula y el informe registra qué se corrigió, sobre qué hash aprobado y con qué digest;
 *  - el resultado final debe pasar `editorialApprovalError`; si no, no se aplica nada.
 * Nunca se aplica durante el trabajo del guion: cambiaría la huella de las respuestas ya pagadas.
 */
import { createHash } from "node:crypto";
import { applyNarrationPatches, type NarrationPatch, type PatchReport } from "./narration-patch";
import { editorialApprovalError, editorialScriptHash, type EditorialReport, type EditorialScript } from "./editorial";

export type ClaimPatch = { beatIndex: number; claimId: string; text: string; support?: "sourced" | "inference" | "unverified"; reason: string };
export type OwnerCorrections = { job: string; patches: NarrationPatch[]; claimPatches?: ClaimPatch[] };
type Claim = { id: string; text: string; support?: string } & Record<string, unknown>;
type Beat = { narration: string; claims?: unknown; visuals?: unknown } & Record<string, unknown>;
export type PersistedScript = { beats: Beat[]; editorial?: EditorialReport } & Record<string, unknown>;
export type OwnerCorrectionRecord = { source: string; digest: string; approvedScriptHash: string; correctedScriptHash: string;
  narration: PatchReport["applied"]; claims: { beatIndex: number; claimId: string; reason: string }[]; reviewQuotesUpdated: number; wordDelta: number };
export type OwnerCorrectionResult = { ok: boolean; errors: string[]; script: PersistedScript; record?: OwnerCorrectionRecord; report?: PatchReport };

export function correctionsDigest(c: OwnerCorrections): string {
  return createHash("sha256").update(JSON.stringify({ patches: c.patches, claimPatches: c.claimPatches ?? [] })).digest("hex").slice(0, 16);
}

type QuoteRef = { beatIndex: number; get: () => string; set: (q: string) => void };
/** Every citation of every saved review that points into a beat. */
function reviewQuoteRefs(editorial: EditorialReport): QuoteRef[] {
  const refs: QuoteRef[] = [];
  const add = (o: { beatIndex: number; quote: string } | undefined) => { if (o && typeof o.quote === "string") refs.push({ beatIndex: o.beatIndex, get: () => o.quote, set: (q) => { o.quote = q; } }); };
  for (const r of editorial.reviews ?? []) {
    r.sections?.forEach(add);
    add(r.firstAnswer?.evidence);
    add(r.ending?.evidence);
    r.findings?.forEach((f) => f.evidence?.forEach(add));
    r.citationLocations?.forEach(add);
  }
  return refs;
}

export function applyOwnerCorrections(script: PersistedScript, corrections: OwnerCorrections, source: string,
  validate: (s: PersistedScript) => string | null = (s) => editorialApprovalError(s as never)): OwnerCorrectionResult {
  const errors: string[] = [];
  if (!script.editorial || script.editorial.status !== "approved") return { ok: false, errors: ["el guion no tiene un informe editorial aprobado"], script };
  const baseError = validate(script);
  if (baseError) return { ok: false, errors: [`el guion aprobado no es válido antes de corregir: ${baseError}`], script };
  const work = JSON.parse(JSON.stringify(script)) as PersistedScript;
  const editorial = work.editorial!;
  const refs = reviewQuoteRefs(editorial);
  // Shadow scenes: the review quotes travel with their beat through the same anchor rules as real scenes.
  const SHADOW = "__reviewQuote";
  const patchable = {
    beats: work.beats.map((b, i) => ({ ...b, visuals: [...(Array.isArray(b.visuals) ? b.visuals : []), ...refs.map((r, k) => ({ r, k })).filter(({ r }) => r.beatIndex === i).map(({ r, k }) => ({ [SHADOW]: k, quote: r.get() }))] })),
    creativeDirection: editorial.creativeDirection as unknown as Record<string, unknown> | undefined,
  };
  const { script: patched, report } = applyNarrationPatches(patchable, corrections.patches);
  if (!report.ok) return { ok: false, errors: report.errors, script, report };
  let reviewQuotesUpdated = 0;
  patched.beats.forEach((b, i) => {
    const visuals = (b.visuals as Record<string, unknown>[]);
    for (const v of visuals) if (typeof v[SHADOW] === "number") { const ref = refs[v[SHADOW] as number]; if (ref.get() !== v.quote) { ref.set(String(v.quote)); reviewQuotesUpdated++; } }
    work.beats[i].narration = b.narration;
    work.beats[i].visuals = visuals.filter((v) => typeof v[SHADOW] !== "number");
  });
  if (patched.creativeDirection) editorial.creativeDirection = patched.creativeDirection as unknown as EditorialReport["creativeDirection"];
  const claims: OwnerCorrectionRecord["claims"] = [];
  for (const c of corrections.claimPatches ?? []) {
    const list = work.beats[c.beatIndex]?.claims;
    const claim = Array.isArray(list) ? (list as Claim[]).find((x) => x && x.id === c.claimId) : undefined;
    if (!claim) { errors.push(`beat ${c.beatIndex}: no existe la afirmación ${c.claimId}`); continue; }
    if (!c.text.trim()) { errors.push(`beat ${c.beatIndex}: afirmación ${c.claimId} vacía`); continue; }
    claim.text = c.text;
    if (c.support) claim.support = c.support;
    claims.push({ beatIndex: c.beatIndex, claimId: c.claimId, reason: c.reason });
  }
  if (errors.length) return { ok: false, errors, script, report };
  const approvedScriptHash = editorial.scriptHash;
  editorial.scriptHash = editorialScriptHash(work.beats as EditorialScript["beats"]);
  const record: OwnerCorrectionRecord = { source, digest: correctionsDigest(corrections), approvedScriptHash, correctedScriptHash: editorial.scriptHash,
    narration: report.applied, claims, reviewQuotesUpdated, wordDelta: report.wordDelta };
  (editorial as EditorialReport & { ownerCorrections?: OwnerCorrectionRecord }).ownerCorrections = record;
  const finalError = validate(work);
  if (finalError) return { ok: false, errors: [`el guion corregido no supera la validación editorial: ${finalError}`], script, report };
  return { ok: true, errors: [], script: work, record, report };
}
