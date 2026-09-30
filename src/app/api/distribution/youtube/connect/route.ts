import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { startConnect } from "@/lib/distribution/youtube/connect-flow";
import { supabaseYouTubeOAuthStore } from "@/lib/distribution/youtube/oauth-store";

// READ-ONLY YouTube connection (youtube.readonly + yt-analytics.readonly). No upload,
// schedule or publish scope is ever requested here. Never cache: the URL binds one user.
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  try {
    const r = await startConnect({ store: supabaseYouTubeOAuthStore(createServiceClient()), env: process.env, now: new Date().toISOString() }, user.id);
    return NextResponse.json({ url: r.url, connectionId: r.connectionId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    // Configuration errors name the missing variable, never its value.
    return NextResponse.json({ error: e instanceof Error ? e.message : "connect failed" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
