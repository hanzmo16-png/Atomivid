import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/supabase/env";
import { CommandCenterAccessError, requireCommandCenterAdmin } from "@/lib/command-center/access";
import { defaultCatalog, LIVE_MISSIONS } from "@/lib/mystery-shopper/catalog";
import { jobStore, MS_BUCKET, newJobId, type StorageApi } from "@/lib/mystery-shopper/jobs";
import { githubDispatcher, startEvaluation, StartError, APPROVED_REAL_BUDGET_USD } from "@/lib/mystery-shopper/start";
import { recordedJourneys } from "@/lib/mystery-shopper/recorded";
import type { LiveReport } from "@/lib/mystery-shopper/live";

// Mismo cerrojo que el Command Center. Sin caché: el informe no debe compartirse.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

/** Historial durable: bucket privado existente, prefijo propio (sin /tmp, sin migraciones). */
function store() {
  const client = createSupabaseClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  return jobStore(client.storage.from(MS_BUCKET) as unknown as StorageApi);
}

async function gate(): Promise<{ denied: Response } | { email: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    requireCommandCenterAdmin(user);
    return { email: user?.email ?? "admin" };
  } catch (e) {
    if (e instanceof CommandCenterAccessError) return { denied: NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE }) };
    return { denied: NextResponse.json({ error: "command center unavailable" }, { status: 503, headers: NO_STORE }) };
  }
}

export async function GET(request: Request) {
  const g = await gate();
  if ("denied" in g) return g.denied;
  const s = store();
  const id = new URL(request.url).searchParams.get("id");
  try {
    if (id) {
      const view = await s.get(id);
      if (!view) return NextResponse.json({ error: "No existe esa evaluación." }, { status: 404, headers: NO_STORE });
      const report = view.hasReport ? await s.getReport<LiveReport>(id) : null;
      const files = await s.evidence(id).catch(() => []);
      const evidence = await Promise.all(files.map(async (name) => ({ name, url: await s.evidenceUrl(id, name).catch(() => null) })));
      return NextResponse.json({ view, report, evidence }, { headers: NO_STORE });
    }
    const jobs = await s.list(50);
    return NextResponse.json({
      jobs,
      missions: LIVE_MISSIONS.map((m) => ({ id: m.id, product: m.product, title: m.title, instructions: m.instructions, criteria: m.criteria ?? [], auto: !!m.auto })),
      approvedRealBudgetUsd: APPROVED_REAL_BUDGET_USD,
      target: process.env.MYSTERY_SHOPPER_TARGET_URL || "https://atomivid.vercel.app",
      // Pruebas de infraestructura del arnés (FIXTURE). Nunca se presentan como evaluación de ATOMIVID.
      infraFixtures: recordedJourneys().map((j) => ({ missionId: j.missionId, scope: j.scope, sha: j.sha })),
    }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo leer el historial." }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ("denied" in g) return g.denied;
  const body = await request.json().catch(() => ({})) as { id?: string; missionId?: string; profile?: string; mode?: string; target?: string; maxBudgetUsd?: number };
  try {
    const id = body.id || newJobId(new Date(), () => randomBytes(6).toString("hex"));
    const r = await startEvaluation({
      id, missionId: String(body.missionId ?? ""), profile: String(body.profile ?? "principiante"), mode: body.mode, target: body.target, maxBudgetUsd: body.maxBudgetUsd,
      source: "panel", requestedBy: "command-center", requestedSha: process.env.VERCEL_GIT_COMMIT_SHA || "desconocido",
    }, { store: store(), catalog: defaultCatalog(), dispatch: githubDispatcher(process.env), now: () => new Date(), env: process.env });
    return NextResponse.json({ view: r.view, created: r.created, dispatched: r.dispatched, message: r.message }, { status: r.http, headers: NO_STORE });
  } catch (e) {
    if (e instanceof StartError) return NextResponse.json({ error: e.message }, { status: e.http, headers: NO_STORE });
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo iniciar." }, { status: 503, headers: NO_STORE });
  }
}
