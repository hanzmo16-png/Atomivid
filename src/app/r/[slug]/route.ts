import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/supabase/env";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { handleReviewRequest } from "@/lib/delivery/review-route";

// Short, app-controlled review link: /r/<slug>. Owner-only (same single-account gate as
// /dashboard/admin/p2b-veo), streams a private Storage object with Range support and the right
// Content-Type. No signed URL / JWT reaches the client, the service key never leaves the server,
// the bucket stays private, and nothing is logged. Logic and tests: src/lib/delivery/review-route.ts.
export const dynamic = "force-dynamic";

function deps() {
  return {
    getUser: async () => {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      return user ? { email: user.email, email_confirmed_at: user.email_confirmed_at } : null;
    },
    isOwner: (user: { email?: string; email_confirmed_at?: string }) => canPrepareAvatar(user),
    gateConfigured: () => Boolean(process.env.AVATAR_PREPARATION_OWNER_EMAIL?.trim()),
    fetch: (url: string, init: { headers: Record<string, string> }) => fetch(url, { ...init, cache: "no-store" }),
    supabaseUrl: getSupabaseUrl,
    serviceKey: getSupabaseServiceRoleKey,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handleReviewRequest(request, slug, deps());
}

export async function HEAD(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const res = await GET(request, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}
