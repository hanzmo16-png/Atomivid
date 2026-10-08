import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { activeApprovals, canCurateAssets, curationOperational, contractSentence, nextReview, pendingReviews } from "@/lib/video/long-form/asset-curation";
import { contractKey } from "@/lib/video/long-form/verified-assets";
import { decideAction, proposeManualAction, revokeAction, searchCommonsAction } from "./actions";
import { loadCurationContext } from "./store";

/**
 * Curador mínimo (ADMIN/INTERNO): UN par recurso ↔ contrato cada vez. El
 * contrato exacto aparece junto a la imagen; solo se puede APROBAR o RECHAZAR
 * ESTE vínculo. Sin aprobación en bloque, sin editor de regiones.
 */
export default async function AssetCurationPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Falla cerrada: sin ASSET_CURATOR_EMAILS la curaduría no existe (ningún fallback de "primer admin").
  if (!curationOperational() || !canCurateAssets(user)) notFound();
  const ctx = await loadCurationContext(requestId);
  if (!ctx) notFound();

  const review = nextReview(ctx.file, ctx.requested);
  const remaining = pendingReviews(ctx.file, ctx.requested).length;
  const approvals = activeApprovals(ctx.file);
  const approvedKeys = new Set(approvals.map((d) => d.contractKey));
  const decide = decideAction.bind(null, requestId);
  const label = "block text-xs font-semibold uppercase text-ink-muted";
  const input = "w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-ink">Curaduría de recursos — {ctx.topic}</h1>
      <p className="text-sm text-ink-muted">Pares pendientes: {remaining}. Un recurso de Commons, una licencia o una descripción no son confianza: solo tu decisión sobre ESTE par lo es.</p>

      {review ? (
        <section className="space-y-3 rounded-lg border border-border-strong p-4">
          <p className="rounded bg-surface-raised px-3 py-2 text-lg font-semibold text-ink">{review.sentence}</p>
          {review.asset.mediaType === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- vista previa de la fuente original, sin optimización
            <img src={review.asset.mediaUrl} alt="" className="max-h-[480px] w-full rounded object-contain" />
          ) : (
            <video controls src={review.asset.mediaUrl} className="max-h-[480px] w-full rounded" />
          )}
          <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-muted">Tipo de fuente</dt>
            <dd>{review.asset.source} (propuesta: {review.proposal.origin})</dd>
            <dt className="text-ink-muted">Fuente</dt>
            <dd className="break-all">
              <a href={review.asset.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                {review.asset.sourceUrl}
              </a>
            </dd>
            <dt className="text-ink-muted">Descripción</dt>
            <dd>{review.asset.description ?? "—"}</dd>
            <dt className="text-ink-muted">Licencia / derechos</dt>
            <dd>
              {review.asset.rights.kind}
              {"rightsReference" in review.asset.rights ? ` — contrato: ${review.asset.rights.rightsReference}` : ""}
            </dd>
            <dt className="text-ink-muted">URL de licencia</dt>
            <dd className="break-all">{review.asset.rights.licenseUrl ?? "—"}</dd>
            <dt className="text-ink-muted">Restricciones</dt>
            <dd>{review.asset.licenseEvidence?.restrictions || review.asset.licenseEvidence?.usageTerms || "ninguna declarada"}</dd>
            <dt className="text-ink-muted">Autor</dt>
            <dd>{review.asset.creator ?? "—"}</dd>
            <dt className="text-ink-muted">Crédito</dt>
            <dd>{review.asset.creditText ?? "—"}</dd>
            <dt className="text-ink-muted">Dimensiones</dt>
            <dd>
              {review.asset.width} × {review.asset.height} px ({review.asset.mime})
            </dd>
            <dt className="text-ink-muted">Regiones</dt>
            <dd>{review.asset.regions?.length ? review.asset.regions.map((r) => `${r.label} (${r.x}, ${r.y}, ${r.w}, ${r.h})`).join("; ") : "—"}</dd>
          </dl>
          {review.approvalBlockers.length > 0 && (
            <p role="alert" className="text-sm text-danger">
              No se puede aprobar todavía: {review.approvalBlockers.join("; ")}
            </p>
          )}
          <form action={decide} className="space-y-2">
            <input type="hidden" name="proposalId" value={review.proposal.id} />
            <input type="hidden" name="fingerprint" value={review.fingerprint} />
            {review.asset.rights.kind === "CC_BY" && (
              <label className="block">
                <span className={label}>Atribución visible (obligatoria con CC BY)</span>
                <input name="creditText" defaultValue={review.asset.creditText ?? ""} className={input} />
              </label>
            )}
            <div className="flex gap-3">
              <button type="submit" name="verdict" value="APPROVED" className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">
                Aprobar ESTE vínculo
              </button>
              <button type="submit" name="verdict" value="REJECTED" className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white">
                Rechazar ESTE vínculo
              </button>
            </div>
          </form>
        </section>
      ) : (
        <p className="text-sm text-ink-muted">No hay pares pendientes.</p>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Contratos del plan</h2>
        {[...ctx.requested.values()].map((req) => (
          <details key={req.key} className="rounded border border-border-strong p-3 text-sm">
            <summary>
              {contractSentence(req.contract)} — {req.shotIds.length} escena(s), {req.heroSeconds.toFixed(1)} s en HERO — {approvedKeys.has(req.key) ? "con material aprobado" : "SIN material aprobado"}
            </summary>
            <form action={searchCommonsAction.bind(null, requestId, req.key)} className="mt-2 flex gap-2">
              <input name="query" defaultValue={req.contract.kind === "IDENTITY" ? req.contract.name : ""} className={input} />
              <button type="submit" className="rounded border border-border-strong px-3 py-1">
                Proponer desde Commons
              </button>
            </form>
            <form action={proposeManualAction.bind(null, requestId, req.key)} className="mt-3 grid grid-cols-2 gap-2">
              <select name="source" className={input} defaultValue="licensed_archive">
                <option value="licensed_archive">Archivo licenciado</option>
                <option value="manual">Fuente curada (licencia)</option>
                <option value="owned">Material propio</option>
              </select>
              {["assetId", "sourceUrl", "mediaUrl", "mime", "width", "height", "rightsReference", "licenseUrl", "creator", "creditText", "description", "contentSha256"].map((name) => (
                <input key={name} name={name} placeholder={name} className={input} />
              ))}
              <button type="submit" className="col-span-2 rounded border border-border-strong px-3 py-1">
                Proponer recurso manual para este contrato
              </button>
            </form>
          </details>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-ink">Aprobaciones vigentes</h2>
        {approvals.length === 0 && <p className="text-sm text-ink-muted">Ninguna.</p>}
        {approvals.map((d) => (
          <form key={d.id} action={revokeAction.bind(null, requestId, d.id)} className="flex items-center justify-between gap-3 rounded border border-border-strong p-2 text-sm">
            <span>
              {d.assetId} → {contractSentence(d.contract)} ({d.curatorEmail}, {d.decidedAt}){contractKey(d.contract) !== d.contractKey ? " [contrato incoherente]" : ""}
            </span>
            <button type="submit" className="rounded border border-red-700 px-3 py-1 text-red-700">
              Revocar
            </button>
          </form>
        ))}
      </section>
    </div>
  );
}
