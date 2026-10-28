import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { reopenLongFormAfterMaterialGap } from "@/lib/video/long-form/reconfigure-production";
import { generateDiagnosticId, logRenderError } from "@/lib/video/render-error";

/**
 * «Volver a configurar» (Long Form detenido por falta de material, USD 0): solo el dueño. Devuelve el pedido a
 * Configurar con su guion; las condiciones y el compare-and-swap están en reconfigure-production.ts. No cobra nada.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (!canAccessLongFormBeta(user)) return NextResponse.json({ error: "Long Form no está disponible para tu cuenta." }, { status: 403 });
  try {
    const result = await reopenLongFormAfterMaterialGap(createServiceClient(), { requestId: id, userId: user.id });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ reopened: true, alreadyReopened: result.alreadyReopened, configurePath: `/dashboard/long-form/configure/${id}` });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /reconfigure", error, diagnosticId);
    return NextResponse.json({ error: `No se pudo volver a configurar el documental. No se cambió nada. (Código: ${diagnosticId})` }, { status: 500 });
  }
}
