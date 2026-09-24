import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { evaluateVisualTestV2Request } from "@/lib/video/long-form/visual-test-v2-runtime";

// Endpoint interno/beta (Long Form) — DRY_RUN/PREFLIGHT únicamente en este
// checkpoint. No existe ningún código de generación real aquí ni en
// visual-test-v2-runtime.ts: ver VISUAL_TEST_V2_REAL_MODE_LOCKED. Nunca
// cachear una respuesta que refleje autorización/estado de gasto de un
// usuario.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Un body ausente/no-JSON se trata igual que cualquier otro body
  // inválido — evaluateVisualTestV2Request ya lo rechaza con un mensaje
  // seguro, sin necesidad de una rama aparte aquí.
  const rawBody: unknown = await request.json().catch(() => null);

  const result = evaluateVisualTestV2Request(user, rawBody);

  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
