import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { createEpisode } from "@/lib/podcast/server";

/** Creates a draft (no paid call): validates the script and the voice against the account's voices. */
export async function POST(request: Request) {
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Cuerpo de la solicitud inválido" }, { status: 400 });
  const out = await createEpisode(createServiceClient(), user.id, { title: body.title, script: body.script, language: body.language, voiceId: body.voiceId, source: body.source === "upload" ? "upload" : "tts" });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
}
