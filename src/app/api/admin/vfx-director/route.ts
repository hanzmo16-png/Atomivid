import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { directorActor } from "@/lib/production-intelligence/vfx-director/access";
import { supabaseJobStore } from "@/lib/production-intelligence/vfx-director/store";
import { ownedJob, approveStage, replacePlan } from "@/lib/production-intelligence/vfx-director/jobs";
import { STAGES } from "@/lib/production-intelligence/vfx-director/gates";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), id: z.string().min(1), stage: z.enum(STAGES), planHash: z.string().min(1), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), approved: z.boolean(), checks: z.array(z.object({ name: z.string(), pass: z.boolean(), evidence: z.string() }).strict()) }).strict(),
  z.object({ action: z.literal("replace-plan"), id: z.string().min(1), plan: z.unknown() }).strict(),
]);
async function context() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  const actor = directorActor(user);
  return { actor, store: supabaseJobStore(createServiceClient()) };
}
function failure(error: unknown) {
  const forbidden = error instanceof Error && error.message === "VFX_OWNER_ONLY";
  return NextResponse.json({ error: forbidden ? "access denied" : "VFX operation blocked" }, { status: forbidden ? 403 : 409, headers });
}
export async function GET(request: Request) {
  try { const { actor, store } = await context(); const id = new URL(request.url).searchParams.get("id") ?? "";
    return NextResponse.json(await ownedJob(store, id, actor), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  // Reject cross-origin cookie-authenticated mutation before reading the body.
  if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "origin denied" }, { status: 403, headers });
  try { const { actor, store } = await context(); const body = await request.text();
    if (Buffer.byteLength(body) > 100_000) return NextResponse.json({ error: "too large" }, { status: 413, headers });
    const input = Action.parse(JSON.parse(body));
    const job = input.action === "approve" ? await approveStage(store, input.id, actor, input) : await replacePlan(store, input.id, actor, input.plan);
    return NextResponse.json(job, { headers });
  } catch (error) { return failure(error); }
}
