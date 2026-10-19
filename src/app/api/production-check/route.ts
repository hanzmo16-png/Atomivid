import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { checkProductionForRequest, checkResponseBody } from "@/lib/supply/production-check";
import { formProduction, type ScriptChoice } from "@/lib/video/form-production";
import { resolveMode } from "@/app/dashboard/new/validation";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";

export const dynamic = "force-dynamic";

/**
 * Checklist antes de generar (2026-10-18): the new-video form asks «¿puedo producir esto?» while it is being
 * filled. Read-only: it validates the form with the same function the server action enforces, runs the same
 * production check the paid endpoints run (plan, prices, processing, Atomicvid's provider balances and
 * limits) and NEVER creates a request, reserves, generates or calls a generative provider. A stale balance of
 * a provider THIS production needs may be refreshed with that provider's billing GET, as the start endpoints do.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });

  const flags = getFeatureFlags();
  const modeResult = resolveMode(String(body.mode ?? "visual"), flags.avatarModeEnabled || canPrepareAvatar(user));
  const mode = modeResult.ok ? modeResult.mode : "visual";
  const form = formProduction({
    mode,
    topic: String(body.topic ?? "").trim(),
    style: String(body.style ?? "").trim(),
    durationSeconds: Number(body.durationSeconds),
    language: String(body.language ?? "es"),
    scriptChoice: String(body.scriptChoice ?? "generated") as ScriptChoice,
    ownText: String(body.ownText ?? ""),
    adaptAccepted: body.adaptAccepted === true,
    avatarNarrationSource: String(body.avatarNarrationSource ?? "tts"),
    maxAvatarSeconds: flags.maxAvatarDurationSeconds,
  });
  const inputError = !modeResult.ok ? modeResult.error : mode === "avatar" && !canPrepareAvatar(user) ? "Esta prueba privada no está disponible para tu cuenta." : form.inputError;
  const check = await checkProductionForRequest({ service: createServiceClient(), user, ownerId: user.id, stage: form.stage, request: form.request,
    inputError, fit: form.fit });
  return NextResponse.json({ ...checkResponseBody(check), stage: form.stage, fit: form.fit,
    stats: form.stats && { chars: form.stats.chars, words: form.stats.words, estimate: form.stats.estimate } },
  { headers: { "Cache-Control": "no-store" } });
}
