import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { parseVersionSegment, validEpisodeId, versionFolder } from "@/lib/podcast/editor/contract";
import { checkDelivery } from "@/lib/podcast/editor/verify";
import { ownerEditorStorage } from "@/lib/podcast/editor/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Owner-only: recompute every declared object's sha256 from Storage with the owner's own session. Only when
 * all of them match COMPLETO.json does it answer "terminado" with short-lived playback/download URLs. Nothing
 * is persisted; the URLs are never logged.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ episode: string; version: string }> }) {
  const { episode, version: versionSegment } = await params;
  const version = parseVersionSegment(versionSegment);
  if (!validEpisodeId(episode) || !version) return NextResponse.json({ error: "Episodio no encontrado" }, { status: 404 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (!canAccessLongFormBeta(user)) return NextResponse.json({ error: "Episodio no encontrado" }, { status: 404 });

  try {
    const storage = ownerEditorStorage(supabase);
    const status = await checkDelivery(storage, episode, version, { hashes: true, deadline: Date.now() + 270_000 });
    if (status.state !== "terminado") return NextResponse.json({ status }, { status: 200 });
    const base = versionFolder(episode, version);
    const files = await Promise.all(status.objetos.map(async (o) => ({
      key: o.key, size: o.size,
      play: await storage.signedUrl(`${base}/${o.key}`),
      download: await storage.signedUrl(`${base}/${o.key}`, `${episode}-v${version}-${o.key.replaceAll("/", "-")}`),
    })));
    return NextResponse.json({ status: { state: "terminado", primary: status.primary?.key ?? null }, files });
  } catch {
    return NextResponse.json({ error: "No se pudo verificar la entrega. Inténtalo de nuevo." }, { status: 503 });
  }
}
