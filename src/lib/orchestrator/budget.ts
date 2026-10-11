/**
 * Orchestrator budget (separate from Atomivid's audiovisual spend and its pi_paid_operations ledger).
 * Before each paid call the worst case is reserved (estimated input tokens + max output tokens at list price);
 * the call is refused when the reservation would pass the pilot cap, the per-call limit, or the daily / per-run call
 * limits. After the call the reservation is settled with the real usage (or released if nothing was charged).
 * A reservation that is never settled keeps counting as spent (fail closed).
 */
import { randomUUID } from "node:crypto";
import type { OrchestratorConfig } from "./config";
import type { OrchestratorState } from "./store";

/** Conservative token estimate for Spanish/English text: ~3 characters per token (real is ~3.5–4). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);

export function priceUsd(cfg: Pick<OrchestratorConfig, "priceInputPerM" | "priceOutputPerM">, inputTokens: number, outputTokens: number) {
  return (inputTokens * cfg.priceInputPerM + outputTokens * cfg.priceOutputPerM) / 1_000_000;
}

export function spentUsd(s: OrchestratorState): number {
  return s.ledger.reduce((sum, e) => sum + (e.state === "settled" ? e.actualUsd : e.state === "reserved" ? e.reservedUsd : 0), 0);
}

export function callsToday(s: OrchestratorState, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return s.ledger.filter((e) => e.state !== "released" && e.at.slice(0, 10) === day).length;
}

export type Reservation = { ok: true; id: string; reservedUsd: number } | { ok: false; reason: string };

export function reserve(s: OrchestratorState, cfg: OrchestratorConfig, input: { inputChars: number; taskId: string; callsThisRun: number }, now = new Date()): Reservation {
  const reservedUsd = priceUsd(cfg, estimateTokens(input.inputChars), cfg.maxOutputTokens);
  if (!Number.isFinite(reservedUsd)) return { ok: false, reason: "precios del modelo sin configurar" };
  if (reservedUsd > cfg.maxCallUsd) return { ok: false, reason: `la llamada podría costar USD ${reservedUsd.toFixed(4)}, más que el límite por llamada (USD ${cfg.maxCallUsd})` };
  if (input.callsThisRun >= cfg.maxCallsPerRun) return { ok: false, reason: `límite de ${cfg.maxCallsPerRun} llamadas por ejecución` };
  if (callsToday(s, now) >= cfg.maxCallsPerDay) return { ok: false, reason: `límite de ${cfg.maxCallsPerDay} llamadas por día` };
  const spent = spentUsd(s);
  if (spent + reservedUsd > cfg.budgetCapUsd + 1e-12) return { ok: false, reason: `presupuesto del orquestador agotado: USD ${spent.toFixed(4)} gastados de USD ${cfg.budgetCapUsd}` };
  const id = randomUUID();
  s.ledger.push({ id, at: now.toISOString(), state: "reserved", reservedUsd, actualUsd: 0, taskId: input.taskId, model: cfg.model });
  return { ok: true, id, reservedUsd };
}

/** Real usage known: settle at the real cost (never above what the provider reports). */
export function settle(s: OrchestratorState, id: string, actualUsd: number) {
  const e = s.ledger.find((x) => x.id === id);
  if (e && e.state === "reserved") { e.state = "settled"; e.actualUsd = Math.max(0, actualUsd); }
}

/** Only when the provider certainly charged nothing (e.g. the request never left, or a 4xx before processing). */
export function release(s: OrchestratorState, id: string) {
  const e = s.ledger.find((x) => x.id === id);
  if (e && e.state === "reserved") e.state = "released";
}
