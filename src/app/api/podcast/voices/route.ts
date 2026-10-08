import { NextResponse } from "next/server";
import { podcastUser } from "@/lib/podcast/auth";
import { listAccountVoices, VoicesUnavailableError } from "@/lib/podcast/voices";

/** Voices actually available to the account (read-only, free). */
export async function GET() {
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  try {
    return NextResponse.json({ voices: await listAccountVoices() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof VoicesUnavailableError ? e.customerMessage : "No se pudieron consultar las voces." }, { status: 503 });
  }
}
