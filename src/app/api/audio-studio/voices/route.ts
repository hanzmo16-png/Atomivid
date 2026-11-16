import { NextResponse } from "next/server";
import { audioStudioUser } from "@/lib/audio-studio/server";
import { studioCatalog } from "@/lib/audio-studio/catalog";
import { parseVoiceMap } from "@/lib/audio-studio/voice";
import { VOICE_PRESETS, TTS_MODELS } from "@/lib/audio-studio/model";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  if (process.env.AUDIO_STUDIO_VOICE === "fixture" && !process.env.VERCEL && process.env.NODE_ENV !== "production") {
    return NextResponse.json({ voices: VOICE_PRESETS.map(p => ({ id: p.id, name: p.label, previewUrl: null, models: TTS_MODELS.map(m => m.id) })) });
  }
  const map = parseVoiceMap(process.env.AUDIO_STUDIO_ELEVENLABS_VOICES);
  if (!map) return NextResponse.json({ error: "El catálogo de voces todavía no está configurado." }, { status: 503 });
  try {
    return NextResponse.json({ voices: await studioCatalog(map) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudieron cargar las voces. Vuelve a intentar." }, { status: 503 });
  }
}
