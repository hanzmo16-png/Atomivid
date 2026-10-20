import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReelVoiceCatalog } from "@/lib/video/reel-voices-server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const language = new URL(request.url).searchParams.get("language");
  if (language !== "es" && language !== "en") return NextResponse.json({ error: "Idioma no válido" }, { status: 400 });
  try {
    return NextResponse.json(await getReelVoiceCatalog(language), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "No pudimos cargar las voces. Puedes continuar con la voz predeterminada." }, { status: 503 });
  }
}
