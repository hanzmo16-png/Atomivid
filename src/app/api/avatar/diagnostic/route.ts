import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
export const dynamic = "force-dynamic";
export async function GET() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!canPrepareAvatar(user) || !user) return new Response(null,{status:404});
  const { data: rows, error } = await db.from("video_requests").select("id").eq("user_id",user.id).eq("mode","avatar");
  if (error) return new Response(null,{status:503});
  const row = rows?.find(r=>createHash("sha256").update(r.id).digest("hex")==="24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5");
  if (!row) return new Response(null,{status:404});
  const {data,error: readError} = await createServiceClient().storage.from("avatar-uploads")
    .download(user.id+"/"+row.id+"/direct-diagnostic-20260919.json");
  if (readError || !data) return new Response("Diagnóstico todavía no disponible.",{status:404});
  return new Response(await data.arrayBuffer(),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"private, no-store","X-Robots-Tag":"noindex, nofollow","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
}
