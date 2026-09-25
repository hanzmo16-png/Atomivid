"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { generateDocumentaryScript } from "@/lib/video/long-form/documentary-script";
import type { LongFormScriptJson } from "@/lib/video/long-form/produce";
import { parseOpenQuestions, parseSources } from "./parse";
import { generateDiagnosticId } from "@/lib/video/render-error";

const MIN_DURATION_MINUTES = 3;
const MAX_DURATION_MINUTES = 15;

/**
 * QA real (2026-09-25, "duration_seconds CHECK CONSTRAINT + FORM STATE
 * LOST ON ERROR"): tras el fix del submit silencioso, Hans vio el error
 * crudo de Postgres ("new row for relation ... violates check constraint
 * ...") y perdió tema/fuentes/preguntas al volver a la página. Todo
 * redirect recuperable de este formulario debe (a) llevar el mismo
 * mensaje visible de siempre y (b) devolver los valores ya escritos, para
 * que page.tsx los use como defaultValue — nunca solo "?error=...".
 */
function longFormFormRedirect(
  error: string,
  fields: { topic: string; durationMinutes: string; sources: string; openQuestions: string },
): never {
  const params = new URLSearchParams({
    error,
    topic: fields.topic,
    duration_minutes: fields.durationMinutes,
    sources: fields.sources,
    open_questions: fields.openQuestions,
  });
  redirect(`/dashboard/long-form/new?${params.toString()}`);
}

/**
 * Nunca se expone al cliente el texto crudo de un error de Postgres (p.
 * ej. "violates check constraint video_requests_duration_seconds_check")
 * — ni su nombre de constraint, ni su detalle interno. El código
 * '23514' es check_violation (mismo código para duration_seconds, mode,
 * aspect_ratio, etc. — cualquier CHECK de video_requests). Se registra el
 * detalle completo server-side junto a un diagnosticId (mismo patrón que
 * generateDiagnosticId ya usa run-job.ts/render-error.ts) para que
 * soporte pueda investigar sin adivinar, sin que el usuario vea nada
 * técnico.
 */
function classifyInsertError(error: { message: string; code?: string }): string {
  const diagnosticId = generateDiagnosticId();
  console.error(`[atomivid:long-form-insert] (Código: ${diagnosticId}) [${error.code ?? "sin código"}] ${error.message}`);
  if (error.code === "23514") {
    return `No se pudo guardar la solicitud: algún valor del formulario está fuera de rango. Revisa la duración y vuelve a intentarlo. (Código: ${diagnosticId})`;
  }
  return `No se pudo guardar la solicitud. Inténtalo de nuevo en unos minutos. (Código: ${diagnosticId})`;
}

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
  const durationMinutesRaw = String(formData.get("duration_minutes") ?? "");
  const durationMinutes = Number(durationMinutesRaw);
  const sourcesRaw = String(formData.get("sources") ?? "");
  const openQuestionsRaw = String(formData.get("open_questions") ?? "");
  const submittedFields = { topic, durationMinutes: durationMinutesRaw, sources: sourcesRaw, openQuestions: openQuestionsRaw };

  if (topic.length < 3 || topic.length > 200) {
    longFormFormRedirect("El tema debe tener entre 3 y 200 caracteres.", submittedFields);
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    longFormFormRedirect(
      `La duración debe estar entre ${MIN_DURATION_MINUTES} y ${MAX_DURATION_MINUTES} minutos.`,
      submittedFields,
    );
  }

  const sources = parseSources(sourcesRaw);
  if (sources.length === 0) {
    longFormFormRedirect(
      "Agrega al menos una fuente verificada. Un documental de Long Form nunca se genera sin fuentes.",
      submittedFields,
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
    longFormFormRedirect(message, submittedFields);
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
    longFormFormRedirect(classifyInsertError(error), submittedFields);
  }

  redirect("/dashboard?created=1");
}
