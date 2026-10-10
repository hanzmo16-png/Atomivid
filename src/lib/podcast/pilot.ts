/**
 * Supervised production pilot (pure, no I/O). The owner configures a production with a maximum budget, may
 * schedule its start and close the app; the worker leaves a reviewable delivery or a clear block. Publication stays
 * held until the owner approves. Rules here:
 *  - budget: `budget_usd` is the TOTAL budget of the episode. What the episode already spent (historical, from the
 *    paid-call ledger; uncertain charges count as spent) plus the pending incremental cost (what is not already paid
 *    and stored) must fit it. Checked when the production is requested, when a scheduled start is claimed and again
 *    by the worker before any paid call; the review check compares the same total, so both always agree;
 *  - run limit: independently, each run carries the NEW spend the owner authorised for it (`run_budget_usd`). It must
 *    cover the run's upper bound (pending estimate + the per-chunk rounding of the reservations) and the narration
 *    stops BEFORE any paid chunk that would pass min(run limit, what is left of the total budget);
 *  - uncertain charge: a paid call whose outcome is unknown (no stored result) stops the production until it is
 *    reconciled; a call whose result is stored is reused at no cost and is not uncertain;
 *  - bounded retries: a production can be (re)started at most MAX_PRODUCTION_ATTEMPTS times;
 *  - checks vs approval: technical checks and detected defects are stored for review; they never approve anything.
 */
import type { PodcastEpisode } from "./episode";

export const MAX_PRODUCTION_ATTEMPTS = 5;
export const MAX_BUDGET_USD = 100;
/** A scheduled start must be at least this far ahead and at most this far (one-shot, never recurring). */
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;
export const SCHEDULE_MAX_LEAD_MS = 14 * 24 * 3600_000;

const usd = (n: number) => `USD ${n.toFixed(2)}`;
const usd4 = (n: number) => `USD ${n.toFixed(4)}`;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The three amounts of an episode's budget: what it already spent, what this production may still cost, and the sum. */
export type BudgetFigures = { spentUsd: number; remainingUsd: number; projectedUsd: number; minimumBudgetUsd: number };
export type BudgetDecision = ({ ok: true } | { ok: false; message: string }) & BudgetFigures;

/** Remaining cost of a production: zero once the narration is paid (ready); otherwise the narration estimate. */
export function remainingCostUsd(episode: Pick<PodcastEpisode, "status" | "source" | "estimated_usd">): number {
  if (episode.source !== "tts" || episode.status === "ready") return 0;
  return Math.max(0, Number(episode.estimated_usd) || 0);
}

/** Upper bound of a run's new spend: the pending estimate plus the per-chunk rounding of the paid-call reservations. */
export const runUpperBoundUsd = (remainingUsd: number, chunks: number) => (remainingUsd > 0 ? Math.ceil((remainingUsd + Math.max(1, chunks) * 0.0001) * 10_000 - 1e-6) / 10_000 : 0);
/** Smallest run limit the owner can authorise (whole cents, rounded up). */
export const minimumRunBudgetUsd = (remainingUsd: number, chunks: number) => Math.ceil(runUpperBoundUsd(remainingUsd, chunks) * 100 - 1e-6) / 100;

/** `available` false = the column is not readable (migration not applied, or a read error): fail closed for new spend. */
export type RunBudget = { available: boolean; value: number | null };

/**
 * Independent per-run limit of NEW spend. A run that cannot charge anything new needs none. Otherwise the owner's
 * authorisation for this run must exist and cover the run's upper bound; never inferred from the total budget.
 */
