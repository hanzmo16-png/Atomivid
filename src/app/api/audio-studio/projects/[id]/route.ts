import { NextResponse } from "next/server";

/** Solo JSON: un formulario de otro sitio (text/plain, sin preflight) no puede disparar acciones. */
const notJson = (r: Request) => !(r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
const NOT_JSON = () => NextResponse.json({ error: "Se esperaba JSON." }, { status: 415 });
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { getProject, markReady, requestGeneration, requestRemix, resumeGeneration, saveProject, setArchived, switchToFallbackModel } from "@/lib/audio-studio/service";
import { startWorker } from "@/lib/audio-studio/worker";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const MAX_BODY = 200_000;

async function body(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return { __tooLarge: true };
  try { return JSON.parse(text); } catch { return null; }
}

export async function GET(_request: Request, { params }: Ctx) {
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const out = await getProject(studioDeps(), user.id, (await params).id);
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}

/** Guardar cambios: { revision, title?, voiceCount?, voices?, targetMinutes?, script?, notes?, music?, budgetUsd? }. */
export async function PUT(request: Request, { params }: Ctx) {
  if (notJson(request)) return NOT_JSON();
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const b = await body(request);
  if (b && typeof b === "object" && "__tooLarge" in b) return NextResponse.json({ error: "El proyecto es demasiado grande." }, { status: 413 });
  const out = await saveProject(studioDeps(), user.id, (await params).id, b);
  return NextResponse.json(out.body, { status: out.status });
}

/**
 * Acciones: { action, revision?, confirmUsd? }.
 *  archivar | restaurar | listo — sin costo.
 *  generar  — exige confirmUsd = costo estimado exacto; sin proveedor de voz habilitado responde 409 sin cargo.
 *  remezclar — solo voz en caché (costo 0). reanudar — tras fallo o interrupción, misma autorización.
 *  respaldo — cambia explícitamente a Multilingual v2 (sin generar; hay que volver a autorizar).
 */
export async function POST(request: Request, { params }: Ctx) {
  if (notJson(request)) return NOT_JSON();
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const { id } = await params;
  const b = (await body(request)) as { action?: unknown; revision?: unknown; confirmUsd?: unknown } | null;
  const d = studioDeps();
  const out =
    b?.action === "archivar" ? await setArchived(d, user.id, id, true)
    : b?.action === "restaurar" ? await setArchived(d, user.id, id, false)
    : b?.action === "listo" ? await markReady(d, user.id, id, b.revision)
    : b?.action === "generar" ? await requestGeneration(d, user.id, id, b)
    : b?.action === "remezclar" ? await requestRemix(d, user.id, id, b)
    : b?.action === "reanudar" ? await resumeGeneration(d, user.id, id)
    : b?.action === "respaldo" ? await switchToFallbackModel(d, user.id, id, b.revision)
    : { ok: false, status: 400, body: { error: "Acción desconocida." } };
  if (out.ok && out.status === 202) await startWorker(d.store, d.voice, user.id, id);
  return NextResponse.json(out.body, { status: out.status });
}
