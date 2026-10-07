"use server";

import { refresh } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { searchCommonsProposals } from "@/lib/providers/footage/commons";
import { canCurateAssets, decideLink, proposeAsset, revokeDecision } from "@/lib/video/long-form/asset-curation";
import { assetFromProposal, ASSET_SOURCES, type AssetSource, type CuratableAsset } from "@/lib/video/long-form/verified-assets";
import { loadCurationContext, saveCurationFile } from "./store";

/**
 * Acciones del curador. Cada una vuelve a comprobar la sesión (nunca confía
 * en la página), opera sobre UN par y guarda solo la decisión: la confianza
 * la recalcula el servidor al producir (VerifiedAssetRegistry.rehydrate).
 */
async function curator(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canCurateAssets(user) || !user?.email) throw new Error("No autorizado.");
  return user.email.toLowerCase();
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

async function context(requestId: string) {
  const ctx = await loadCurationContext(requestId);
  if (!ctx) throw new Error("Solicitud sin plan v4.");
  return ctx;
}

export async function decideAction(requestId: string, formData: FormData): Promise<void> {
  const by = await curator();
  const verdict = str(formData, "verdict");
  if (verdict !== "APPROVED" && verdict !== "REJECTED") throw new Error("Decisión inválida.");
  const ctx = await context(requestId);
  const out = decideLink(
    ctx.file,
    { proposalId: str(formData, "proposalId"), verdict, curator: by, now: new Date().toISOString(), expectedFingerprint: str(formData, "fingerprint"), creditText: str(formData, "creditText") || undefined },
    ctx.requested,
  );
  if ("error" in out) throw new Error(out.error);
  await saveCurationFile(out.file);
  refresh();
}

export async function revokeAction(requestId: string, decisionId: string): Promise<void> {
  const by = await curator();
  const ctx = await context(requestId);
  const out = revokeDecision(ctx.file, { decisionId, curator: by, now: new Date().toISOString() });
  if ("error" in out) throw new Error(out.error);
  await saveCurationFile(out.file);
  refresh();
}

/** Ingesta manual (archivo licenciado, agencia, material propio): el MISMO filtro y el MISMO curador que Commons. */
export async function proposeManualAction(requestId: string, contractKey: string, formData: FormData): Promise<void> {
  await curator();
  const ctx = await context(requestId);
  const source = str(formData, "source") as AssetSource;
  if (!(ASSET_SOURCES as readonly string[]).includes(source) || source === "commons") throw new Error("Fuente manual inválida.");
  const mime = str(formData, "mime");
  const asset: CuratableAsset = {
    id: `${source}:${str(formData, "assetId")}`,
    source,
    sourceUrl: str(formData, "sourceUrl"),
    mediaUrl: str(formData, "mediaUrl"),
    mediaType: mime.startsWith("video/") ? "video" : "image",
    mime,
    width: Number(str(formData, "width")),
    height: Number(str(formData, "height")),
    rights: { kind: source === "owned" ? "OWNED" : "LICENSED", rightsReference: str(formData, "rightsReference"), ...(str(formData, "licenseUrl") ? { licenseUrl: str(formData, "licenseUrl") } : {}) },
    ...(str(formData, "creator") ? { creator: str(formData, "creator") } : {}),
    ...(str(formData, "creditText") ? { creditText: str(formData, "creditText") } : {}),
    ...(str(formData, "description") ? { description: str(formData, "description") } : {}),
    ...(/^[0-9a-f]{64}$/.test(str(formData, "contentSha256")) ? { contentSha256: str(formData, "contentSha256") } : {}),
  };
  const out = proposeAsset(ctx.file, { asset, contractKey, origin: "manual", now: new Date().toISOString() }, ctx.requested);
  if ("error" in out) throw new Error(out.error);
  await saveCurationFile(out.file);
  refresh();
}

/** Commons → propuestas filtradas (licencia, calidad, restricciones) para ESTE contrato. Nunca aprueba nada. */
export async function searchCommonsAction(requestId: string, contractKey: string, formData: FormData): Promise<void> {
  await curator();
  const ctx = await context(requestId);
  const query = str(formData, "query");
  if (!query || !ctx.requested.has(contractKey)) throw new Error("Consulta o contrato inválidos.");
  const { proposals } = await searchCommonsProposals(query, { limit: 10 });
  let file = ctx.file;
  for (const proposal of proposals) {
    const candidate = assetFromProposal(proposal);
    if (!("asset" in candidate)) continue;
    const out = proposeAsset(file, { asset: candidate.asset, contractKey, origin: "commons", now: new Date().toISOString() }, ctx.requested);
    if ("file" in out) file = out.file;
  }
  await saveCurationFile(file);
  refresh();
}
