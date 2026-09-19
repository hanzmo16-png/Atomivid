import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedVideoUrl } from "@/lib/storage/signed-url";
import { downloadablePath } from "@/lib/video/download";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Inicia sesión para descargar tu video." }, { status: 401, headers });
    const { data, error } = await supabase.from("video_requests")
      .select("id, user_id, status, video_path").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (error) return NextResponse.json({ error: "No se pudo consultar el video. Intenta de nuevo." }, { status: 503, headers });
    const path = downloadablePath(data, user.id, id);
    if (!path) return NextResponse.json({ error: "Video no disponible." }, { status: 404, headers });
    const url = await getSignedVideoUrl(path, 60, `atomivid-${id}.mp4`);
    if (!url) return NextResponse.json({ error: "No se pudo preparar la descarga. Intenta de nuevo." }, { status: 503, headers });
    return new NextResponse(null, { status: 307, headers: { ...headers, Location: url } });
  } catch {
    return NextResponse.json({ error: "No se pudo preparar la descarga. Intenta de nuevo." }, { status: 503, headers });
  }
}
