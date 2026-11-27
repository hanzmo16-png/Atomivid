import { createServiceClient } from "@/lib/supabase/service";
import { qualityReadinessResponse } from "@/lib/supply/quality-readiness";
import { readResourceSentinel } from "@/lib/supply/sentinel-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return qualityReadinessResponse(request, { read: () => readResourceSentinel(createServiceClient()) });
}
