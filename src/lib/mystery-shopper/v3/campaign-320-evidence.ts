import { ISSUE_320_REQUIRED_MISSIONS } from "./campaign-320";
import { MODULE_CAP_USD, REAL_CUMULATIVE_CAP_USD, type RealModule } from "./ledger";

export type Campaign320Stage =
  | "DETECTADO"
  | "EN_CORRECCION"
  | "CORREGIDO_EN_RAMA"
  | "VALIDADO_REAL"
  | "INTEGRADO";

export type Campaign320Mode = "preflight" | "fixture" | "real";

export type Campaign320Evidence = {
  missionId: (typeof ISSUE_320_REQUIRED_MISSIONS)[number]["id"];
  product: (typeof ISSUE_320_REQUIRED_MISSIONS)[number]["product"];
  stage: Campaign320Stage;
  mode: Campaign320Mode;
  runId: string | null;
  sha: string | null;
  finalFileUrl: string | null;
  mediaAccepted: boolean;
  repeatedAfterFix: boolean;
  spentUsd: number | null;
};

export type Campaign320EvidenceRow = Campaign320Evidence & {
  complete: boolean;
  reasons: string[];
};

export type Campaign320EvidenceVerdict = {
  complete: boolean;
  rows: Campaign320EvidenceRow[];
  missingMissionIds: string[];
  duplicateMissionIds: string[];
  totalSpentUsd: number;
  reasons: string[];
};

const moduleFor = (product: Campaign320Evidence["product"]): RealModule =>
  product === "long-form" ? "youtube" : product;
const nonEmpty = (value: string | null): boolean => typeof value === "string" && value.trim().length > 0;

function validateRow(e: Campaign320Evidence): Campaign320EvidenceRow {
  const reasons: string[] = [];
  const expected = ISSUE_320_REQUIRED_MISSIONS.find((m) => m.id === e.missionId);
  if (!expected || expected.product !== e.product) reasons.push("La misión no corresponde al producto requerido.");
  if (e.mode !== "real") reasons.push(`La evidencia es ${e.mode}, no una ejecución real.`);
  if (e.stage !== "VALIDADO_REAL" && e.stage !== "INTEGRADO") reasons.push(`Estado ${e.stage}: todavía no está validado realmente.`);
  if (!nonEmpty(e.runId)) reasons.push("Falta run/job ID.");
  if (!nonEmpty(e.sha)) reasons.push("Falta SHA de la versión probada.");
  if (!nonEmpty(e.finalFileUrl)) reasons.push("Falta enlace al archivo final.");
  if (!e.mediaAccepted) reasons.push("El archivo final no pasó la aceptación de medios.");
  if (!e.repeatedAfterFix) reasons.push("No consta la repetición de la misión sobre la corrección.");
  if (e.spentUsd === null || !Number.isFinite(e.spentUsd) || e.spentUsd < 0) reasons.push("El gasto real no está medido.");
  else if (e.spentUsd > MODULE_CAP_USD[moduleFor(e.product)] + 1e-9) {
    reasons.push(`Gasto USD ${e.spentUsd.toFixed(2)} supera el tope del módulo.`);
  }
  return { ...e, complete: reasons.length === 0, reasons };
}

/**
 * Cierre fail-closed del issue #320. Fixtures, preflights, CI verde o un MP4
 * sin identificación no pueden convertirse en ENTREGADO. También rechaza
 * duplicados para evitar sumar dos veces el gasto o esconder una misión.
 */
export function evaluateCampaign320Evidence(
  evidence: readonly Campaign320Evidence[],
): Campaign320EvidenceVerdict {
  const counts = new Map<string, number>();
  for (const item of evidence) counts.set(item.missionId, (counts.get(item.missionId) ?? 0) + 1);
  const duplicateMissionIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const missingMissionIds = ISSUE_320_REQUIRED_MISSIONS
    .filter((required) => !counts.has(required.id))
    .map((required) => required.id);

  const rows = evidence.map(validateRow);
  const totalSpentUsd = Math.round(evidence.reduce((sum, item) => sum + (item.spentUsd ?? 0), 0) * 100) / 100;
  const reasons: string[] = [];
  if (missingMissionIds.length) reasons.push(`Faltan misiones: ${missingMissionIds.join(", ")}.`);
  if (duplicateMissionIds.length) reasons.push(`Misiones duplicadas: ${duplicateMissionIds.join(", ")}.`);
  if (rows.some((row) => !row.complete)) reasons.push("Hay filas sin evidencia real completa.");
  if (totalSpentUsd > REAL_CUMULATIVE_CAP_USD + 1e-9) {
    reasons.push(`Gasto total USD ${totalSpentUsd.toFixed(2)} supera USD ${REAL_CUMULATIVE_CAP_USD.toFixed(2)}.`);
  }

  return {
    complete: reasons.length === 0 && rows.length === ISSUE_320_REQUIRED_MISSIONS.length,
    rows,
    missingMissionIds,
    duplicateMissionIds,
    totalSpentUsd,
    reasons,
  };
}
