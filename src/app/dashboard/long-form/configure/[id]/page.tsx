import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { isLongFormScriptJson } from "@/lib/video/long-form/script-json";
import { editorialApprovalError } from "@/lib/video/long-form/editorial";
import {
  computeProductionPlan,
  getRealLongFormProviderNames,
  VISUAL_STRATEGIES,
  type ProductionPlan,
  type VisualStrategy,
} from "@/lib/video/long-form/production-plan";
import { ConfigureProduction } from "./ConfigureProduction";
import { defaultPackaging, isOwnChannelAccount } from "@/lib/video/long-form/packaging";
import { PRODUCTION_PLAN_VERSION, usesAnchoredVisuals } from "@/lib/video/long-form/production-plan-types";

type VideoRequestRow = {
  id: string;
  mode: string;
  topic: string;
  status: string;
  duration_seconds: number | null;
  script_json: unknown;
  long_form_confirmed_at: string | null;
};

/**
 * Pasos 3-9 del contrato de Long Form: revisar el guion, elegir estrategia
 * visual, ver el plan (conteos + costo estimado) y confirmar. Los 3 planes
 * se calculan aquí, en el servidor, con el MISMO motor que después ejecuta
 * el worker — sin red y sin gasto. El cliente solo elige cuál mostrar;
 * confirm-production recalcula el elegido server-side al confirmar.
 */
export default async function ConfigureLongFormProductionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();

  const { data } = await supabase
    .from("video_requests")
    .select("id, mode, topic, status, duration_seconds, script_json, long_form_confirmed_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<VideoRequestRow>();

  if (!data || data.mode !== "long_form") notFound();
  if (data.long_form_confirmed_at) redirect(`/dashboard/videos/${id}`);
  if (data.status !== "script_ready" || !isLongFormScriptJson(data.script_json)) redirect("/dashboard");

  const script = data.script_json;
  const editorialError = editorialApprovalError(script);
  if (editorialError) return <div className="mx-auto max-w-2xl"><h1 className="text-2xl font-bold">Revisión editorial pendiente</h1><p role="alert" className="mt-4">{editorialError}</p></div>;
  // Portada y miniatura: activadas por defecto solo en los canales propios de Hans (ver packaging.ts).
  const ownChannel = isOwnChannelAccount(user);
  const beats = script.beats.map((b) => ({ id: b.id, type: b.type, narration: b.narration, visuals: b.visuals }));
  const plans = Object.fromEntries(
    VISUAL_STRATEGIES.map((strategy) => [
      strategy,
      computeProductionPlan({
        beats,
        topic: script.topic || data.topic,
        strategy,
        providers: getRealLongFormProviderNames(),
        requestedDurationSeconds: data.duration_seconds ?? undefined,
      }),
    ]),
  ) as Record<VisualStrategy, ProductionPlan>;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Configurar producción</h1>
      <p className="mt-1 break-words text-sm text-ink-muted">{data.topic}</p>
      {script.editorial && <section aria-label="Revisión del guion" className="mt-4 rounded-lg border border-border p-4 text-sm">
        <p className="font-medium">Revisión editorial completada{script.editorial.corrected ? " después de una corrección" : ""}</p>
        <p className="mt-2 text-ink-muted">Se revisaron la progresión, las repeticiones y la resolución de la promesa. Es una revisión automática; no garantiza la retención de audiencia ni sustituye la verificación de fuentes.</p>
        <details className="mt-2"><summary className="cursor-pointer">Ver estructura narrativa</summary>
          <p className="mt-2">Pregunta: {script.editorial.storyPlan.centralQuestion}</p>
          <p>Primera respuesta: {script.editorial.storyPlan.firstAnswer}</p>
          <p>Resolución: {script.editorial.storyPlan.endingAnswer}</p>
        </details>
        {Array.isArray(script.sources) && script.sources.length > 0 && <details className="mt-2">
          <summary className="cursor-pointer">Ver referencias recuperadas</summary>
          <p className="mt-2 text-ink-muted">El guion utiliza fragmentos citados recuperados en la búsqueda. No se afirma haber leído las publicaciones completas.</p>
          <ul className="mt-2 list-inside list-disc">{script.sources.map(source => <li key={source.id}>
            {source.locator && /^https?:\/\//i.test(source.locator)
              ? <a className="underline" href={source.locator} target="_blank" rel="noopener noreferrer">{source.title}</a>
              : source.title}
          </li>)}</ul>
        </details>}
      </section>}

      <details className="mt-5 rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">Revisar el guion ({script.beats.length} bloques)</summary>
        <ol className="mt-3 flex flex-col gap-3 text-sm text-ink-muted">
          {script.beats.map((beat, i) => (
            <li key={beat.id} className="break-words">
              <span className="font-medium text-ink">{i + 1}.</span> {beat.narration}
            </li>
          ))}
        </ol>
      </details>

      <ConfigureProduction
        requestId={id}
        plans={plans}
        ownChannel={ownChannel}
        defaultPackaging={usesAnchoredVisuals({ version: PRODUCTION_PLAN_VERSION }) ? defaultPackaging({ topic: script.topic || data.topic, ownChannel }) : undefined}
      />
    </div>
  );
}
