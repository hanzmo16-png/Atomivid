import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { confirmLongFormProduction } from "@/lib/video/long-form/confirm-production";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { cinematicV6Enabled } from "@/lib/video/long-form/cinematic-v6-access";
import { generateDiagnosticId, logRenderError } from "@/lib/video/render-error";
import { recraftAllowedFor } from "@/lib/video/recraft-access";
import { randomUUID } from "node:crypto";
import { parseRecraftSelection, type ReelRecraftStyle } from "@/lib/video/recraft-reel";
import { storeRecraftReferences } from "@/lib/video/recraft-reel-server";

/**
 * Paso 9/10 del contrato de Long Form: fija el plan confirmado (ver
 * confirm-production.ts). Deliberadamente NO dispara el render — el
 * cliente llama a /render solo si esto responde 200, y cada paso conserva
 * su propia guarda atómica.
 *
 * Cuerpo JSON {strategy, packaging?} como siempre, o multipart (FormData) cuando el creador elige «Imágenes IA con
 * Recraft»: strategy, packaging (JSON), image_source, recraft_style_id, recraft_style_match, recraft_style_note y
 * recraft_style_refs (archivos). Nada se envía a fal.ai ni se cobra aquí.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (!canAccessLongFormBeta(user)) return NextResponse.json({ error: "Long Form no está disponible para tu cuenta." }, { status: 403 });

  let strategy: unknown, packaging: unknown, form: FormData | null = null;
  try {
    if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      form = await request.formData();
      strategy = form.get("strategy");
      const rawPackaging = form.get("packaging");
      packaging = typeof rawPackaging === "string" && rawPackaging.trim() ? JSON.parse(rawPackaging) : undefined;
    } else {
      const body = (await request.json()) as { strategy?: unknown; packaging?: unknown } | null;
      strategy = body?.strategy;
      packaging = body?.packaging;
    }
  } catch {
    return NextResponse.json({ error: "Cuerpo de la solicitud inválido" }, { status: 400 });
  }

  try {
    const service = createServiceClient();
    let recraft: ReelRecraftStyle | undefined;
    if (form && String(form.get("image_source") ?? "default") !== "default") {
      const refs = form.getAll("recraft_style_refs").filter((f): f is File => typeof f !== "string" && f.size > 0);
      const choice = parseRecraftSelection({ source: form.get("image_source"), styleId: form.get("recraft_style_id"), match: form.get("recraft_style_match"),
        styleNote: form.get("recraft_style_note"), referenceCount: refs.length }, recraftAllowedFor(user));
      if ("error" in choice) return NextResponse.json({ error: choice.error }, { status: 400 });
      if (choice.source === "recraft") {
        // Ownership, mode and state BEFORE writing anything into this request's folder (the confirmation re-checks all).
        const { data: row } = await service.from("video_requests").select("user_id, mode, status, long_form_confirmed_at").eq("id", id)
          .maybeSingle<{ user_id: string; mode: string; status: string; long_form_confirmed_at: string | null }>();
        if (!row) return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
        if (row.user_id !== user.id) return NextResponse.json({ error: "No autorizado" }, { status: 403 });
        if (row.mode !== "long_form") return NextResponse.json({ error: "Esta solicitud no es de Long Form" }, { status: 409 });
        let referencePaths: string[] = [];
        // Already confirmed: the stored choice wins (idempotent) and nothing is uploaded. Otherwise each confirmation
        // writes to its own folder, so two tabs never overwrite each other's references (the winner keeps its own).
        if (!row.long_form_confirmed_at && row.status === "script_ready" && !choice.styleId) {
          const stored = await storeRecraftReferences(service, `${id}/recraft-style/lf-${randomUUID()}`, refs);
          if ("error" in stored) return NextResponse.json({ error: stored.error.replace("No se ha creado ni cobrado nada.", "No se confirmó ni cobró nada.") }, { status: 400 });
          referencePaths = stored.paths;
        }
        recraft = { styleId: choice.styleId, referencePaths, match: choice.match, styleNote: choice.styleNote };
      }
    }
    const result = await confirmLongFormProduction(createServiceClient(), {
      requestId: id,
      userId: user.id,
      strategy,
      packaging,
      cinematicV6: cinematicV6Enabled(user),
      ...(recraft ? { recraft } : {}),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: result.plan, confirmedAt: result.confirmedAt, alreadyConfirmed: result.alreadyConfirmed });
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logRenderError("POST /confirm-production", error, diagnosticId);
    return NextResponse.json({ error: `No se pudo confirmar el plan de producción. (Código: ${diagnosticId})` }, { status: 500 });
  }
}
