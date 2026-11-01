import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { listAccountVoices } from "@/lib/podcast/voices";
import { studioAction } from "@/lib/podcast/v3/api";
import { realLlmStep, STUDIO_SCRIPT_PROJECT_PREFIX } from "@/lib/podcast/v3/adapters";
import { STUDIO_TABLE } from "@/lib/podcast/v3/store";
import { dispatchPodcastJob } from "@/lib/podcast/video-jobs";
import { studioRecraftBlocker } from "@/lib/podcast/v3/readiness";
import { studioGenerationEnabled } from "@/lib/podcast/v3/studio";

// Cada petición hace como mucho UNA llamada al modelo (escaleta o un bloque de ~10 min, 40–90 s); 300 s como las demás
// rutas largas del proyecto deja margen ante un proveedor lento.
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
    // El LLM solo se usa si el dueño lo habilita (PODCAST_V3_LLM=1): pasa por el libro de gastos de Anthropic. El guion se
    // escribe por pasos (escaleta + bloques de ~10 min), uno por petición: cada paso cabe holgadamente en maxDuration.
    llm: null,
    llmStep: studioGenerationEnabled(user) && process.env.PODCAST_V3_LLM === "1" ? (jobId) => realLlmStep(user.id, jobId) : null,
    // Gasto de guion con IA de esta persona en 24 h: llamadas admitidas (enviadas, sin confirmar o liquidadas).
    scriptSpend: async () => {
      const { data, error } = await service.from("pi_paid_operations").select("reserved_usd, committed_usd").like("project_id", `${STUDIO_SCRIPT_PROJECT_PREFIX}${user.id}:%`)
        .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()).in("status", ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "COMMITTED"]);
      if (error || !Array.isArray(data)) throw new Error("ledger");
      return data.reduce((n, o) => n + Math.max(Number(o.reserved_usd) || 0, Number(o.committed_usd) || 0), 0);
    },
    insert: async (row) => { const { data, error } = await service.from(STUDIO_TABLE).insert(row).select("id").single(); if (error) return /does not exist|schema cache|42P01|PGRST205/.test(`${error.code} ${error.message}`) ? "missing" : null; return data as { id: string }; },
    ownsAvatar: async (id) => { if (!/^[0-9a-f-]{36}$/i.test(id)) return false; const { data } = await service.from("avatars").select("id").eq("id", id).eq("user_id", user.id).eq("status", "ready").maybeSingle(); return !!data; },
    load: async () => null, authorize: async () => false, dispatch: (id) => dispatchPodcastJob(id, "studio"),
    recraftBlocker: () => studioRecraftBlocker(service),
  }, body);
  return NextResponse.json(out.body, { status: out.status });
}
