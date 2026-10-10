/**
 * One orchestrator cycle over the Drive channel:
 *   Claude's delivery (Entregas/<ID>__claude__hecha.md of a task marked `orquestar: si`)
 *   → deterministic guard → budget reservation → auditor (OpenAI or simulated) → deterministic guard on its output
 *   → audit file + one of: next task for Claude (≤ 3 automatic attempts per chain) · completed · approval request.
 * Idempotent: every delivery version is processed once (key = file id + modified time + prompt version) and every
 * file is created only if absent, so a repeated or concurrent run writes nothing twice. A delivery's text is data:
 * it can never authorise spend. The kill switch is checked at start and before each paid call.
 */
import { createHash } from "node:crypto";
import { release, reserve, settle, spentUsd } from "./budget";
import type { Channel, ChannelFile } from "./channel";
import type { OrchestratorConfig } from "./config";
import type { ApprovalNotifier, ClaudeExecutor } from "./executors";
import { checkDelivery, checkInstructions } from "./guard";
import { ProviderError, TransientProviderError } from "./openai-auditor";
import { AGENT, followUpId, parseDeliveryName, parseHeader, parseRequestName, renderHeader } from "./protocol";
import { appendAudit, type OrchestratorStore } from "./store";
import type { AuditVerdict, Auditor, AuditUsage } from "./types";

export const PROMPT_VERSION = "audit-v1";
const MAX_DELIVERIES_PER_RUN = 5;