export function runBudgetDecision(remainingUsd: number, chunks: number, run: RunBudget): { ok: true; capUsd: number | null } | { ok: false; message: string } {
  if (remainingUsd <= 0) return { ok: true, capUsd: null };
  const min = minimumRunBudgetUsd(remainingUsd, chunks);
  if (!run.available) return { ok: false, message: "No se pudo leer el límite de gasto por ejecución (¿falta aplicar su migración?). No se inició ningún gasto nuevo." };
  if (run.value == null || !Number.isFinite(run.value)) return { ok: false, message: `Fija el máximo de gasto nuevo autorizado para esta ejecución: puede costar hasta ${usd4(runUpperBoundUsd(remainingUsd, chunks))} (mínimo ${usd(min)}).` };
  if (run.value < 0 || run.value > MAX_BUDGET_USD) return { ok: false, message: `El límite por ejecución debe estar entre USD 0 y USD ${MAX_BUDGET_USD}.` };
  if (runUpperBoundUsd(remainingUsd, chunks) > run.value + 1e-9) return { ok: false, message: `Límite de esta ejecución insuficiente: puede costar hasta ${usd4(runUpperBoundUsd(remainingUsd, chunks))} y autorizaste ${usd(run.value)}. Fija al menos ${usd(min)}. No se cobró nada.` };
  return { ok: true, capUsd: run.value };
}

/** Hard cap handed to the narration: the run limit and what is left of the episode's total budget, whichever is lower. */
export function narrationCapUsd(runCapUsd: number | null, budgetUsd: number | null | undefined, spentUsd: number): number | null {
  const caps = [runCapUsd, budgetUsd == null || !Number.isFinite(budgetUsd) ? null : Math.max(0, budgetUsd - spentUsd)].filter((c): c is number => c != null);
  return caps.length ? round4(Math.min(...caps)) : null;
}

/** Historical spend of an episode for budgeting: spent + uncertain (an unconfirmed charge may have been billed). */
export const historicalSpendUsd = (spend: Pick<SpendSummary, "spentUsd" | "uncertainUsd">) => round4(spend.spentUsd + spend.uncertainUsd);

/** Smallest total budget (whole cents, rounded up) that covers what was spent plus what is pending. */
export const minimumBudgetUsd = (spentUsd: number, remainingUsd: number) => Math.ceil(round4(spentUsd + remainingUsd) * 100 - 1e-6) / 100;

/**
 * Episode total budget: historical spend + pending incremental cost ≤ budget. `spentUsd` null = the ledger could not
 * be read: nothing that depends on the budget starts (fail closed). Without a budget a production may start only if
 * it cannot charge anything new.
 */
export function budgetDecision(episode: Pick<PodcastEpisode, "status" | "source" | "estimated_usd">, budgetUsd: number | null | undefined, spentUsd: number | null, pendingUsd?: number): BudgetDecision {
  // `pendingUsd` (server): what is still unpaid, net of chunks already paid and stored; otherwise the full estimate.
  const remainingUsd = pendingUsd === undefined ? remainingCostUsd(episode) : Math.max(0, round4(pendingUsd));
  const spent = spentUsd == null ? 0 : Math.max(0, spentUsd);
  const figures: BudgetFigures = { spentUsd: round4(spent), remainingUsd, projectedUsd: round4(spent + remainingUsd), minimumBudgetUsd: minimumBudgetUsd(spent, remainingUsd) };
  const noBudget = budgetUsd == null || !Number.isFinite(budgetUsd);
  // Nothing new can be charged: no money is at stake, so no budget can refuse it (a free re-render after an old,
  // lower budget). The review still reports a past overrun, as a low-severity note.
  if (remainingUsd === 0) return { ok: true, ...figures };
  if (spentUsd == null) return { ok: false, ...figures, message: "No se pudo leer el registro de gastos del episodio; no se inició nada para no gastar a ciegas. Inténtalo más tarde." };
  if (noBudget) return { ok: false, ...figures, message: `Fija un presupuesto total para el episodio: ya gastó ${usd4(spent)} y esta producción puede costar hasta ${usd(remainingUsd)} más (mínimo ${usd(figures.minimumBudgetUsd)}).` };
  if (budgetUsd < 0 || budgetUsd > MAX_BUDGET_USD) return { ok: false, ...figures, message: `El presupuesto debe estar entre USD 0 y USD ${MAX_BUDGET_USD}.` };
  if (figures.projectedUsd > budgetUsd + 1e-9) {
    return { ok: false, ...figures, message: `Presupuesto total insuficiente: el episodio ya gastó ${usd4(spent)} y esta producción puede costar hasta ${usd(remainingUsd)} más (total ${usd4(figures.projectedUsd)}), pero el presupuesto total es ${usd(budgetUsd)}. Fija al menos ${usd(figures.minimumBudgetUsd)}. No se cobró nada.` };
  }
  return { ok: true, ...figures };
}

