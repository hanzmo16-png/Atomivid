import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { assertLongFormAccess, LongFormDisabledError, LongFormNotAllowlistedError } from "@/lib/video/long-form/access";
import {
  runVisualTestV2RealGeneration,
  VisualTestV2UncertainCostStateError,
  VISUAL_TEST_V2_REAL_CONFIRM_VALUE,
} from "@/lib/video/long-form/visual-test-v2-real";
import { VideoCostGuardExceededError } from "@/lib/video/long-form/video-cost-guard";
import { GenerativeProviderError } from "@/lib/providers/types";

// Generación REAL controlada de EXACTAMENTE 3 imágenes (Visual Test V2) —
// autorizada explícitamente por el usuario para este checkpoint. El
// DRY_RUN (/api/long-form/visual-test-v2) queda intacto y sigue siendo un
// endpoint completamente separado. Toda la lógica vive en
// visual-test-v2-real.ts (auth reutilizada de access.ts, manifest/cost
// guard/idempotencia reutilizados sin duplicar) — esta ruta solo hace de
// adaptador: auth, valida el body estricto, delega, mapea errores a un
// status HTTP seguro.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  try {
    assertLongFormAccess(user);
  } catch (error) {
    if (error instanceof LongFormDisabledError || error instanceof LongFormNotAllowlistedError) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }
    throw error;
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const isPlainObject = typeof rawBody === "object" && rawBody !== null;
  const keys = isPlainObject ? Object.keys(rawBody as Record<string, unknown>) : [];
  const confirm = isPlainObject ? (rawBody as Record<string, unknown>).confirm : undefined;

  // Body estricto: SOLO { "confirm": "<valor exacto>" } — nada más. Ni prompts, ni cantidades, ni un `mode` alternativo.
  if (keys.length !== 1 || keys[0] !== "confirm" || confirm !== VISUAL_TEST_V2_REAL_CONFIRM_VALUE) {
    return NextResponse.json(
      { error: "Body inválido: se requiere exactamente el valor de confirmación esperado." },
      { status: 400 },
    );
  }

  try {
    const result = await runVisualTestV2RealGeneration(createServiceClient());
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof VisualTestV2UncertainCostStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof VideoCostGuardExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    if (error instanceof GenerativeProviderError) {
      // Nunca se devuelve el cuerpo/prompt original del error del proveedor al cliente.
      return NextResponse.json({ error: `Error del proveedor de imágenes (${error.reason}).` }, { status: 502 });
    }
    console.error("[atomivid:long-form] POST /api/long-form/visual-test-v2/real — error inesperado", error);
    return NextResponse.json(
      { error: "No se pudo completar la generación. Intenta de nuevo en un momento." },
      { status: 500 },
    );
  }
}
