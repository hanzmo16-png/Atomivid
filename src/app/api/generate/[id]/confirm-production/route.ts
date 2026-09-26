import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { confirmLongFormProduction } from "@/lib/video/long-form/confirm-production";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { generateDiagnosticId, logRenderError } from "@/lib/video/render-error";

/**
 * Paso 9/10 del contrato de Long Form: fija el plan confirmado (ver
 * confirm-production.ts). Deliberadamente NO dispara el render — el
 * cliente llama a /render solo si esto responde 200, y cada paso conserva
 * su propia guarda atómica.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (!canAccessLongFormBeta(user)) return NextResponse.json({ error: "Long Form no está disponible para tu cuenta." }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo de la solicitud inválido" }, { status: 400 });
  }

  try {
    const result = await confirmLongFormProduction(createServiceClient(), {
      requestId: id,
      userId: user.id,
      strategy: (body as { strategy?: unknown } | null)?.strategy,
      packaging: (body as { packaging?: unknown } | null)?.packaging,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: result.plan, confirmedAt: result.confirmedAt, alreadyConfirmed: result.alreadyConfirmed });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /confirm-production", error, diagnosticId);
    return NextResponse.json({ error: `No se pudo confirmar el plan de producción. (Código: ${diagnosticId})` }, { status: 500 });
  }
}
