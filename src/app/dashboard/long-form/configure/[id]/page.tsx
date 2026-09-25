import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { isLongFormScriptJson } from "@/lib/video/long-form/script-json";
import {
  computeProductionPlan,
  REAL_LONG_FORM_PROVIDER_NAMES,
  VISUAL_STRATEGIES,
  type ProductionPlan,
  type VisualStrategy,
} from "@/lib/video/long-form/production-plan";
import { ConfigureProduction } from "./ConfigureProduction";

type VideoRequestRow = {
  id: string;
  mode: string;
  topic: string;
  status: string;
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
    .select("id, mode, topic, status, script_json, long_form_confirmed_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<VideoRequestRow>();

  if (!data || data.mode !== "long_form") notFound();
  if (data.long_form_confirmed_at) redirect(`/dashboard/videos/${id}`);
  if (data.status !== "script_ready" || !isLongFormScriptJson(data.script_json)) redirect("/dashboard");

  const script = data.script_json;
  const beats = script.beats.map((b) => ({ id: b.id, type: b.type, narration: b.narration, visuals: b.visuals }));
  const plans = Object.fromEntries(
    VISUAL_STRATEGIES.map((strategy) => [
      strategy,
      computeProductionPlan({ beats, topic: script.topic || data.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES }),
    ]),
  ) as Record<VisualStrategy, ProductionPlan>;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Configurar producción</h1>
      <p className="mt-1 break-words text-sm text-ink-muted">{data.topic}</p>

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

      <ConfigureProduction requestId={id} plans={plans} />
    </div>
  );
}
