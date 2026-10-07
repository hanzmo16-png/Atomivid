import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { CommandCenterService, isSection } from "@/lib/command-center/service";
import { supabaseSource } from "@/lib/command-center/sources";
import { CommandCenterAccessError } from "@/lib/command-center/access";
import { isWindowKey } from "@/lib/command-center/windows";
import { supabaseTelemetrySource } from "@/lib/business-telemetry/command-center";

// OWNER/ADMIN only, read-only, never cached: global metrics, provider capacity and other
// users' production must never reach a normal user or a shared cache.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const q = new URL(request.url).searchParams;
  const section = q.get("section") ?? "overview", window = q.get("window") ?? "7D";
  if (!isSection(section) || !isWindowKey(window)) return NextResponse.json({ error: "invalid section or window" }, { status: 400, headers: NO_STORE });
  try {
    const sb = createServiceClient();
    const service = new CommandCenterService({ source: supabaseSource(sb), telemetry: supabaseTelemetrySource(sb), now: () => new Date().toISOString() });
    return NextResponse.json(await service.section(user, section, window), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof CommandCenterAccessError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: "command center unavailable" }, { status: 503, headers: NO_STORE });
  }
}
