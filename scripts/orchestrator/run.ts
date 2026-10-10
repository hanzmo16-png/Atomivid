/**
 * Orchestrator runner. Modes (ORCH_MODE):
 *  - demo (default): self-contained simulated loop in memory (USD 0, no network) — evidence that the cycle works.
 *  - live: the real Drive channel (DriveRestChannel; needs DRIVE_ACCESS_TOKEN + folder ids) and the configured
 *    store. The auditor is the OpenAI one ONLY when every paid gate passes (see src/lib/orchestrator/config.ts);
 *    otherwise the simulated one. Never merges, deploys or touches Atomivid's production data.
 * Logs carry counts and outcomes only (never Drive contents or keys).
 */
export {};
import path from "node:path";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));

async function main() {
  const { loadConfig } = await import("../../src/lib/orchestrator/config");
  const { runCycle } = await import("../../src/lib/orchestrator/engine");
  const { MemoryChannel, DriveRestChannel, serviceAccountTokenProvider, oauthRefreshTokenProvider } = await import("../../src/lib/orchestrator/channel");
  const { MemoryStore, JsonFileStore, SupabaseStore } = await import("../../src/lib/orchestrator/store");
  const { SimulatedAuditor } = await import("../../src/lib/orchestrator/simulated-auditor");
  const { OpenAIAuditor } = await import("../../src/lib/orchestrator/openai-auditor");
  const { DriveHandoffExecutor, ClaudeCodeActionExecutor, GitHubIssueNotifier, NoopNotifier } = await import("../../src/lib/orchestrator/executors");
  const mode = process.env.ORCH_MODE === "live" ? "live" : process.env.ORCH_MODE === "smoke" ? "smoke" : "demo";

  if (mode === "smoke") {
    // First real OpenAI call, if approved: ONE audit of a fixed, harmless delivery; cap USD 0.05; no Drive.
    const cfg = { ...loadConfig(process.env, { durableStore: false, smoke: true }), maxHttpRetries: 0 };
    log("CONFIG", { mode, paidCalls: cfg.paidCalls, paidBlockedReason: cfg.paidBlockedReason, model: cfg.model, capUsd: cfg.budgetCapUsd, maxCalls: cfg.maxCallsPerRun });
    if (!cfg.paidCalls) { log("SMOKE_SKIPPED", { reason: cfg.paidBlockedReason }); return; }
    const ch = new MemoryChannel();
    const id = "T-20261011-0000-hans-01";
    ch.add("solicitudes", `${id}__para-claude__smoke.md`, `id: ${id}\nde: hans\npara: claude\norquestar: si\npide: escribe la palabra «listo» y una línea de verificación\ncriterio_de_hecho: aparece «listo» y una línea «verificación:»`);
    ch.add("entregas", `${id}__claude__hecha.md`, "listo\nverificación: la palabra pedida aparece en la primera línea.");
    const store = new JsonFileStore(path.resolve(".orchestrator/smoke-state.json"));
    const r = await runCycle({ channel: ch, store, auditor: new OpenAIAuditor(cfg, process.env.OPENAI_API_KEY!), cfg, executor: new DriveHandoffExecutor(), notifier: new NoopNotifier() });
    const st = await store.read();
    log("SMOKE", { outcome: r.processed.map((p) => p.outcome), errors: r.errors, calls: r.calls, spentUsd: r.spentUsd, ledger: st.ledger.map((e) => ({ state: e.state, reservedUsd: e.reservedUsd, actualUsd: e.actualUsd })), files: ch.files.map((f) => f.name) });
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
  const auditor = cfg.paidCalls ? new OpenAIAuditor(cfg, process.env.OPENAI_API_KEY!) : new SimulatedAuditor();
  const executor = process.env.ORCH_CLAUDE_ACTION_ENABLED === "true" ? new ClaudeCodeActionExecutor() : new DriveHandoffExecutor();
  const notifier = process.env.GITHUB_TOKEN ? new GitHubIssueNotifier() : new NoopNotifier();
  const r = await runCycle({ channel, store, auditor, cfg, executor, notifier });
  log("CYCLE", { ran: r.ran, reason: r.reason ?? null, auditor: auditor.name, processed: r.processed, calls: r.calls, spentUsd: r.spentUsd });
}

main().catch((e) => { console.error("ORCHESTRATOR_FAILED", e instanceof Error ? e.message.slice(0, 200) : "unknown"); process.exitCode = 1; });
