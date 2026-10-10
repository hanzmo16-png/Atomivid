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
  const { MemoryChannel, DriveRestChannel, serviceAccountTokenProvider } = await import("../../src/lib/orchestrator/channel");
  const { MemoryStore, JsonFileStore, SupabaseStore } = await import("../../src/lib/orchestrator/store");
  const { SimulatedAuditor } = await import("../../src/lib/orchestrator/simulated-auditor");
  const { OpenAIAuditor } = await import("../../src/lib/orchestrator/openai-auditor");
  const { DriveHandoffExecutor, ClaudeCodeActionExecutor, GitHubIssueNotifier, NoopNotifier } = await import("../../src/lib/orchestrator/executors");
  const mode = process.env.ORCH_MODE === "live" ? "live" : "demo";

  if (mode === "demo") {
    const ch = new MemoryChannel();
    const id = "T-20261010-2100-hans-01";
    ch.add("solicitudes", `${id}__para-claude__demo.md`, `id: ${id}\nde: hans\npara: claude\norquestar: si\npide: entrega un informe con verificación`);
    ch.add("entregas", `${id}__claude__hecha.md`, "informe sin evidencia");
    const store = new MemoryStore();
    const cfg = loadConfig({ ORCHESTRATOR_ENABLED: "true" });
    const d = { channel: ch, store, auditor: new SimulatedAuditor(), cfg, executor: new DriveHandoffExecutor(), notifier: new NoopNotifier(), sleep: async () => undefined };
    const r1 = await runCycle(d);
    const next = ch.files.find((f) => f.folder === "solicitudes" && f.name.includes("orquestador"))!;
    const nextId = next.name.split("__")[0];
    ch.add("entregas", `${nextId}__claude__hecha.md`, "verificación: informe-v2.md con la evidencia pedida");
    const r2 = await runCycle(d);
    const r3 = await runCycle(d);
    log("DEMO", { cycle1: r1.processed.map((p) => p.outcome), cycle2: r2.processed.map((p) => p.outcome), cycle3_rerun: r3.processed.length, files: ch.files.map((f) => `${f.folder}/${f.name}`), costUsd: r1.spentUsd + r2.spentUsd });
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
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(), staticToken = process.env.DRIVE_ACCESS_TOKEN?.trim();
  const folders = { solicitudes: process.env.ORCH_DRIVE_SOLICITUDES ?? "", entregas: process.env.ORCH_DRIVE_ENTREGAS ?? "" };
  if ((!sa && !staticToken) || !folders.solicitudes || !folders.entregas) { log("BLOCKED", { reason: "falta la credencial de Google Drive (GOOGLE_SERVICE_ACCOUNT_JSON) o los IDs de las carpetas" }); process.exitCode = 1; return; }
  const channel = new DriveRestChannel(folders, sa ? serviceAccountTokenProvider(sa) : async () => staticToken!);
  const auditor = cfg.paidCalls ? new OpenAIAuditor(cfg, process.env.OPENAI_API_KEY!) : new SimulatedAuditor();
  const executor = process.env.ORCH_CLAUDE_ACTION_ENABLED === "true" ? new ClaudeCodeActionExecutor() : new DriveHandoffExecutor();
  const notifier = process.env.GITHUB_TOKEN ? new GitHubIssueNotifier() : new NoopNotifier();
  const r = await runCycle({ channel, store, auditor, cfg, executor, notifier });
  log("CYCLE", { ran: r.ran, reason: r.reason ?? null, auditor: auditor.name, processed: r.processed, calls: r.calls, spentUsd: r.spentUsd });
}

main().catch((e) => { console.error("ORCHESTRATOR_FAILED", e instanceof Error ? e.message.slice(0, 200) : "unknown"); process.exitCode = 1; });
