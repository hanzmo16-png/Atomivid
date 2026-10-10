/**
 * Orchestrator runner. Modes (ORCH_MODE):
 *  - demo (default): self-contained simulated loop in memory (USD 0, no network) — evidence that the cycle works.
 *  - smoke: ONE real audit of a fixed delivery (USD 0.05 cap, own approval phrase, at most once per repository);
 *  - preflight: the smoke gates and worst case, nothing sent (USD 0);
 *  - live: the real Drive channel (DriveRestChannel; needs DRIVE_ACCESS_TOKEN + folder ids) and the configured
 *    store. The auditor is the OpenAI one ONLY when every paid gate passes (see src/lib/orchestrator/config.ts);
 *    otherwise the simulated one. Never merges, deploys or touches Atomivid's production data.
 * Logs carry counts and outcomes only (never Drive contents or keys).
 */
export {};
import path from "node:path";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const SMOKE_ID = "T-20261011-0000-hans-01";

/** true/false from this repository's run history of orchestrator.yml; null when it cannot be read (fail closed). */
async function previousSmokeDone(): Promise<boolean | null> {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  const { smokeAlreadyDone } = await import("../../src/lib/orchestrator/smoke");
  try {
    // Every page (a successful smoke run must not fall off the first page); more than 20 pages → unreadable.
    const runs: { id: number; display_title?: string; conclusion?: string | null }[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/orchestrator.yml/runs?status=success&per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const batch = ((await res.json()) as { workflow_runs?: typeof runs }).workflow_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) return smokeAlreadyDone(runs, Number(process.env.GITHUB_RUN_ID) || null);
    }
    return null;
  } catch { return null; }
}

/** Atomic claim of the one smoke call: creating a label is unique (201 for exactly one run, 422 for the rest). */
async function claimSmokeLabel(): Promise<"claimed" | "taken" | "error"> {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return "error";
  const { claimSmoke } = await import("../../src/lib/orchestrator/smoke");
  return claimSmoke((body) => fetch(`https://api.github.com/repos/${repo}/labels`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) }), process.env.GITHUB_RUN_ID ?? "local");
}

