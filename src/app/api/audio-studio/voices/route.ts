import { NextResponse } from "next/server";
import { audioStudioUser } from "@/lib/audio-studio/server";
import { studioCatalog } from "@/lib/audio-studio/catalog";
import { parseVoiceMap, voiceAvailability } from "@/lib/audio-studio/voice";
import { VOICE_PRESETS, TTS_MODELS } from "@/lib/audio-studio/model";

/**
 * Catálogo de voces del estudio y estado de la síntesis, sin exponer configuración:
 * `synthesis` es solo "real" | "local" | "inactiva" (nunca valores de variables ni el motivo interno).
 * Con la síntesis inactiva no se consulta al proveedor (0 llamadas salientes).
 */
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET() {
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const availability = voiceAvailability(process.env);
  if (!availability.ok) return NextResponse.json({ voices: [], synthesis: "inactiva" }, { headers: NO_STORE });
  if (availability.voice.mode === "fixture") {
    return NextResponse.json({ voices: VOICE_PRESETS.map(p => ({ id: p.id, name: p.label, previewUrl: null, models: TTS_MODELS.map(m => m.id) })), synthesis: "local" }, { headers: NO_STORE });
  }
  const map = parseVoiceMap(process.env.AUDIO_STUDIO_ELEVENLABS_VOICES);
  if (!map) return NextResponse.json({ error: "El catálogo de voces todavía no está configurado.", synthesis: "real" }, { status: 503 });
  try {
    return NextResponse.json({ voices: await studioCatalog(map), synthesis: "real" }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "No se pudieron cargar las voces. Vuelve a intentar.", synthesis: "real" }, { status: 503 });
  }
}
