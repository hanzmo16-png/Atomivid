import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { listAccountVoices } from "@/lib/podcast/voices";
import { studioAction } from "@/lib/podcast/v3/api";
import { realLlm } from "@/lib/podcast/v3/adapters";
import { scriptMaxTokens } from "@/lib/podcast/v3/script";
import { STUDIO_TABLE } from "@/lib/podcast/v3/store";
import { dispatchPodcastJob } from "@/lib/podcast/video-jobs";
import { studioRecraftBlocker } from "@/lib/podcast/v3/readiness";
import { studioGenerationEnabled } from "@/lib/podcast/v3/studio";

// Un guion largo con IA (hasta ~30 min, ~7.000 tokens) no cabía en 60 s: la función se cortaba a mitad y la reserva
// quedaba abierta (incidente 8f05fc37). 300 s como las demás rutas largas del proyecto.
export const maxDuration = 300;

/** Podcast 3.0: guion (plantilla o LLM), estimación y creación de borrador. Ninguna acción genera medios ni cobra. */
export async function POST(request: Request) {
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const service = createServiceClient();
  // Con el estudio apagado no se emiten URLs de subida ni se usa el LLM de pago (solo plantilla y estimación gratuitas).
  if (body?.action === "photo-ticket" && !studioGenerationEnabled(user)) return NextResponse.json({ error: "La subida de fotos para avatares se activa con el estudio (pendiente de autorización)." }, { status: 503 });
  if (body?.action === "photo-ticket") {
    // Foto para crear un avatar: solo JPEG/PNG ≤ 10 MB, en la carpeta del propio usuario. El consentimiento se registra en la especificación.
    if (!["image/jpeg", "image/png"].includes(String(body.mime)) || !(Number(body.size) > 0 && Number(body.size) <= 10 * 1024 * 1024)) return NextResponse.json({ error: "Sube una foto JPG o PNG de hasta 10 MB." }, { status: 400 });
    const path = `${user.id}/podcast-studio/photos/${crypto.randomUUID()}.${body.mime === "image/png" ? "png" : "jpg"}`;
    const { data, error } = await service.storage.from("videos").createSignedUploadUrl(path);
    return error || !data ? NextResponse.json({ error: "No se pudo preparar la subida." }, { status: 500 }) : NextResponse.json({ path, token: data.token });
  }
  const out = await studioAction({
    userId: user.id, viewer: user, voices: () => listAccountVoices(), enabled: studioGenerationEnabled(user),
    // El LLM solo se usa si el dueño lo habilita (PODCAST_V3_LLM=1): pasa por el libro de gastos de Anthropic.
    llm: studioGenerationEnabled(user) && process.env.PODCAST_V3_LLM === "1" ? realLlm(user.id, String(body?.topic ?? "").slice(0, 80), scriptMaxTokens(Math.min(30, Math.max(1, Number(body?.minutes) || 5)))) : null,
    insert: async (row) => { const { data, error } = await service.from(STUDIO_TABLE).insert(row).select("id").single(); if (error) return /does not exist|schema cache|42P01|PGRST205/.test(`${error.code} ${error.message}`) ? "missing" : null; return data as { id: string }; },
    ownsAvatar: async (id) => { if (!/^[0-9a-f-]{36}$/i.test(id)) return false; const { data } = await service.from("avatars").select("id").eq("id", id).eq("user_id", user.id).eq("status", "ready").maybeSingle(); return !!data; },
    load: async () => null, authorize: async () => false, dispatch: (id) => dispatchPodcastJob(id, "studio"),
    recraftBlocker: () => studioRecraftBlocker(service),
  }, body);
  return NextResponse.json(out.body, { status: out.status });
}