async function main() {
  const { loadConfig, SMOKE_APPROVAL } = await import("../../src/lib/orchestrator/config");
  const { runCycle } = await import("../../src/lib/orchestrator/engine");
  const { MemoryChannel, DriveRestChannel, serviceAccountTokenProvider, oauthRefreshTokenProvider } = await import("../../src/lib/orchestrator/channel");
  const { MemoryStore, JsonFileStore, SupabaseStore } = await import("../../src/lib/orchestrator/store");
  const { SimulatedAuditor } = await import("../../src/lib/orchestrator/simulated-auditor");
  const { OpenAIAuditor, buildRequest } = await import("../../src/lib/orchestrator/openai-auditor");
  const { DriveHandoffExecutor, ClaudeCodeActionExecutor, GitHubIssueNotifier, NoopNotifier } = await import("../../src/lib/orchestrator/executors");
  const mode = (["live", "smoke", "preflight"] as const).find((m) => m === process.env.ORCH_MODE) ?? "demo";

  if (mode === "smoke" || mode === "preflight") {
    // First real OpenAI call, if approved: ONE audit of a fixed, harmless delivery; cap USD 0.05; no Drive; at most
    // once (run history). "preflight" evaluates the same gates and worst case and sends nothing (USD 0).
    const smoke = await import("../../src/lib/orchestrator/smoke");
    const SMOKE_TASK = `id: ${SMOKE_ID}\nde: hans\npara: claude\norquestar: si\npide: escribe la palabra «listo» y una línea de verificación\ncriterio_de_hecho: aparece «listo» y una línea «verificación:»`;
    const SMOKE_DELIVERY = "listo\nverificación: la palabra pedida aparece en la primera línea.";
    const done = await previousSmokeDone();
    if (mode === "preflight") {
      // The phrase is typed only when launching the smoke run, and the key is not passed here: evaluate the rest.
      const env = { ...process.env, ORCH_PAID_APPROVAL: SMOKE_APPROVAL, OPENAI_API_KEY: process.env.OPENAI_KEY_PRESENT === "true" ? "present" : "" };
      const cfg = { ...loadConfig(env, { durableStore: false, smoke: true }), maxHttpRetries: 0 };
      const chars = buildRequest(cfg, { task: SMOKE_TASK, delivery: SMOKE_DELIVERY, attempt: 1, maxAttempts: cfg.maxAttempts }).input.reduce((n, m) => n + m.content.length, 0);
      log("PREFLIGHT", { ...smoke.smokePreflight(cfg, chars), keyPresent: process.env.OPENAI_KEY_PRESENT === "true", previousSmokeDone: done, approvalPhrase: `se escribe al lanzar smoke: ${SMOKE_APPROVAL}`, sent: false, costUsd: 0 });
      return;
    }
    const cfg = { ...loadConfig(process.env, { durableStore: false, smoke: true }), maxHttpRetries: 0 };
    log("CONFIG", { mode, paidCalls: cfg.paidCalls, paidBlockedReason: cfg.paidBlockedReason, model: cfg.model, capUsd: cfg.budgetCapUsd, maxCalls: cfg.maxCallsPerRun, previousSmokeDone: done });
    // Exit code 3 = nothing was sent: the run ends "failure" and does not count as the one smoke call.
    if (!smoke.firstAttempt(process.env.GITHUB_RUN_ATTEMPT)) { log("SMOKE_SKIPPED", { reason: "una re-ejecución nunca envía la llamada de humo" }); process.exitCode = 3; return; }
    if (done !== false) { log("SMOKE_SKIPPED", { reason: done ? "la llamada de humo ya se hizo (una sola vez)" : "no se pudo leer el historial de ejecuciones" }); process.exitCode = 3; return; }
    if (!cfg.paidCalls) { log("SMOKE_SKIPPED", { reason: cfg.paidBlockedReason }); process.exitCode = 3; return; }
    // The dedicated key lives in the "orchestrator" environment: refuse if any branch could read it.
    const { checkEnvironment } = await import("./github-checks");
    const env = await checkEnvironment();
    if (!env.ok) { log("SMOKE_SKIPPED", { reason: env.reason }); process.exitCode = 3; return; }
    // Last step before sending: the atomic claim. Never released automatically (even if the call then fails).
    const claim = await claimSmokeLabel();
    log("SMOKE_CLAIM", { result: claim });
    if (claim !== "claimed") { log("SMOKE_SKIPPED", { reason: claim === "taken" ? "otra ejecución ya reclamó la llamada de humo" : "no se pudo reclamar la llamada de humo de forma atómica" }); process.exitCode = 3; return; }
    const ch = new MemoryChannel();
    ch.add("solicitudes", `${SMOKE_ID}__para-claude__smoke.md`, SMOKE_TASK);
    ch.add("entregas", `${SMOKE_ID}__claude__hecha.md`, SMOKE_DELIVERY);
    const store = new JsonFileStore(path.resolve(".orchestrator/smoke-state.json"));
    let identity: import("../../src/lib/orchestrator/smoke").KeyIdentity | null = null;
    const capture = async (url: string, init: RequestInit) => { const res = await fetch(url, init); identity = smoke.identityFromHeaders(res.headers); return res; };
    const r = await runCycle({ channel: ch, store, auditor: new OpenAIAuditor(cfg, process.env.OPENAI_API_KEY!, capture), cfg, executor: new DriveHandoffExecutor(), notifier: new NoopNotifier() });
    const st = await store.read();
    log("SMOKE", { outcome: r.processed.map((p) => p.outcome), errors: r.errors, calls: r.calls, spentUsd: r.spentUsd, keyIdentity: identity, ledger: st.ledger.map((e) => ({ state: e.state, reservedUsd: e.reservedUsd, actualUsd: e.actualUsd })), files: ch.files.map((f) => f.name) });
    if (!smoke.smokeCallSent(st.ledger)) process.exitCode = 3;
    return;
  }

  if (mode === "demo") {
    const { simulatedClaudeTurn } = await import("../../src/lib/orchestrator/simulated-claude");
    const ch = new MemoryChannel();
    const id = "T-20261010-2100-hans-01";
    ch.add("solicitudes", `${id}__para-claude__demo.md`, `id: ${id}\nde: hans\npara: claude\norquestar: si\npide: entrega un informe con verificación`);
    const store = new MemoryStore();
    const cfg = loadConfig({ ORCHESTRATOR_ENABLED: "true" });
    const d = { channel: ch, store, auditor: new SimulatedAuditor(), cfg, executor: new DriveHandoffExecutor(), notifier: new NoopNotifier(), sleep: async () => undefined };
    const claude = (t: { attempt: number }) => (t.attempt === 1 ? "informe sin evidencia" : "informe v2\nverificación: informe-v2.md con la evidencia pedida");
    const steps: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const wrote = await simulatedClaudeTurn(ch, claude);
      const r = await runCycle(d);
      steps.push({ claude: wrote, orquestador: r.processed.map((p) => p.outcome) });
    }
    log("DEMO", { steps, files: ch.files.map((f) => `${f.folder}/${f.name}`), paidCalls: (await store.read()).ledger.length, costUsd: 0 });
    return;
  }

  const supabaseStore = process.env.ORCH_STORE === "supabase";
  let store;
  if (supabaseStore) {
    const { createServiceClient } = await import("../../src/lib/supabase/service");
    store = new SupabaseStore(createServiceClient() as never);
  } else store = new JsonFileStore(path.resolve(process.env.ORCH_STATE_FILE || ".orchestrator/state.json"));
  const cfg = loadConfig(process.env, { durableStore: store.durable });
  log("CONFIG", { enabled: cfg.enabled, paidCalls: cfg.paidCalls, paidBlockedReason: cfg.paidBlockedReason, model: cfg.model, budgetCapUsd: cfg.budgetCapUsd, maxCallsPerRun: cfg.maxCallsPerRun, store: supabaseStore ? "supabase" : "json" });
  const folders = { solicitudes: process.env.ORCH_DRIVE_SOLICITUDES ?? "", entregas: process.env.ORCH_DRIVE_ENTREGAS ?? "" };
  // Credential precedence: Hans's OAuth refresh token (can write in his My Drive) > a short-lived access token
  // (e.g. from google-github-actions/auth) > service account (read-only on a personal Drive).
  const o = { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(), refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() };
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(), staticToken = process.env.DRIVE_ACCESS_TOKEN?.trim();
  const token = o.clientId && o.clientSecret && o.refreshToken ? oauthRefreshTokenProvider(o as { clientId: string; clientSecret: string; refreshToken: string })
    : staticToken ? async () => staticToken : sa ? serviceAccountTokenProvider(sa) : null;
  const credential = o.refreshToken ? "oauth-usuario" : staticToken ? "token-temporal" : sa ? "cuenta-de-servicio (solo lectura en Drive personal)" : "ninguna";
  log("DRIVE", { credential });
  if (!token || !folders.solicitudes || !folders.entregas) { log("BLOCKED", { reason: "falta la credencial de Google Drive (GOOGLE_OAUTH_*) o los IDs de las carpetas" }); process.exitCode = 1; return; }
  const channel = new DriveRestChannel(folders, token);
  // Paid calls only from a protected environment (its dedicated key must not be readable by other branches).
  let paid = cfg.paidCalls;
  if (paid) {
    const { checkEnvironment } = await import("./github-checks");
    const env = await checkEnvironment();
    if (!env.ok) { log("PAID_BLOCKED", { reason: env.reason }); paid = false; }
  }
  const auditor = paid ? new OpenAIAuditor(cfg, process.env.OPENAI_API_KEY!) : new SimulatedAuditor();
  const executor = process.env.ORCH_CLAUDE_ACTION_ENABLED === "true" ? new ClaudeCodeActionExecutor() : new DriveHandoffExecutor();
  const notifier = process.env.GITHUB_TOKEN ? new GitHubIssueNotifier() : new NoopNotifier();
  const r = await runCycle({ channel, store, auditor, cfg, executor, notifier });
  log("CYCLE", { ran: r.ran, reason: r.reason ?? null, auditor: auditor.name, processed: r.processed, calls: r.calls, spentUsd: r.spentUsd });
}

main().catch((e) => { console.error("ORCHESTRATOR_FAILED", e instanceof Error ? e.message.slice(0, 200) : "unknown"); process.exitCode = 1; });
