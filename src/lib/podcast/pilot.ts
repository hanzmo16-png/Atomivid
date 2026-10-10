/**
 * Supervised production pilot (pure, no I/O). The owner configures a production with a maximum budget, may
 * schedule its start and close the app; the worker leaves a reviewable delivery or a clear block. Publication stays
 * held until the owner approves. Rules here:
 *  - budget: the remaining narration cost (what is not already paid and stored) must fit the owner's maximum, checked
 *    when the production is requested and again by the worker before any paid call;
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

export type BudgetDecision = { ok: true; remainingUsd: number } | { ok: false; remainingUsd: number; message: string };

/** Remaining cost of a production: zero once the narration is paid (ready); otherwise the narration estimate. */
export function remainingCostUsd(episode: Pick<PodcastEpisode, "status" | "source" | "estimated_usd">): number {
  if (episode.source !== "tts" || episode.status === "ready") return 0;
  return Math.max(0, Number(episode.estimated_usd) || 0);
}

export function budgetDecision(episode: Pick<PodcastEpisode, "status" | "source" | "estimated_usd">, budgetUsd: number | null | undefined): BudgetDecision {
  const remainingUsd = remainingCostUsd(episode);
  if (budgetUsd == null || !Number.isFinite(budgetUsd)) {
    return remainingUsd === 0 ? { ok: true, remainingUsd } : { ok: false, remainingUsd, message: `Fija un presupuesto máximo para esta producción (costo estimado ${usd(remainingUsd)}).` };
  }
  if (budgetUsd < 0 || budgetUsd > MAX_BUDGET_USD) return { ok: false, remainingUsd, message: `El presupuesto debe estar entre USD 0 y USD ${MAX_BUDGET_USD}.` };
  if (remainingUsd > budgetUsd + 1e-9) {
    return { ok: false, remainingUsd, message: `Presupuesto insuficiente: la producción cuesta hasta ${usd(remainingUsd)} y el máximo fijado es ${usd(budgetUsd)}. No se cobró nada.` };
  }
  return { ok: true, remainingUsd };
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
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return { calls: rows.length, committedUsd: round(committedUsd), deliveredOpenUsd: round(deliveredOpenUsd), uncertain, uncertainUsd: round(uncertainUsd), spentUsd: round(committedUsd + deliveredOpenUsd) };
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
export type VideoChecks = { checks: CheckItem[]; defects: Defect[]; spend?: SpendSummary; budgetUsd?: number | null; computedAt: string };

/** Technical checks and detected defects of a delivered video. Integrity only: it never approves anything. */
export function buildVideoChecks(input: {
  editorOk: boolean; editorChecks: { name: string; ok: boolean }[]; videoSeconds: number; audioSeconds: number; bytes: number; maxBytes: number;
  subtitles: boolean; shots: { videos: number; photos: number; cards: number; total: number }; credits: number;
  spend?: SpendSummary; budgetUsd?: number | null; now?: Date;
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
  if (input.spend) {
    const within = input.budgetUsd == null || input.spend.spentUsd <= input.budgetUsd + 1e-9;
    checks.push({ id: "budget", label: "Gasto dentro del presupuesto", ok: within && input.spend.uncertain === 0, detail: `USD ${input.spend.spentUsd.toFixed(4)} de ${input.budgetUsd == null ? "sin máximo" : `USD ${input.budgetUsd.toFixed(2)}`}${input.spend.uncertain ? `, ${input.spend.uncertain} cargo(s) incierto(s)` : ""}` });
  }
  for (const c of input.editorChecks) if (!c.ok) checks.push({ id: `editor:${c.name}`, label: `Editor: ${c.name}`, ok: false });
  const defects: Defect[] = [];
  if (!input.editorOk) defects.push({ id: "editor", severity: "alta", text: "El editor no verificó el video." });
  if (Math.abs(input.videoSeconds - input.audioSeconds) > 2) defects.push({ id: "duration", severity: "alta", text: "La duración del video no coincide con la del audio." });
  if (shots.cards > 0) defects.push({ id: "cards", severity: shots.cards / Math.max(1, shots.total) > 0.2 ? "alta" : "media", text: `${shots.cards} de ${shots.total} escenas sin imagen de banco: se usó una tarjeta.` });
  if (!input.subtitles) defects.push({ id: "subtitles", severity: "media", text: "Sin subtítulos (grabación propia o narración sin tiempos guardados)." });
  if (shots.total > 0 && shots.photos / shots.total > 0.5) defects.push({ id: "photos", severity: "baja", text: `Más de la mitad de las escenas son fotos animadas (${shots.photos}/${shots.total}): poco video real disponible para el tema.` });
  if (input.spend && input.budgetUsd != null && input.spend.spentUsd > input.budgetUsd + 1e-9) defects.push({ id: "budget", severity: "alta", text: "El gasto superó el presupuesto fijado." });
  if (input.spend?.uncertain) defects.push({ id: "uncertain", severity: "alta", text: "Hay cargos inciertos sin conciliar." });
  defects.push({ id: "relevance", severity: "baja", text: "La pertinencia de cada clip se elige por palabras clave (sin análisis semántico): revisa que las imágenes acompañen lo que se dice." });
  return { checks, defects, spend: input.spend, budgetUsd: input.budgetUsd ?? null, computedAt: (input.now ?? new Date()).toISOString() };
}

export type NoticeKind = "delivered" | "blocked" | "budget";
export function noticeText(kind: NoticeKind, detail?: string): string {
  if (kind === "delivered") return "Una producción terminó y está lista para tu revisión en Atomivid. La publicación sigue detenida hasta que la apruebes.";
  if (kind === "budget") return `Una producción programada no empezó: presupuesto insuficiente. ${detail ?? ""}`.trim().slice(0, 500);
  return `Una producción se detuvo y necesita tu atención en Atomivid. ${detail ?? ""}`.trim().slice(0, 500);
}
