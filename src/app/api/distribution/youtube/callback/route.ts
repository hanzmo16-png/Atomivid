import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { completeConnect } from "@/lib/distribution/youtube/connect-flow";
import { supabaseYouTubeOAuthStore } from "@/lib/distribution/youtube/oauth-store";

// Google redirects here with ?code&state. The code is exchanged server side; the refresh
// token is encrypted before storage and no token ever appears in this response.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const noStore = { "Cache-Control": "private, no-store" };
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: noStore });
  const q = new URL(request.url).searchParams;
  const code = q.get("code"), state = q.get("state");
  if (!code || !state || q.get("error")) return NextResponse.json({ error: "consent not granted" }, { status: 400, headers: noStore });
  try {
    const r = await completeConnect(
      { store: supabaseYouTubeOAuthStore(createServiceClient()), env: process.env, fetch: fetch as never, now: new Date().toISOString() },
      user.id, code, state, { language: process.env.YOUTUBE_CHANNEL_LANGUAGE ?? "en", niche: process.env.YOUTUBE_CHANNEL_NICHE ?? "", timezone: process.env.YOUTUBE_CHANNEL_TIMEZONE ?? "UTC" },
    );
    return NextResponse.json({ connected: r.channel, scopes: r.scopes }, { headers: noStore });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "connection failed" }, { status: 400, headers: noStore });
  }
}
