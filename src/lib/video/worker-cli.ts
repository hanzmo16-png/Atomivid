/**
 * T36 C1 — the render worker's ONE entry point. `scripts/render-worker.ts` (GitHub Actions) calls `runRenderWorkerCli`,
 * and so does the local walkthrough, by running that same script as a separate process: same argument handling
 * (REQUEST_ID / RENDER_ATTEMPT), attempt guard, provider checks, supply refresh, silenced logs and runRenderJob.
 *
 * Local fixture mode (ATOMIVID_WORKER_LOCAL_FIXTURE=1) only lifts the "no fixture providers" rule, and only when EVERY
 * local condition holds at once; any non-local condition aborts before reading a row:
 *   - Supabase URL on loopback (127.0.0.1 / localhost);
 *   - voice and footage providers are the fixtures (no real provider can be reached);
 *   - no real GitHub token (absent, or the `local-fake-` placeholder);
 *   - the GitHub dispatch interceptor is loaded in THIS process (it marks globalThis), so nothing can reach GitHub;
 *   - not running inside GitHub Actions (GITHUB_ACTIONS / GITHUB_EVENT_NAME unset).
 * In that mode outbound fetches are also restricted to loopback.
 */
export const LOCAL_FIXTURE_FLAG = "ATOMIVID_WORKER_LOCAL_FIXTURE";
export const DISPATCH_INTERCEPTED_MARK = "__ATOMIVID_GH_DISPATCH_INTERCEPTED__";

type Env = Record<string, string | undefined>;
export type ProviderNames = { voice: string; footage: string; music: string };

/** Refusal codes only (no values) so the CLI output never carries configuration. */
export class WorkerRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkerRefusal";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopbackUrl = (raw: string | undefined): boolean => {
  try { return LOOPBACK.has(new URL(raw ?? "").hostname); } catch { return false; }
};

/** Null when local fixture mode may run; otherwise the first failed condition. */
export function localFixtureRefusal(env: Env, names: ProviderNames, intercepted: boolean): string | null {
  if (env.GITHUB_ACTIONS || env.GITHUB_EVENT_NAME) return "LOCAL_FIXTURE_INSIDE_GITHUB_ACTIONS";
  if (!isLoopbackUrl(env.NEXT_PUBLIC_SUPABASE_URL)) return "LOCAL_FIXTURE_SUPABASE_NOT_LOOPBACK";
  if (names.voice !== "fixture" || names.footage !== "fixture") return "LOCAL_FIXTURE_REAL_PROVIDER";
  const token = env.GH_WORKER_TOKEN;
  if (token && !token.startsWith("local-fake-")) return "LOCAL_FIXTURE_REAL_GITHUB_TOKEN";
  if (!intercepted) return "LOCAL_FIXTURE_DISPATCH_NOT_INTERCEPTED";
  return null;
}

/** The production rules for real renders (unchanged): voice and footage are never fixtures; music only off-dispatch. */
export function providerRefusal(env: Env, names: ProviderNames): string | null {
  if (names.voice === "fixture" || names.footage === "fixture") return "WORKER_FIXTURE_VOICE_OR_FOOTAGE";
  if (names.music === "fixture" && env.GITHUB_EVENT_NAME === "repository_dispatch") return "WORKER_FIXTURE_MUSIC_ON_USER_RENDER";
  return null;
}

/** In local fixture mode every outbound request must stay on this machine. */
function restrictFetchToLoopback() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("data:") && !isLoopbackUrl(url)) throw new WorkerRefusal("LOCAL_FIXTURE_NON_LOOPBACK_FETCH");
    return original(input, init);
  }) as typeof fetch;
}

export async function runRenderWorkerCli(env: Env = process.env): Promise<"ran" | "skipped"> {
  const requestId = env.REQUEST_ID;
  if (!requestId) throw new WorkerRefusal("REQUEST_ID_MISSING");

  const { getVoiceProvider } = await import("@/lib/providers/voice");
  const { getFootageProvider } = await import("@/lib/providers/footage");
  const { getMusicProvider } = await import("@/lib/providers/music");
  const names: ProviderNames = { voice: getVoiceProvider().name, footage: getFootageProvider().name, music: getMusicProvider().name };
  const localFixture = env[LOCAL_FIXTURE_FLAG] === "1";
  if (localFixture) {
    // Checked before touching anything, including the database.
    const refusal = localFixtureRefusal(env, names, (globalThis as Record<string, unknown>)[DISPATCH_INTERCEPTED_MARK] === true);
    if (refusal) throw new WorkerRefusal(refusal);
    restrictFetchToLoopback();
  }

  const { createServiceClient } = await import("@/lib/supabase/service");
  const { writeFile } = await import("node:fs/promises");
  const row = await createServiceClient().from("video_requests").select("status,render_attempts").eq("id", requestId).single();
  if (row.error) throw new WorkerRefusal("REQUEST_READ_FAILED");
  if (!row.data || row.data.status !== "processing") return "skipped";
  const supplied = env.RENDER_ATTEMPT;
  if (supplied && Number(supplied) !== row.data.render_attempts) return "skipped";
  const attempt = row.data.render_attempts as number;
  // Local runner file only; not published as an artifact. Cleanup cannot guess the current attempt after a timeout
  // or a delayed dispatch.
  await writeFile(".render-attempt.json", JSON.stringify({ requestId, attempt }), { mode: 0o600 });

  if (!localFixture) {
    // Este worker existe para generar videos reales para usuarios reales: si falta una API key y el pipeline caería a
    // un proveedor fixture, mejor fallar con un código claro que entregar un video que no es el que el usuario pidió.
    const refusal = providerRefusal(env, names);
    if (refusal) throw new WorkerRefusal(refusal);
    if (names.music === "fixture") {
      console.warn("Aviso: usando música fixture (tono de prueba) porque este run se disparó manualmente (workflow_dispatch), no por un usuario real.");
    }
  }

  const { runRenderJob } = await import("@/lib/video/run-job");
  const { monitorSupply } = await import("@/lib/supply/monitor");
  // Read-only billing GETs keep API-backed observations fresh during a long render.
  const service = createServiceClient();
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { await monitorSupply(service); } finally { refreshing = false; }
  };
  await refresh();
  const supplyTimer = setInterval(() => {
    void refresh().catch(() => { /* Existing supply gates fail closed on stale/failed reads. */ });
  }, 120_000);
  const original = { log: console.log, warn: console.warn, error: console.error };
  try {
    console.log = console.warn = console.error = () => {};
    await runRenderJob(requestId, attempt);
  } finally { clearInterval(supplyTimer); Object.assign(console, original); }
  return "ran";
}
