import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { createLongFormVideoRequest } from "./actions";
import { SubmitButton } from "./SubmitButton";

// QA real (2026-09-25, "GENERAR GUION NO HACE NADA EN PRODUCTION"): sin
// esto, el Server Action de este formulario quedaba al límite por defecto
// de la plataforma — exactamente la misma causa raíz, con el mismo
// comentario, que ya se documentó y corrigió para el guion de Reel (ver
// export const maxDuration en src/app/api/generate/[id]/script/route.ts).
// generateDocumentaryScript() pide hasta 8000 tokens de salida (4x el
// guion de Reel) en una sola llamada real a Claude — sin este límite
// explícito, Vercel cortaba la función a medias antes de que
// createLongFormVideoRequest llegara a insertar la fila o a su propio
// catch/redirect de error, así que Hans no veía ni éxito ni error: el
// submit se veía como si "no hiciera nada" (confirmado leyendo
// producción: cero filas mode='long_form' existen). Los Server Actions
// heredan el maxDuration de la página que los invoca (ver docs de Next.js
// para "Server Actions" bajo maxDuration), no el de actions.ts.
export const maxDuration = 120;

/**
 * RC mission Fase 4 — entrada self-service de Long Form (documental
 * 16:9/YouTube), beta/admin-only (ver private-access.ts). A diferencia de
 * Reel, el guion NUNCA se genera solo a partir de un tema libre — Long
 * Form es documental/factual y exige al menos una fuente verificada (ver
 * documentary-script.ts: "nunca genera contenido factual sin fuentes"),
 * así que este formulario pide también las fuentes que respaldan el tema.
 */
export default async function NewLongFormVideoPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    topic?: string;
    duration_minutes?: string;
    sources?: string;
    open_questions?: string;
  }>;
}) {
  // QA real (2026-09-25, "FORM STATE LOST ON ERROR"): tras un error
  // recuperable (validación, proveedor o DB), actions.ts reenvía los
  // mismos valores que el usuario ya escribió como query params — se usan
  // aquí como defaultValue para que nunca tenga que volver a escribir
  // tema/fuentes/preguntas. Sin submit previo, estos params no existen y
  // los campos quedan vacíos/con su default de siempre (10 minutos).
  const { error, topic, duration_minutes: durationMinutes, sources, open_questions: openQuestions } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!canAccessLongFormBeta(user)) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Nuevo documental (beta)</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Long Form/YouTube — video 1920×1080 con narración, imágenes/video de archivo y clips
        generados con IA solo donde aportan valor. Función beta, visible únicamente para tu
        cuenta.
      </p>

      {error && (
        <div className="mt-4">
          <Alert tone="danger" role="alert">
            <span className="[&::first-letter]:uppercase">{error.replaceAll("+", " ")}</span>
          </Alert>
        </div>
      )}

      <Card className="mt-6 p-6">
        <form action={createLongFormVideoRequest} className="space-y-4">
          <Field id="topic" label="Tema del documental">
            <input
              id="topic"
              name="topic"
              type="text"
              required
              maxLength={200}
              defaultValue={topic ?? ""}
              className={INPUT_CLASS}
              placeholder="Ej. Göbekli Tepe: el misterio de 11,000 años que cambió nuestra historia"
            />
          </Field>

          <Field id="duration_minutes" label="Duración objetivo (minutos)" hint="Entre 3 y 15 minutos — 8-12 es lo recomendado.">
            <input
              id="duration_minutes"
              name="duration_minutes"
              type="number"
              required
              min={3}
              max={15}
              defaultValue={durationMinutes ?? "10"}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            id="sources"
            label="Fuentes verificadas"
            hint='Una por línea: "Título | URL o referencia | nota (opcional)". Al menos una es obligatoria — el guion nunca se genera sin fuentes.'
          >
            <textarea
              id="sources"
              name="sources"
              required
              rows={6}
              defaultValue={sources ?? ""}
              className={`${INPUT_CLASS} font-mono text-xs`}
              placeholder={
                "Göbekli Tepe UNESCO World Heritage listing | https://whc.unesco.org/en/list/1572\n" +
                "Schmidt, K. — excavation reports | | resumen de hallazgos 1995-2014"
              }
            />
          </Field>

          <Field id="open_questions" label="Preguntas abiertas o debatidas (opcional)" hint="Una por línea — se presentan como abiertas, nunca como hecho.">
            <textarea
              id="open_questions"
              name="open_questions"
              rows={3}
              defaultValue={openQuestions ?? ""}
              className={`${INPUT_CLASS} font-mono text-xs`}
            />
          </Field>

          <SubmitButton />
          <p className="text-xs text-ink-faint">
            Esto genera el guion con IA ahora mismo (costo real, mismo criterio que el guion de
            Reel). Puede tardar hasta un minuto — no cierres esta pantalla ni pulses el botón más
            de una vez. El video final se genera después, desde tu historial, y solo cuando lo
            confirmes.
          </p>
        </form>
      </Card>
    </div>
  );
}
