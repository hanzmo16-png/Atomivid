import { NextResponse } from "next/server";
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { isUuid } from "@/lib/audio-studio/model";
import { assertBlobPath } from "@/lib/audio-studio/store";

export const dynamic = "force-dynamic";

/** MP3 del episodio de la cuenta: redirige a una URL firmada de corta duración (?descargar=1 la sirve como descarga). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const { id } = await params;
  const d = studioDeps();
  const p = isUuid(id) ? await d.store.get(user.id, id).catch(() => null) : null;
  if (!p?.audio) return NextResponse.json({ error: "Audio no encontrado." }, { status: 404 });
  const path = assertBlobPath(p.audio.path, user.id, id);
  const download = new URL(request.url).searchParams.get("descargar") === "1";
  const safe = p.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 80) || "episodio";
  const url = await d.store.signedUrl(path, 600, download ? `${safe}.mp3` : undefined);
  if (!url) return NextResponse.json({ error: "No se pudo preparar el audio." }, { status: 503 });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
}
