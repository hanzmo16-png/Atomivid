import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase/server";
import { CommandCenterAccessError, requireCommandCenterAdmin } from "@/lib/command-center/access";
import { defaultCatalog, parseCatalog, type Catalog } from "@/lib/mystery-shopper/catalog";
import { handleMystery, redact, type MysteryBody } from "@/lib/mystery-shopper/handle";
import { recordedJourneys } from "@/lib/mystery-shopper/recorded";
import { emptyLedger, type Ledger } from "@/lib/mystery-shopper/real-mode";
import { fileStore } from "@/lib/mystery-shopper/store";

// Mismo cerrojo que el Command Center. Sin caché: el informe no debe compartirse.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

const storeDir = () => process.env.MYSTERY_SHOPPER_STORE || path.join("/tmp", "atomivid-mystery-shopper");

async function ledger(): Promise<Ledger> {
  try { return JSON.parse(await readFile(path.join(storeDir(), "ledger.json"), "utf8")) as Ledger; }
  catch { return emptyLedger(); }
}

async function saveLedger(next: Ledger) {
  await mkdir(storeDir(), { recursive: true });
  await writeFile(path.join(storeDir(), "ledger.json"), JSON.stringify(next), { mode: 0o600 });
}

async function loadCatalog(): Promise<Catalog> {
  try { return parseCatalog(JSON.parse(await readFile(path.join(storeDir(), "catalog.json"), "utf8"))); }
  catch { return defaultCatalog(); }
}

async function saveCatalog(next: Catalog) {
  await mkdir(storeDir(), { recursive: true });
  await writeFile(path.join(storeDir(), "catalog.json"), JSON.stringify(next), { mode: 0o600 });
}

async function gate(): Promise<Response | null> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    requireCommandCenterAdmin(user);
    return null;
  } catch (e) {
    if (e instanceof CommandCenterAccessError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: "command center unavailable" }, { status: 503, headers: NO_STORE });
  }
}

export async function GET() {
  const denied = await gate();
  if (denied) return denied;
  const history = await fileStore(storeDir()).list();
  return NextResponse.json({ history, recordings: recordedJourneys().map((j) => j.missionId) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const denied = await gate();
  if (denied) return denied;
  const body = await request.json().catch(() => ({})) as MysteryBody;
  const current = await ledger();
  const result = await handleMystery(body, {
    env: process.env,
    now: () => new Date().toISOString(),
    store: fileStore(storeDir()),
    ledger: current,
    sha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.MYSTERY_SHOPPER_SHA || "desconocido",
    environment: process.env.VERCEL_ENV ? `vercel:${process.env.VERCEL_ENV}` : "local",
    recordedJourneys: recordedJourneys(),
  }, await loadCatalog());
  await saveLedger(result.ledger);
  await saveCatalog(result.catalog);
  return NextResponse.json(JSON.parse(redact(JSON.stringify(result.payload))) as unknown, { status: result.http, headers: NO_STORE });
}
