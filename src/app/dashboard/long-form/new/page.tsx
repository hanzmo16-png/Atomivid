import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { createLongFormVideoRequest } from "./actions";

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
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
              defaultValue={10}
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
              className={`${INPUT_CLASS} font-mono text-xs`}
              placeholder={
                "Göbekli Tepe UNESCO World Heritage listing | https://whc.unesco.org/en/list/1572\n" +
                "Schmidt, K. — excavation reports | | resumen de hallazgos 1995-2014"
              }
            />
          </Field>

          <Field id="open_questions" label="Preguntas abiertas o debatidas (opcional)" hint="Una por línea — se presentan como abiertas, nunca como hecho.">
            <textarea id="open_questions" name="open_questions" rows={3} className={`${INPUT_CLASS} font-mono text-xs`} />
          </Field>

          <Button type="submit" className="w-full">
            Generar guion
          </Button>
          <p className="text-xs text-ink-faint">
            Esto genera el guion con IA ahora mismo (costo real, mismo criterio que el guion de
            Reel). El video final se genera después, desde tu historial, y solo cuando lo
            confirmes.
          </p>
        </form>
      </Card>
    </div>
  );
}
