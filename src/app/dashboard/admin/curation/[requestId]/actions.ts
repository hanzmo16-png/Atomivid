"use server";

import { refresh } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { searchCommonsProposals } from "@/lib/providers/footage/commons";
import { canCurateAssets, curationOperational, decideLink, proposeAsset, revokeDecision } from "@/lib/video/long-form/asset-curation";
import { assetFromProposal, ASSET_SOURCES, type AssetSource, type CuratableAsset } from "@/lib/video/long-form/verified-assets";
import { loadCurationContext, saveCurationFile } from "./store";
import { createServiceClient } from "@/lib/supabase/service";
import { isUploadPathFor, newUploadPath, UPLOAD_MAX_BYTES, UPLOAD_MEDIA_URL_TTL_SECONDS, UPLOAD_MIME, validateUpload, type UploadMime } from "@/lib/video/long-form/curation-upload";

/**
 * Acciones del curador. Cada una vuelve a comprobar la sesión (nunca confía
 * en la página), opera sobre UN par y guarda solo la decisión: la confianza
 * la recalcula el servidor al producir (VerifiedAssetRegistry.rehydrate).
 */
/** Correo del curador: SOLO de la sesión autenticada (nunca del formulario, del recurso ni del JSON del cliente). */
async function curator(): Promise<string> {
  if (!curationOperational()) throw new Error("Curaduría no configurada (ASSET_CURATOR_EMAILS).");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canCurateAssets(user) || !user?.email) throw new Error("No autorizado.");
  return user.email.trim().toLowerCase();
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

const UPLOAD_RIGHTS = ["PD", "CC0", "CC_BY", "LICENSED", "OWNED"] as const;
const UPLOAD_SOURCE: Record<(typeof UPLOAD_RIGHTS)[number], AssetSource> = { PD: "manual", CC0: "manual", CC_BY: "manual", LICENSED: "licensed_archive", OWNED: "owned" };
const BUCKET = "videos";

/** Paso 1 de la subida: URL de subida firmada, de un solo uso, a una ruta que este servidor elige. */
export async function createUploadTicketAction(requestId: string, contractKey: string, mime: string, size: number): Promise<{ path: string; token: string } | { error: string }> {
  await curator();
  const ctx = await context(requestId);
  if (!ctx.requested.has(contractKey)) return { error: "Contrato que el plan no pide." };
  if (!(UPLOAD_MIME as readonly string[]).includes(mime)) return { error: "Solo se aceptan imágenes JPEG, PNG o WebP." };
  if (!(size > 0) || size > UPLOAD_MAX_BYTES) return { error: `El archivo debe pesar entre 1 byte y ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.` };
  const path = newUploadPath(requestId, mime as UploadMime);
  const { data, error } = await createServiceClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: "No se pudo preparar la subida. Inténtalo de nuevo." };
  return { path, token: data.token };
}

/**
 * Paso 2: el servidor relee lo guardado y decide (tipo real, dimensiones, tamaño, SHA-256). Si pasa, se
 * PROPONE para este contrato con la procedencia y los derechos declarados. Nunca aprueba: la aprobación
 * es la decisión separada del curador sobre el par.
 */
export async function finalizeUploadAction(requestId: string, contractKey: string, path: string, formData: FormData): Promise<{ ok: true } | { error: string }> {
  await curator();
  const ctx = await context(requestId);
  if (!ctx.requested.has(contractKey)) return { error: "Contrato que el plan no pide." };
  if (!isUploadPathFor(requestId, path)) return { error: "Ruta de subida inválida." };
  const storage = createServiceClient().storage.from(BUCKET);
  const discard = async (error: string) => { await storage.remove([path]).catch(() => undefined); return { error }; };
  const rightsKind = str(formData, "rightsKind") as (typeof UPLOAD_RIGHTS)[number];
  if (!(UPLOAD_RIGHTS as readonly string[]).includes(rightsKind)) return discard("Tipo de derechos inválido.");
  const sourceUrl = str(formData, "sourceUrl"), licenseUrl = str(formData, "licenseUrl"), rightsReference = str(formData, "rightsReference");
  const httpsOk = (u: string) => /^https:\/\/[^\s]+$/i.test(u);
  if (rightsKind !== "OWNED" && !httpsOk(sourceUrl)) return discard("Indica la página de procedencia (https://…) donde se publica este archivo.");
  if (sourceUrl && !httpsOk(sourceUrl)) return discard("La procedencia debe ser una URL https://.");
  if (licenseUrl && !httpsOk(licenseUrl)) return discard("La URL de licencia debe ser https://.");
  if ((rightsKind === "LICENSED" || rightsKind === "OWNED") && !rightsReference) return discard("Indica la referencia del contrato o de la autoría (derechos licenciados/propios).");
  if (rightsKind === "CC_BY" && !str(formData, "creditText")) return discard("CC BY exige el crédito visible (autor y licencia).");
  const { data: blob, error: dlError } = await storage.download(path);
  if (dlError || !blob) return { error: "No se encontró el archivo subido. Vuelve a subirlo." };
  const checked = validateUpload(Buffer.from(await blob.arrayBuffer()));
  if ("error" in checked) return discard(`Archivo rechazado: ${checked.error}.`);
  const { data: signed, error: signError } = await storage.createSignedUrl(path, UPLOAD_MEDIA_URL_TTL_SECONDS);
  if (signError || !signed) return discard("No se pudo registrar el archivo. Inténtalo de nuevo.");
  const asset: CuratableAsset = {
    id: `upload:${checked.sha256.slice(0, 24)}`,
    source: UPLOAD_SOURCE[rightsKind],
    sourceUrl: sourceUrl || `storage:${BUCKET}/${path}`,
    mediaUrl: signed.signedUrl,
    mediaType: "image",
    mime: checked.mime,
    width: checked.width,
    height: checked.height,
    rights: rightsKind === "LICENSED" || rightsKind === "OWNED"
      ? { kind: rightsKind, rightsReference, ...(licenseUrl ? { licenseUrl } : {}) }
      : { kind: rightsKind, ...(licenseUrl ? { licenseUrl } : {}) },
    contentSha256: checked.sha256,
    ...(str(formData, "creator") ? { creator: str(formData, "creator") } : {}),
    ...(str(formData, "creditText") ? { creditText: str(formData, "creditText") } : {}),
    ...(str(formData, "description") ? { description: str(formData, "description") } : {}),
  };
  // Same bytes already proposed (same id): reuse that asset instead of a second copy.
  const existing = ctx.file.assets.find((a) => a.id === asset.id);
  const out = proposeAsset(ctx.file, { asset: existing ?? asset, contractKey, origin: "manual", now: new Date().toISOString() }, ctx.requested);
  if ("error" in out) return discard(`Archivo rechazado: ${out.error}.`);
  if (existing) await storage.remove([path]).catch(() => undefined);
  await saveCurationFile(out.file);
  refresh();
  return { ok: true };
}
