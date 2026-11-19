import { NextResponse } from "next/server";

/** Solo JSON: un formulario de otro sitio (text/plain, sin preflight) no puede disparar acciones. */
const notJson = (r: Request) => !(r.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
const NOT_JSON = () => NextResponse.json({ error: "Se esperaba JSON." }, { status: 415 });
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { createProject, readLibrary } from "@/lib/audio-studio/service";

export const dynamic = "force-dynamic";

/** Biblioteca de audio de la cuenta (solo sus proyectos). */
export async function GET() {
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const out = await readLibrary(studioDeps(user), user.id, { owner: user.owner });
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}

/** Nuevo episodio: { title, voiceCount: 1 | 2 }. No llama a ningún proveedor. */
export async function POST(request: Request) {
  if (notJson(request)) return NOT_JSON();
  const user = await audioStudioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const out = await createProject(studioDeps(user), user.id, await request.json().catch(() => null));
  return NextResponse.json(out.body, { status: out.status });
}