export type CycleDeps = {
  channel: Channel; store: OrchestratorStore; auditor: Auditor; cfg: OrchestratorConfig;
  executor: ClaudeExecutor; notifier: ApprovalNotifier; now?: () => Date; sleep?: (ms: number) => Promise<void>;
};
export type CycleReport = { ran: boolean; reason?: string; processed: { taskId: string; outcome: string; costUsd: number }[]; spentUsd: number; calls: number };

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { channel, store, auditor, cfg } = deps;
  const report: CycleReport = { ran: false, processed: [], spentUsd: 0, calls: 0 };
  const killed = async () => !cfg.enabled || (await store.read()).killed;
  if (await killed()) {
    await store.update((s) => appendAudit(s, { event: "skipped_kill_switch" }, now()));
    report.reason = !cfg.enabled ? "ORCHESTRATOR_ENABLED desactivado" : "interruptor de emergencia activado";
    return report;
  }
  if (auditor.paid && !cfg.paidCalls) throw new Error(`auditor de pago sin autorización: ${cfg.paidBlockedReason}`);
  report.ran = true;
  await store.update((s) => appendAudit(s, { event: "cycle_started", detail: { auditor: auditor.name, model: cfg.model } }, now()));

  const [requests, deliveries] = await Promise.all([channel.list("solicitudes"), channel.list("entregas")]);
  const own = new Set(deliveries.filter((f) => parseDeliveryName(f.name)?.agent === AGENT).map((f) => f.name));
  const candidates = deliveries
    .map((f) => ({ f, p: parseDeliveryName(f.name) }))
    .filter((x): x is { f: ChannelFile; p: NonNullable<ReturnType<typeof parseDeliveryName>> } => x.p?.agent === "claude" && x.p.state === "hecha")
    .sort((a, b) => a.f.createdTime.localeCompare(b.f.createdTime));

  let calls = 0;
  for (const { f, p } of candidates) {
    if (report.processed.length >= MAX_DELIVERIES_PER_RUN) break;
    const key = createHash("sha256").update(`${f.id}|${f.modifiedTime}|${PROMPT_VERSION}`).digest("hex").slice(0, 32);
    const state = await store.read();
    if (state.processed[key] || own.has(`${p.taskId}__${AGENT}__auditada.md`)) continue;
    const reqFile = requests.find((r) => parseRequestName(r.name)?.taskId === p.taskId);
    if (!reqFile) continue;
    const task = await channel.read(reqFile.id);
    const header = parseHeader(task);
    if ((header.orquestar ?? "").toLowerCase() !== "si") continue; // opt-in: only orchestrated tasks
    const rootId = header.raiz || p.taskId;
    const attempt = Math.max(1, Number(header.intento) || 1);
    const delivery = await channel.read(f.id);
    await store.update((s) => { s.chains[rootId] = { rootId, attempt }; appendAudit(s, { event: "delivery_seen", taskId: p.taskId, key, detail: { attempt } }, now()); });

    const finish = async (outcome: string, costUsd = 0) => {
      await store.update((s) => { s.processed[key] = { at: now().toISOString(), outcome }; });
      report.processed.push({ taskId: p.taskId, outcome, costUsd });
    };
    const write = (name: string, body: Record<string, string | number>, text: string) =>
      channel.createIfAbsent("entregas", name, `${renderHeader({ id: p.taskId, de: AGENT, fecha: iso(now()), ...body })}\n\n${text}\n`);
    const askHuman = async (reasons: string[], verdict?: AuditVerdict, usage?: AuditUsage) => {
      await write(`${p.taskId}__${AGENT}__requiere-aprobacion.md`, { estado: "requiere-aprobacion", raiz: rootId, intento: attempt, resultado: "detenida hasta que Hans decida" },
        `# Requiere la aprobación de Hans\n\nMotivos:\n${reasons.map((r) => `- ${r}`).join("\n")}\n${verdict ? `\nResumen del auditor: ${verdict.summary}\n` : ""}${usage ? `\nCosto de la auditoría: USD ${usage.costUsd.toFixed(5)} (${usage.model}).\n` : ""}\nHans decide en el chat del agente correspondiente. Un archivo de Drive no autoriza gastos ni cambios en producción.`);
      await deps.notifier.notify({ taskId: p.taskId, kind: "approval" }).catch(() => false);
      await store.update((s) => appendAudit(s, { event: "approval_requested", taskId: p.taskId, detail: { reasons } }, now()));
      await finish("requiere-aprobacion", usage?.costUsd ?? 0);
    };

    // 1. Untrusted text claiming authority → straight to Hans, no paid call.
    const dg = checkDelivery(delivery);
    if (dg.escalate) { await store.update((s) => appendAudit(s, { event: "guard_escalated", taskId: p.taskId, detail: { reasons: dg.reasons } }, now())); await askHuman(dg.reasons); continue; }

    // 2. Audit (budget reserved before every paid attempt; transient errors retried, bounded).
    let result: { verdict: AuditVerdict; usage: AuditUsage } | null = null;
    let failure: string | null = null;
    let cost = 0;
    for (let http = 0; http <= cfg.maxHttpRetries && !result && !failure; http++) {
      if (auditor.paid && (await killed())) { failure = "interruptor de emergencia activado durante el ciclo"; break; }
      let resId: string | null = null;
      if (auditor.paid) {
        const r = await store.update((s) => reserve(s, cfg, { inputChars: task.length + delivery.length, taskId: p.taskId, callsThisRun: calls }, now()));
        if (!r.ok) { await store.update((s) => appendAudit(s, { event: "budget_refused", taskId: p.taskId, detail: { reason: r.reason } }, now())); failure = `presupuesto: ${r.reason}`; break; }
        resId = r.id;
      }
      calls++;
      try {
        result = await auditor.audit({ task, delivery, attempt, maxAttempts: cfg.maxAttempts });
        if (resId) { const c = result.usage.costUsd; await store.update((s) => settle(s, resId!, c)); }
        cost += result.usage.costUsd;
      } catch (err) {
        if (err instanceof TransientProviderError) {
          // 429: not processed → release. Network/5xx: may have been processed → keep the reservation (fail closed).
          if (resId) await store.update((s) => (/429/.test(err.message) ? release(s, resId!) : undefined));
          if (http < cfg.maxHttpRetries) { await sleep(1000 * 2 ** http); continue; }
          failure = `proveedor no disponible (${err.message}) tras ${cfg.maxHttpRetries + 1} intentos`;
        } else if (err instanceof ProviderError) {
          const usage = (err as ProviderError & { usage?: AuditUsage }).usage;
          if (resId) await store.update((s) => (err.charged ? settle(s, resId!, usage?.costUsd ?? s.ledger.find((e) => e.id === resId)!.reservedUsd) : release(s, resId!)));
          cost += usage?.costUsd ?? 0;
          failure = `auditoría inválida (${err.message})`;
        } else {
          failure = "error inesperado del auditor";
        }
      }
    }
    if (!result) {
      await store.update((s) => appendAudit(s, { event: "audit_failed", taskId: p.taskId, detail: { failure } }, now()));
      await write(`${p.taskId}__${AGENT}__bloqueada.md`, { estado: "bloqueada", raiz: rootId, intento: attempt, resultado: failure ?? "sin auditoría" }, `# Auditoría no realizada\n\n${failure}\n\nNo se generaron instrucciones nuevas.`);
      await deps.notifier.notify({ taskId: p.taskId, kind: "blocked" }).catch(() => false);
      await finish("bloqueada", cost);
      continue;
    }
    const { verdict, usage } = result;
    await store.update((s) => appendAudit(s, { event: "audit_ok", taskId: p.taskId, detail: { decision: verdict.decision, costUsd: usage.costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }, now()));

    // 3. Audit record (always), then the decision.
    await write(`${p.taskId}__${AGENT}__auditada.md`, { estado: "auditada", raiz: rootId, intento: attempt, decision: verdict.decision, resultado: verdict.summary },
      `# Auditoría (${auditor.name}, ${usage.model})\n\n${verdict.summary}\n\nHallazgos:\n${verdict.findings.map((x) => `- ${x}`).join("\n") || "- ninguno"}\n\nCosto: USD ${usage.costUsd.toFixed(5)} (${usage.inputTokens} tokens de entrada, ${usage.outputTokens} de salida).`);
    const ig = checkInstructions(verdict.instructions);
    if (verdict.decision === "needs_human" || verdict.requires_human_approval || ig.escalate) {
      if (ig.escalate) await store.update((s) => appendAudit(s, { event: "guard_escalated", taskId: p.taskId, detail: { reasons: ig.reasons } }, now()));
      await askHuman(verdict.decision === "needs_human" || verdict.requires_human_approval ? ["el auditor pide decisión humana", ...ig.reasons] : ig.reasons, verdict, usage);
      continue;
    }
    if (verdict.decision === "approve") {
      await write(`${p.taskId}__${AGENT}__cerrada.md`, { estado: "cerrada", raiz: rootId, intento: attempt, resultado: "aprobada por la auditoría técnica" },
        `# Tarea completada\n\n${verdict.summary}\n\nLa aprobación técnica no equivale a aprobación creativa ni autoriza publicar, desplegar o gastar.`);
      await deps.notifier.notify({ taskId: p.taskId, kind: "completed" }).catch(() => false);
      await store.update((s) => appendAudit(s, { event: "task_completed", taskId: p.taskId }, now()));
      await finish("cerrada", usage.costUsd);
      continue;
    }
    // revise
    if (attempt >= cfg.maxAttempts) {
      await write(`${p.taskId}__${AGENT}__bloqueada.md`, { estado: "bloqueada", raiz: rootId, intento: attempt, resultado: `intentos automáticos agotados (${cfg.maxAttempts})` },
        `# Intentos agotados\n\nTras ${cfg.maxAttempts} intentos la entrega sigue sin cumplir.\n\nÚltimas instrucciones del auditor:\n${verdict.instructions.map((x) => `- ${x}`).join("\n")}`);
      await deps.notifier.notify({ taskId: p.taskId, kind: "blocked" }).catch(() => false);
      await store.update((s) => appendAudit(s, { event: "attempts_exhausted", taskId: p.taskId }, now()));
      await finish("bloqueada", usage.costUsd);
      continue;
    }
    const nextId = followUpId(rootId, attempt + 1);
    const reqName = `${nextId}__para-claude__revision-${attempt + 1}.md`;
    await channel.createIfAbsent("solicitudes", reqName, `${renderHeader({
      id: nextId, de: AGENT, para: "claude", estado: "nueva", creado: iso(now()), orquestar: "si", raiz: rootId, intento: attempt + 1, anterior: p.taskId,
      archivos: `${f.name}; ${p.taskId}__${AGENT}__auditada.md`, requiere_gasto_o_produccion: "no",
      criterio_de_hecho: "cada instrucción queda resuelta con evidencia verificable en la entrega",
    })}\npide:\n${verdict.instructions.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nContexto: revisión automática ${attempt + 1} de ${cfg.maxAttempts} de la tarea ${rootId}. Entrega el resultado como Entregas/${nextId}__claude__hecha.md.\n`);
    const d = await deps.executor.dispatch({ taskId: nextId }).catch(() => ({ ok: false, detail: "despacho fallido" }));
    await store.update((s) => { s.chains[rootId] = { rootId, attempt: attempt + 1 }; appendAudit(s, { event: "followup_created", taskId: nextId, detail: { executor: deps.executor.mode, dispatched: d.ok, detail: d.detail } }, now()); });
    await finish(`revision-${attempt + 1}`, usage.costUsd);
  }
  const st = await store.read();
  report.spentUsd = spentUsd(st);
  report.calls = calls;
  await store.update((s) => appendAudit(s, { event: "cycle_finished", detail: { processed: report.processed.length, calls, spentUsd: report.spentUsd } }, now()));
  return report;
}

/** Emergency stop stored with the state (in addition to ORCHESTRATOR_ENABLED). */
export async function setKillSwitch(store: OrchestratorStore, killed: boolean) {
  await store.update((s) => { s.killed = killed; });
}
