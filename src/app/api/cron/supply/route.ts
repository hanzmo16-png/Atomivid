import { authorizedSupplyCron } from "@/lib/supply/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { monitorSupply } from "@/lib/supply/monitor";
import { resumeSupplyQueue } from "@/lib/supply/queue";
import { getRenderWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request: Request) {
  if (!authorizedSupplyCron(request.headers.get("authorization"), process.env.CRON_SECRET))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const service = createServiceClient();
    const result = await monitorSupply(service);
    // Disabled until live account configuration / worker deployment are verified together.
    const resumed = process.env.SUPPLY_RESUME_ENABLED === "true"
      ? await resumeSupplyQueue(service, input => getRenderWorker().trigger(input)) : 0;
    // Counts only: detailed supply data stays in the service-only store / admin panel.
    return Response.json({ ok: true, providers: result.states.length, pendingAlerts: result.pendingAlerts, resumed });
  } catch {
    console.error("[atomivid:supply] monitor incomplete; no payment or generation requested");
    return Response.json({ error: "Supply monitor incomplete" }, { status: 503 });
  }
}
