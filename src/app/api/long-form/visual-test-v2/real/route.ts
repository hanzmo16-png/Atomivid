import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runVisualTestV2RealGeneration, VisualTestV2UncertainCostStateError } from "@/lib/video/long-form/visual-test-v2-real";
import {
  evaluateVisualTestV2RealRequest,
  VisualTestV2SpendAuthorizationError,
} from "@/lib/video/long-form/visual-test-v2-spend-auth";
import { VideoCostGuardExceededError } from "@/lib/video/long-form/video-cost-guard";
import { GenerativeProviderError } from "@/lib/providers/types";

// Generación REAL controlada de EXACTAMENTE 3 imágenes (Visual Test V2).
// El DRY_RUN (/api/long-form/visual-test-v2) queda intacto y es otro
// endpoint. Esta ruta solo adapta HTTP: la decisión (admin + token de
// gasto) vive en evaluateVisualTestV2RealRequest y se revalida dentro de
// runVisualTestV2RealGeneration antes de tocar al proveedor.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const rawBody: unknown = await request.json().catch(() => null);
  const decision = evaluateVisualTestV2RealRequest(user, rawBody);
  if (!decision.ok) {
    return NextResponse.json(decision.body, { status: decision.status, headers: NO_STORE });
  }

  try {
    const result = await runVisualTestV2RealGeneration(createServiceClient(), decision.authorization);
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof VisualTestV2SpendAuthorizationError) {
      return NextResponse.json({ error: "Autorización de gasto inválida o ausente." }, { status: 403, headers: NO_STORE });
    }
    if (error instanceof VisualTestV2UncertainCostStateError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof VideoCostGuardExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402, headers: NO_STORE });
    }
    if (error instanceof GenerativeProviderError) {
      return NextResponse.json({ error: `Error del proveedor de imágenes (${error.reason}).` }, { status: 502, headers: NO_STORE });
    }
    console.error("[atomivid:long-form] POST /api/long-form/visual-test-v2/real — error inesperado", error);
    return NextResponse.json(
      { error: "No se pudo completar la generación. Intenta de nuevo en un momento." },
      { status: 500, headers: NO_STORE },
    );
  }
}