export type LedgerRow = { idempotency_key: string; status: string; reserved_usd: number | string; committed_usd: number | string | null };
const OPEN = new Set(["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);

export type SpendSummary = { calls: number; committedUsd: number; deliveredOpenUsd: number; uncertain: number; uncertainUsd: number; spentUsd: number };

/**
 * Spend of a production from its paid-call rows. `storedKeys` are the idempotency keys whose result is stored
 * (the provider delivered it): an open row with a stored result is spent but certain; without one it is uncertain.
 */
export function summarizeSpend(rows: LedgerRow[], storedKeys: ReadonlySet<string>): SpendSummary {
  let committedUsd = 0, deliveredOpenUsd = 0, uncertain = 0, uncertainUsd = 0;
  for (const r of rows) {
    if (r.status === "COMMITTED") committedUsd += Number(r.committed_usd ?? r.reserved_usd) || 0;
    else if (OPEN.has(r.status)) {
      if (storedKeys.has(r.idempotency_key)) deliveredOpenUsd += Number(r.reserved_usd) || 0;
      else { uncertain++; uncertainUsd += Number(r.reserved_usd) || 0; }
    }
  }
  return { calls: rows.length, committedUsd: round4(committedUsd), deliveredOpenUsd: round4(deliveredOpenUsd), uncertain, uncertainUsd: round4(uncertainUsd), spentUsd: round4(committedUsd + deliveredOpenUsd) };
}

export const UNCERTAIN_CHARGE_MESSAGE = "Hay un cargo de narración cuyo resultado no se pudo confirmar. La producción se detuvo para no cobrarlo dos veces: hay que conciliarlo con el historial de ElevenLabs antes de repetirla.";

/** A start after a failure, a block or a dead run is a retry; any other start is a new production. */
export function isRetry(episode: Pick<PodcastEpisode, "video_status">, stalled = false): boolean {
  return episode.video_status === "failed" || episode.video_status === "blocked" || stalled;
}

/** Consecutive unsuccessful attempts since the last delivery: at most MAX_PRODUCTION_ATTEMPTS, then the owner must look. */
export function attemptsDecision(episode: Pick<PodcastEpisode, "video_status" | "retry_count">, stalled = false): { ok: true; retryCount: number } | { ok: false; message: string } {
  if (!isRetry(episode, stalled)) return { ok: true, retryCount: 0 };
  const next = (episode.retry_count ?? 0) + 1;
  return next >= MAX_PRODUCTION_ATTEMPTS
    ? { ok: false, message: `Esta producción ya falló ${MAX_PRODUCTION_ATTEMPTS - 1} veces seguidas. Revisa el último error antes de reintentar; se detuvo para no repetir trabajo ni cargos sin control.` }
    : { ok: true, retryCount: next };
}

export function scheduleDecision(scheduleAt: string | null | undefined, now = Date.now()): { ok: true; at: string | null } | { ok: false; message: string } {
  if (!scheduleAt) return { ok: true, at: null };
  const t = Date.parse(scheduleAt);
  if (!Number.isFinite(t)) return { ok: false, message: "La fecha programada no es válida." };
  if (t < now + SCHEDULE_MIN_LEAD_MS) return { ok: false, message: "Programa el inicio al menos 2 minutos en el futuro (o produce ahora)." };
  if (t > now + SCHEDULE_MAX_LEAD_MS) return { ok: false, message: "Programa el inicio dentro de los próximos 14 días." };
  return { ok: true, at: new Date(t).toISOString() };
}

export type CheckItem = { id: string; label: string; ok: boolean; detail?: string };
export type Defect = { id: string; severity: "alta" | "media" | "baja"; text: string };
/** Budget breakdown of a delivery: episode total vs historical spend (before this run) vs what this run added. */
export type BudgetBreakdown = { totalBudgetUsd: number | null; runBudgetUsd?: number | null; spentBeforeUsd: number; incrementalUsd: number; pendingEstimateUsd: number; spentUsd: number };
export type VideoChecks = { checks: CheckItem[]; defects: Defect[]; spend?: SpendSummary; budgetUsd?: number | null; budget?: BudgetBreakdown; computedAt: string };

/** Technical checks and detected defects of a delivered video. Integrity only: it never approves anything. */
export function buildVideoChecks(input: {
  editorOk: boolean; editorChecks: { name: string; ok: boolean }[]; videoSeconds: number; audioSeconds: number; bytes: number; maxBytes: number;
  subtitles: boolean; shots: { videos: number; photos: number; cards: number; total: number }; credits: number;
  spend?: SpendSummary; budgetUsd?: number | null;
  /** Historical spend read by the worker's preflight (before any paid call of this run) and the pending estimate then. */
  spentBeforeUsd?: number; pendingEstimateUsd?: number; runBudgetUsd?: number | null; now?: Date;
}): VideoChecks {
  const { shots } = input;
  const checks: CheckItem[] = [
    { id: "editor", label: "El editor verificó el video final", ok: input.editorOk, detail: `${input.editorChecks.filter((c) => c.ok).length}/${input.editorChecks.length} comprobaciones del editor` },
    { id: "duration", label: "La duración coincide con el audio", ok: Math.abs(input.videoSeconds - input.audioSeconds) <= 2, detail: `${input.videoSeconds.toFixed(1)} s de video, ${input.audioSeconds.toFixed(1)} s de audio` },
    { id: "size", label: "El archivo cabe en el almacenamiento", ok: input.bytes > 0 && input.bytes <= input.maxBytes, detail: `${(input.bytes / 1048576).toFixed(1)} MB` },
    { id: "subtitles", label: "Subtítulos sincronizados con la voz", ok: input.subtitles, detail: input.subtitles ? "palabra por palabra" : "sin subtítulos" },
    { id: "picture", label: "Imagen en movimiento en todas las escenas", ok: shots.cards === 0, detail: `${shots.videos} clips, ${shots.photos} fotos animadas, ${shots.cards} tarjetas` },
    { id: "credits", label: "Recursos con licencia acreditados", ok: input.credits > 0 || shots.videos + shots.photos === 0, detail: `${input.credits} fuentes` },
  ];
  let budget: BudgetBreakdown | undefined;
  if (input.spend) {
    // Same total as the start rule: everything the episode spent (uncertain included) against its total budget.
    const total = historicalSpendUsd(input.spend);
    // Unknown "before" counts everything as this run's (conservative).
    const before = Math.min(total, Math.max(0, input.spentBeforeUsd ?? 0));
    budget = { totalBudgetUsd: input.budgetUsd ?? null, ...(input.runBudgetUsd !== undefined ? { runBudgetUsd: input.runBudgetUsd } : {}), spentBeforeUsd: round4(before), incrementalUsd: round4(total - before), pendingEstimateUsd: round4(input.pendingEstimateUsd ?? 0), spentUsd: total };
    const within = input.budgetUsd == null || total <= input.budgetUsd + 1e-9;
    // Same rule as the start: a run that added no new spend cannot break the budget (no money was at stake).
    checks.push({ id: "budget", label: "Gasto total del episodio dentro de su presupuesto total", ok: (within || budget.incrementalUsd === 0) && input.spend.uncertain === 0,
      detail: `${usd4(total)} de ${input.budgetUsd == null ? "sin presupuesto (sin costo nuevo)" : usd(input.budgetUsd)}: ${usd4(budget.spentBeforeUsd)} ya gastado antes + ${usd4(budget.incrementalUsd)} en esta producción${input.spend.uncertain ? `, ${input.spend.uncertain} cargo(s) incierto(s)` : ""}` });
    if (input.runBudgetUsd != null) {
      checks.push({ id: "run_budget", label: "Gasto nuevo de esta ejecución dentro de su límite autorizado", ok: budget.incrementalUsd <= input.runBudgetUsd + 1e-9, detail: `${usd4(budget.incrementalUsd)} de ${usd(input.runBudgetUsd)} autorizados` });
    }
    if (input.pendingEstimateUsd !== undefined) {
      checks.push({ id: "estimate", label: "El costo de esta producción no superó su estimación", ok: budget.incrementalUsd <= budget.pendingEstimateUsd + 1e-9, detail: `${usd4(budget.incrementalUsd)} de ${usd4(budget.pendingEstimateUsd)} estimados` });
    }
  }
  for (const c of input.editorChecks) if (!c.ok) checks.push({ id: `editor:${c.name}`, label: `Editor: ${c.name}`, ok: false });
  const defects: Defect[] = [];
  if (!input.editorOk) defects.push({ id: "editor", severity: "alta", text: "El editor no verificó el video." });
  if (Math.abs(input.videoSeconds - input.audioSeconds) > 2) defects.push({ id: "duration", severity: "alta", text: "La duración del video no coincide con la del audio." });
  if (shots.cards > 0) defects.push({ id: "cards", severity: shots.cards / Math.max(1, shots.total) > 0.2 ? "alta" : "media", text: `${shots.cards} de ${shots.total} escenas sin imagen de banco: se usó una tarjeta.` });
  if (!input.subtitles) defects.push({ id: "subtitles", severity: "media", text: "Sin subtítulos (grabación propia o narración sin tiempos guardados)." });
  if (shots.total > 0 && shots.photos / shots.total > 0.5) defects.push({ id: "photos", severity: "baja", text: `Más de la mitad de las escenas son fotos animadas (${shots.photos}/${shots.total}): poco video real disponible para el tema.` });
  if (budget && budget.totalBudgetUsd != null && budget.spentUsd > budget.totalBudgetUsd + 1e-9) {
    defects.push(budget.incrementalUsd > 0
      ? { id: "budget", severity: "alta", text: "El gasto total del episodio superó su presupuesto total." }
      : { id: "budget_history", severity: "baja", text: "El gasto anterior del episodio ya superaba su presupuesto total; esta ejecución no gastó nada nuevo." });
  }
  if (budget && input.runBudgetUsd != null && budget.incrementalUsd > input.runBudgetUsd + 1e-9) defects.push({ id: "run_budget", severity: "alta", text: "Esta ejecución gastó más que su límite autorizado." });
  if (budget && input.pendingEstimateUsd !== undefined && budget.incrementalUsd > budget.pendingEstimateUsd + 1e-9) defects.push({ id: "estimate", severity: "media", text: "Esta producción costó más que su estimación." });
  if (input.spend?.uncertain) defects.push({ id: "uncertain", severity: "alta", text: "Hay cargos inciertos sin conciliar." });
  defects.push({ id: "relevance", severity: "baja", text: "La pertinencia de cada clip se elige por palabras clave (sin análisis semántico): revisa que las imágenes acompañen lo que se dice." });
  return { checks, defects, spend: input.spend, budgetUsd: input.budgetUsd ?? null, ...(budget ? { budget } : {}), computedAt: (input.now ?? new Date()).toISOString() };
}

export type NoticeKind = "delivered" | "blocked" | "budget";
export function noticeText(kind: NoticeKind, detail?: string): string {
  if (kind === "delivered") return "Una producción terminó y está lista para tu revisión en Atomivid. La publicación sigue detenida hasta que la apruebes.";
  if (kind === "budget") return `Una producción programada no empezó: presupuesto insuficiente. ${detail ?? ""}`.trim().slice(0, 500);
  return `Una producción se detuvo y necesita tu atención en Atomivid. ${detail ?? ""}`.trim().slice(0, 500);
}
