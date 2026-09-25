"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { generateDocumentaryScript } from "@/lib/video/long-form/documentary-script";
import type { LongFormScriptJson } from "@/lib/video/long-form/produce";
import { parseOpenQuestions, parseSources } from "./parse";

const MIN_DURATION_MINUTES = 3;
const MAX_DURATION_MINUTES = 15;

export async function createLongFormVideoRequest(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  // Nunca confiar en que la página no se haya podido cargar sin este
  // acceso — se re-verifica en el servidor, igual que canPrepareAvatar()
  // ya se re-verifica en dashboard/new/actions.ts para el modo avatar.
  if (!canAccessLongFormBeta(user)) {
    redirect("/dashboard/new?error=Esta+función+beta+no+está+disponible+para+tu+cuenta");
  }

  const topic = String(formData.get("topic") ?? "").trim();
  const durationMinutes = Number(formData.get("duration_minutes"));
  const sourcesRaw = String(formData.get("sources") ?? "");
  const openQuestionsRaw = String(formData.get("open_questions") ?? "");

  if (topic.length < 3 || topic.length > 200) {
    redirect("/dashboard/long-form/new?error=El+tema+debe+tener+entre+3+y+200+caracteres.");
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    redirect(
      `/dashboard/long-form/new?error=La+duración+debe+estar+entre+${MIN_DURATION_MINUTES}+y+${MAX_DURATION_MINUTES}+minutos.`,
    );
  }

  const sources = parseSources(sourcesRaw);
  if (sources.length === 0) {
    redirect(
      "/dashboard/long-form/new?error=Agrega+al+menos+una+fuente+verificada.+Un+documental+de+Long+Form+nunca+se+genera+sin+fuentes.",
    );
  }
  const openQuestions = parseOpenQuestions(openQuestionsRaw);

  // Llamada real a Claude (mismo costo/patrón que el guion de Reel) —
  // nunca genera contenido factual sin las fuentes de arriba, ver
  // documentary-script.ts. Cualquier fallo (sin ANTHROPIC_API_KEY, hook
  // genérico rechazado, opener prohibido, etc.) se reporta y NO crea una
  // solicitud a medias.
  let beats: Awaited<ReturnType<typeof generateDocumentaryScript>>;
  try {
    beats = await generateDocumentaryScript({
      researchPack: { topic, sources, openQuestions },
      mode: "curiosity_documentary",
      language: "es",
      targetDurationSeconds: durationMinutes * 60,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo generar el guion documental.";
    redirect(`/dashboard/long-form/new?error=${encodeURIComponent(message)}`);
  }

  const scriptJson: LongFormScriptJson = {
    topic,
    beats: beats.map((beat, i) => ({ id: `beat-${i + 1}`, ...beat })),
  };

  const { error } = await supabase.from("video_requests").insert({
    id: randomUUID(),
    user_id: user.id,
    topic,
    style: "Documental",
    duration_seconds: durationMinutes * 60,
    language: "es",
    mode: "long_form",
    aspect_ratio: "16:9",
    script_json: scriptJson,
    status: "script_ready",
  });

  if (error) {
    redirect(`/dashboard/long-form/new?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/dashboard?created=1");
}
