import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import { driveWebConfig, startDriveConnect, DriveConnectError, PENDING_COOKIE } from "@/lib/orchestrator/drive-web-connect";
import { PENDING_TTL_MS } from "@/lib/orchestrator/google-oauth";

// «Conectar Google Drive» (owner only): returns Google's consent URL and keeps the attempt (state + PKCE verifier)
// sealed in an httpOnly cookie scoped to the callback. Never cached: the URL binds one attempt.
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: noStore });
  if (!isCommandCenterAdmin(user)) return NextResponse.json({ error: "solo el propietario" }, { status: 403, headers: noStore });
  try {
    const r = startDriveConnect(driveWebConfig(process.env));
    const res = NextResponse.json({ url: r.url }, { headers: noStore });
    res.cookies.set(PENDING_COOKIE, r.cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/orchestrator/drive", maxAge: PENDING_TTL_MS / 1000 });
    return res;
  } catch (e) {
    // Configuration errors name the missing variable, never its value.
    return NextResponse.json({ error: e instanceof DriveConnectError ? e.message : "no se pudo iniciar la conexión" }, { status: 503, headers: noStore });
  }
}
