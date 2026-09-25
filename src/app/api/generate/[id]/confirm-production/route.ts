import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isLongFormScriptJson } from "@/lib/video/long-form/produce";
import {
  computeProductionPlan,
  isProductionPlan,
  REAL_LONG_FORM_PROVIDER_NAMES,
  VISUAL_STRATEGIES,
  type VisualStrategy,
  type ProductionPlan,
} from "@/lib/video/long-form/production-plan";
import { generateDiagnosticId, logRenderError } from "@/lib/video/render-error";

/**
 * RC mission "LONG FORM RC FINAL HARDENING" — paso 9/10 del nuevo
 * contrato de Long Form (ver production-plan.ts): esta ruta es la ÚNICA
 * forma de fijar `long_form_confirmed_at` — render/route.ts exige esa
 * columna para mode="long_form" antes de arrancar la producción paga (ver
 * el gate añadido ahí). Deliberadamente NO dispara el render — el cliente
 * (ConfigureProduction.tsx) llama a esta ruta y, solo si responde 200,
 * llama después a /render — así "Confirmar y generar video" sigue siendo
 * el único botón capaz de iniciar ambos pasos, pero cada paso conserva su
 * propia guarda atómica independiente.
 */
function isVisualStrategyValue(value: unknown): value is VisualStrategy {
  return typeof value === "string" && (VISUAL_STRATEGIES as readonly string[]).includes(value);
}

type VideoRequestRow = {
  id: string;
  mode: string;
  user_id: string;
  status: string;
  script_json: unknown;
  long_form_production_plan: ProductionPlan | null;
  long_form_confirmed_at: string | null;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo de la solicitud inválido" }, { status: 400 });
  }
  const strategy = (body as { strategy?: unknown })?.strategy;
  if (!isVisualStrategyValue(strategy)) {
    return NextResponse.json({ error: "Estrategia visual inválida" }, { status: 400 });
  }

  try {
    const service = createServiceClient();
    const { data, error: fetchError } = await service
      .from("video_requests")
      .select("id, mode, user_id, status, script_json, long_form_production_plan, long_form_confirmed_at")
      .eq("id", id)
      .single<VideoRequestRow>();

    if (fetchError || !data) {
      return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
    }
    if (data.user_id !== user.id) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }
    if (data.mode !== "long_form") {
      return NextResponse.json({ error: "Esta solicitud no es de Long Form" }, { status: 409 });
    }

    // Idempotencia (doble click, reintento tras un refresh a medio
    // camino): si ya hay una confirmación persistida, se devuelve tal
    // cual en vez de fallar — nunca se sobreescribe un plan ya confirmado
    // ni se crea una segunda "confirmación" para la misma solicitud.
    if (data.long_form_confirmed_at && isProductionPlan(data.long_form_production_plan)) {
      return NextResponse.json({
        plan: data.long_form_production_plan,
        confirmedAt: data.long_form_confirmed_at,
      });
    }

    if (data.status !== "script_ready") {
      return NextResponse.json(
        { error: "Esta solicitud ya no está lista para confirmar producción." },
        { status: 409 },
      );
    }
    if (!isLongFormScriptJson(data.script_json)) {
      return NextResponse.json(
        { error: "El guion guardado no tiene la forma esperada para Long Form." },
        { status: 409 },
      );
    }

    // El plan SIEMPRE se recalcula server-side a partir del guion real ya
    // guardado — nunca se confía en un plan que el cliente pudiera enviar
    // (ver sección 16 de la misión, "server-side cost guard").
    const plan = computeProductionPlan({
      beats: data.script_json.beats.map((b) => ({ id: b.id, type: b.type, narration: b.narration })),
      strategy,
      providers: REAL_LONG_FORM_PROVIDER_NAMES,
    });

    const confirmedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await service
      .from("video_requests")
      .update({ long_form_production_plan: plan, long_form_confirmed_at: confirmedAt })
      .eq("id", id)
      .eq("user_id", user.id)
      .eq("status", "script_ready")
      .is("long_form_confirmed_at", null)
      .select("long_form_production_plan, long_form_confirmed_at")
      .maybeSingle();

    if (updateError) {
      const diagnosticId = generateDiagnosticId();
      logRenderError("POST /confirm-production", updateError, diagnosticId);
      return NextResponse.json(
        { error: `No se pudo confirmar el plan de producción. (Código: ${diagnosticId})` },
        { status: 500 },
      );
    }

    if (!updated) {
      // Otra request ganó la carrera (doble clic) justo entre el fetch de
      // arriba y este UPDATE — se relee para devolver esa confirmación en
      // vez de un error, mismo principio de idempotencia que arriba.
      const { data: raceWinner } = await service
        .from("video_requests")
        .select("long_form_production_plan, long_form_confirmed_at")
        .eq("id", id)
        .maybeSingle<{ long_form_production_plan: ProductionPlan | null; long_form_confirmed_at: string | null }>();
      if (raceWinner?.long_form_confirmed_at && isProductionPlan(raceWinner.long_form_production_plan)) {
        return NextResponse.json({
          plan: raceWinner.long_form_production_plan,
          confirmedAt: raceWinner.long_form_confirmed_at,
        });
      }
      return NextResponse.json(
        { error: "El estado cambió justo antes de confirmar. Intenta de nuevo." },
        { status: 409 },
      );
    }

    return NextResponse.json({ plan: updated.long_form_production_plan, confirmedAt: updated.long_form_confirmed_at });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /confirm-production (inesperado)", error, diagnosticId);
    return NextResponse.json(
      { error: `No se pudo confirmar el plan de producción. (Código: ${diagnosticId})` },
      { status: 500 },
    );
  }
}
