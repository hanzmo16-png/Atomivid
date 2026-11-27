import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resourceSentinelResponse } from "@/lib/supply/sentinel-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await createClient();
  const { data: { user }, error } = await auth.auth.getUser();
  return resourceSentinelResponse(error ? null : user, { service: createServiceClient });
}
