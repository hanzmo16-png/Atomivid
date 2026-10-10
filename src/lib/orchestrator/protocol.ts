/**
 * Protocol v2 of the Drive channel (LEER_PRIMERO.md): append-only files.
 *  - Solicitudes/<ID>__para-<responsable>__<tema>.md     (a task)
 *  - Entregas/<ID>__<agente>__<estado>.md                 (state change / result)
 * The orchestrator signs as "orquestador". Follow-up tasks carry `raiz:` (first task of the chain) and `intento:`.
 */
import { createHash } from "node:crypto";
export const AGENT = "orquestador";
const ID_RE = /^(T-\d{8}-\d{4}-[a-z]+-\d{2,})/;

export type ParsedName = { taskId: string; agent: string; state: string } | null;

/** Entregas/<ID>__<agente>__<estado>.md */
export function parseDeliveryName(name: string): ParsedName {
  const m = /^(T-\d{8}-\d{4}-[a-z]+-\d{2,})__([a-z]+)__([a-z_-]+)\.md$/.exec(name);
  return m ? { taskId: m[1], agent: m[2], state: m[3] } : null;
}

/** Solicitudes/<ID>__para-<responsable>__<tema>.md */
export function parseRequestName(name: string): { taskId: string; to: string; topic: string } | null {
  const m = /^(T-\d{8}-\d{4}-[a-z]+-\d{2,})__para-([a-z]+)__([a-z0-9-]+)\.md$/.exec(name);
  return m ? { taskId: m[1], to: m[2], topic: m[3] } : null;
}

export function taskIdOf(name: string): string | null { return ID_RE.exec(name)?.[1] ?? null; }

export function parseHeader(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n").slice(0, 40)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

export function renderHeader(fields: Record<string, string | number>): string {
  return Object.entries(fields).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
}

/** Deterministic follow-up id: same chain + attempt always gives the same id (re-runs never duplicate a task). */
export function followUpId(rootId: string, attempt: number): string {
  const m = /^T-(\d{8})-(\d{4})-[a-z]+-(\d{2,})$/.exec(rootId);
  const [date, hhmm, nn] = m ? [m[1], m[2], m[3]] : ["00000000", "0000", "00"];
  return `T-${date}-${hhmm}-${AGENT}-${nn}${String(attempt).padStart(2, "0")}`;
}

export const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tarea";

/** Digest of a task file as written by the orchestrator (line endings and trailing space normalised). The executor
 *  only runs a task whose Drive file has exactly this digest: a planted or edited file with the same id is refused. */
export function taskDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}
