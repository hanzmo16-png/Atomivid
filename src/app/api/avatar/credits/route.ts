import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { readDidCredits } from "@/lib/providers/avatar/credits";

export const dynamic = "force-dynamic";
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) return new Response(null, { status: 404 });
  return Response.json(await readDidCredits(process.env.DID_API_KEY), {
    headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" },
  });
}
