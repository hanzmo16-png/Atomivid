import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { isLongFormScriptJson } from "@/lib/video/long-form/produce";
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
 * RC mission "LONG FORM RC FINAL HARDENING" — paso 6-9 del nuevo
 * contrato (ver production-plan.ts): antes de esta pantalla, "Generar
 * video" en RequestCard.tsx disparaba producción paga directo desde
 * script_ready sin que el usuario eligiera estrategia visual ni viera
 * costo/mezcla de assets. Los 3 planes se calculan aquí, en el servidor,
 * de forma pura (computeProductionPlan no hace red ni gasta un centavo)
 * — el cliente solo elige cuál mostrar, nunca recalcula nada.
 */
export default async function ConfigureLongFormProductionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  // Ya confirmado antes (refresh, back del navegador, doble pestaña): la
  // producción ya arrancó o está en curso — esta pantalla no tiene nada
  // más que ofrecer, Historial es la fuente de verdad del progreso real.
  if (data.long_form_confirmed_at) redirect(`/dashboard/videos/${id}`);
  if (data.status !== "script_ready" || !isLongFormScriptJson(data.script_json)) {
    redirect("/dashboard");
  }

  const beats = data.script_json.beats.map((b) => ({ id: b.id, type: b.type, narration: b.narration }));
  const plans = Object.fromEntries(
    VISUAL_STRATEGIES.map((strategy) => [
      strategy,
      computeProductionPlan({ beats, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES }),
    ]),
  ) as Record<VisualStrategy, ProductionPlan>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Configurar producción</h1>
      <p className="mt-1 text-sm text-ink-muted">{data.topic}</p>
      <ConfigureProduction requestId={id} plans={plans} />
    </div>
  );
}
