import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/supabase/env";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { forwardableRange, passthroughStatus, resolveReviewObject, responseHeaders, upstreamRequest } from "@/lib/delivery/review-stream";

// Short, app-controlled review link: /r/<slug>. Owner-only (same single-account gate as
// /dashboard/admin/p2b-veo), streams a private Storage object with Range support and the right
// Content-Type. No signed URL / JWT reaches the client, the service key never leaves the server,
// the bucket stays private, and nothing is logged. See src/lib/delivery/review-stream.ts.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const obj = resolveReviewObject(slug);
  if (!obj) return new NextResponse("not found", { status: 404, headers: NO_STORE });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("redirectedFrom", `/r/${slug}`);
    return NextResponse.redirect(login, { status: 307 });
  }
  if (!canPrepareAvatar(user)) return new NextResponse("not found", { status: 404, headers: NO_STORE });

  const range = forwardableRange(request.headers.get("range"));
  const up = upstreamRequest(getSupabaseUrl(), getSupabaseServiceRoleKey(), obj, range);
  let upstream: Response;
  try {
    upstream = await fetch(up.url, { headers: up.headers, cache: "no-store" });
  } catch {
    return new NextResponse("review object unavailable", { status: 502, headers: NO_STORE });
  }
  const status = passthroughStatus(upstream.status);
  if (status === 502) return new NextResponse("review object unavailable", { status: 502, headers: NO_STORE });
  return new Response(status === 416 ? null : upstream.body, { status, headers: responseHeaders(upstream.headers, obj) });
}

export async function HEAD(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const res = await GET(request, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}
