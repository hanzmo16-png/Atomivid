/**
 * FLUX (fal.ai) — preflight at USD 0 and, ONLY when explicitly authorized, ONE real image through ATOMIVID's own adapter
 * (src/lib/providers/image/flux.ts: same submit → poll → download → validation as production) plus the automatic image
 * check (generated-image-qc.ts). Never retries a paid call. Never prints secrets. Never writes to Supabase or the
 * production ledger (pi_paid_operations): the evidence (request id, sizes, sha256, billed cost) goes to OUT_DIR.
 *
 * Preflight (free): model active (public GET /v1/models), FAL_KEY authenticates (GET /v1/models/pricing — "any
 * authenticated caller", USD 0), account price, cost estimate (POST /v1/models/pricing/estimate, USD 0), balance
 * (FAL_ADMIN_KEY: GET /v1/account/billing). Generation needs ALL of:
 *   FLUX_TEST_MODE=generate · FLUX_TEST_AUTHORIZED_USD ≥ estimate (and ≤ 0.50) · FLUX_TEST_CONFIRM=GENERAR-UNA-IMAGEN-FLUX
 *   · balance verified ≥ estimate · a clean preflight.
 * Usage: npx tsx scripts/fal/flux-real-test.ts   (env: FAL_KEY, FAL_ADMIN_KEY, OUT_DIR, FLUX_TEST_* above)
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fluxImageProvider, fluxEstimatedCostUsd, fluxInput, FLUX_MODEL, FLUX_SIZES } from "../../src/lib/providers/image/flux";
import { checkGeneratedImage } from "../../src/lib/video/long-form/generated-image-qc";
import type { ImageGenerationRequest } from "../../src/lib/providers/types";

export const FLUX_TEST_PROMPT = "A cinematic photorealistic portrait of an ancient Roman warrior standing inside a dark stone fortress, dramatic torch lighting, historically inspired armor, realistic textures, atmospheric depth, vertical composition, no text, no watermark.";
export const HARD_CAP_USD = 0.5;
export const CONFIRM_PHRASE = "GENERAR-UNA-IMAGEN-FLUX";
const API = "https://api.fal.ai/v1";
const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
const outDirOf = () => process.env.OUT_DIR?.trim() || "flux-real-test-out";

type Report = Record<string, unknown> & { checks: Array<{ check: string; ok: boolean | null; detail: string }> };
const freshReport = (): Report => ({ startedAt: new Date().toISOString(), model: FLUX_MODEL, prompt: FLUX_TEST_PROMPT, size: FLUX_SIZES["9:16"], checks: [] });
let report: Report = freshReport();
const check = (name: string, ok: boolean | null, detail: string) => { report.checks.push({ check: name, ok, detail }); };

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number | null; body: unknown }> {
  try {
    const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: null, body: null }; }
}
const key = (k: string | undefined) => ({ Authorization: `Key ${k!.trim()}`, Accept: "application/json" });

export async function preflight(): Promise<{ ok: boolean; estimateUsd: number; balanceUsd: number | null }> {
  const request: ImageGenerationRequest = { prompt: FLUX_TEST_PROMPT, aspectRatio: "9:16", maxCostUsd: HARD_CAP_USD };
  const localEstimate = fluxEstimatedCostUsd(request);
  fluxInput(request); // validates the exact body we would send (throws on an invalid prompt/size)
  check("payload válido (adaptador ATOMIVID)", true, `image_size ${JSON.stringify(FLUX_SIZES["9:16"])}, 1 imagen, filtro de seguridad activo`);

  const model = await getJson(`${API}/models?endpoint_id=${encodeURIComponent(FLUX_MODEL)}`);
  const meta = ((model.body as { models?: Array<{ endpoint_id?: string; metadata?: { status?: string } }> } | null)?.models ?? []).find((m) => m.endpoint_id === FLUX_MODEL)?.metadata;
  check("modelo disponible", model.status === 200 && meta?.status === "active", `GET /v1/models → HTTP ${model.status}, status=${meta?.status ?? "?"}`);

  check("FAL_KEY presente", present(process.env.FAL_KEY), "valor no mostrado");
  let unitPrice: number | null = null;
  if (present(process.env.FAL_KEY)) {
    const pr = await getJson(`${API}/models/pricing?endpoint_id=${encodeURIComponent(FLUX_MODEL)}`, { headers: key(process.env.FAL_KEY) });
    const p = ((pr.body as { prices?: Array<{ endpoint_id?: string; unit_price?: number; unit?: string; currency?: string }> } | null)?.prices ?? []).find((x) => x.endpoint_id === FLUX_MODEL);
    const authOk = pr.status === 200;
    check("FAL_KEY autenticada", authOk, `GET /v1/models/pricing → HTTP ${pr.status}${pr.status === 401 || pr.status === 403 ? " (clave rechazada)" : ""}`);
    if (authOk && p && p.currency === "USD" && typeof p.unit_price === "number") unitPrice = p.unit_price;
    check("precio de la cuenta", unitPrice !== null && unitPrice <= 0.05, unitPrice !== null ? `USD ${unitPrice} por ${p?.unit} (publicado: USD 0.025 por megapíxel)` : "no disponible");
  }
  let estimate = localEstimate;
  if (present(process.env.FAL_KEY)) {
    const est = await getJson(`${API}/models/pricing/estimate`, { method: "POST", headers: { ...key(process.env.FAL_KEY), "Content-Type": "application/json" },
      body: JSON.stringify({ estimate_type: "unit_price", endpoints: { [FLUX_MODEL]: { unit_quantity: 1 } } }) });
    const total = (est.body as { total_cost?: number; currency?: string } | null);
    const ok = est.status === 200 && total?.currency === "USD" && typeof total.total_cost === "number";
    if (ok) estimate = Math.max(localEstimate, total!.total_cost!);
    check("estimación de fal (1 MP)", ok, ok ? `USD ${total!.total_cost} (estimación local ATOMIVID: USD ${localEstimate})` : `HTTP ${est.status}`);
  }
  check(`estimado ≤ tope duro USD ${HARD_CAP_USD}`, estimate <= HARD_CAP_USD, `USD ${estimate}`);

  let balance: number | null = null;
  check("FAL_ADMIN_KEY presente", present(process.env.FAL_ADMIN_KEY), "valor no mostrado");
  if (present(process.env.FAL_ADMIN_KEY)) {
    const b = await getJson(`${API}/account/billing?expand=credits`, { headers: key(process.env.FAL_ADMIN_KEY) });
    const c = (b.body as { credits?: { current_balance?: number; currency?: string } } | null)?.credits;
    if (b.status === 200 && String(c?.currency ?? "").toUpperCase() === "USD" && typeof c?.current_balance === "number" && c.current_balance >= 0) balance = c.current_balance;
    check("saldo verificado", balance !== null, balance !== null ? `USD ${balance}` : `GET /v1/account/billing → HTTP ${b.status}`);
    check("saldo suficiente", balance !== null && balance >= estimate, balance !== null ? `USD ${balance} ≥ USD ${estimate}` : "sin saldo verificado");
  }
  const ok = report.checks.every((c) => c.ok === true);
  report.preflight = { ok, estimateUsd: estimate, balanceUsd: balance, unitPriceUsd: unitPrice };
  return { ok, estimateUsd: estimate, balanceUsd: balance };
}

async function billedCost(requestId: string): Promise<{ costUsd: number | null; detail: string }> {
  if (!present(process.env.FAL_ADMIN_KEY)) return { costUsd: null, detail: "sin FAL_ADMIN_KEY" };
  // Billing events may lag: a few free GETs, spaced out. Never a new generation.
  for (let i = 0; i < 6; i++) {
    const r = await getJson(`${API}/models/billing-events?request_id=${encodeURIComponent(requestId)}&limit=5`, { headers: key(process.env.FAL_ADMIN_KEY) });
    const ev = ((r.body as { billing_events?: Array<{ request_id?: string; cost_total?: number; output_units?: number; unit?: string; unit_price?: number }> } | null)?.billing_events ?? [])
      .find((e) => e.request_id === requestId);
    if (ev && typeof ev.cost_total === "number") return { costUsd: ev.cost_total, detail: `billing-events: ${ev.output_units} ${ev.unit} × USD ${ev.unit_price} = USD ${ev.cost_total}` };
    if (r.status !== 200) return { costUsd: null, detail: `GET /v1/models/billing-events → HTTP ${r.status}` };
    await new Promise((res) => setTimeout(res, 20_000));
  }
  return { costUsd: null, detail: "el evento de cobro aún no aparece (se consultó 6 veces, solo GET)" };
}

async function generateOnce(estimateUsd: number): Promise<void> {
  const request: ImageGenerationRequest = { prompt: FLUX_TEST_PROMPT, aspectRatio: "9:16", maxCostUsd: Math.min(HARD_CAP_USD, Number(process.env.FLUX_TEST_AUTHORIZED_USD)), disableRetries: true };
  report.generation = { authorizedUsd: Number(process.env.FLUX_TEST_AUTHORIZED_USD), estimateUsd, submittedAt: new Date().toISOString() };
  const { providerJobId } = await fluxImageProvider.submitImage!(request);
  // Recorded BEFORE polling: if this process dies, the same request id is read back later (GET), never resubmitted.
  Object.assign(report.generation as object, { requestId: providerJobId });
  writeReport();
  const asset = await fluxImageProvider.resumeImage!(providerJobId, request);
  const sha256 = createHash("sha256").update(asset.buffer).digest("hex");
  const file = path.join(outDirOf(), `flux-roman-warrior-9x16.${asset.extension}`);
  fs.writeFileSync(file, asset.buffer);
  const qc = await checkGeneratedImage(asset, "9:16");
  const billed = await billedCost(providerJobId);
  Object.assign(report.generation as object, {
    completedAt: new Date().toISOString(), file: path.basename(file), bytes: asset.buffer.byteLength, sha256, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, model: asset.model, estimatedCostUsd: asset.costUsd,
    billedCostUsd: billed.costUsd, billedDetail: billed.detail, qc,
  });
  check("imagen generada y descargada", true, `${asset.width}x${asset.height} ${asset.mimeType}, ${asset.buffer.byteLength} bytes, sha256 ${sha256.slice(0, 16)}…`);
  check("control automático ATOMIVID (9:16)", qc.passed, qc.checks.map((c) => `${c.name}: ${c.ok ? "ok" : "falla"} (${c.detail})`).join("; "));
  check("costo real registrado", billed.costUsd !== null && billed.costUsd <= HARD_CAP_USD, billed.detail);
}

function writeReport() {
  fs.mkdirSync(outDirOf(), { recursive: true });
  const text = JSON.stringify(report, null, 2);
  for (const k of [process.env.FAL_KEY, process.env.FAL_ADMIN_KEY]) if (present(k) && text.includes(k!.trim())) throw new Error("refusing to write: secret in report");
  fs.writeFileSync(path.join(outDirOf(), "flux-real-test-report.json"), text);
}

export async function main(): Promise<Report> {
  report = freshReport();
  fs.mkdirSync(outDirOf(), { recursive: true });
  const pf = await preflight();
  const mode = process.env.FLUX_TEST_MODE === "generate" ? "generate" : "preflight";
  report.mode = mode;
  if (mode === "generate") {
    const authorized = Number(process.env.FLUX_TEST_AUTHORIZED_USD);
    const gates: Array<[string, boolean]> = [
      ["preflight completo y satisfactorio", pf.ok],
      [`autorización explícita (USD ${process.env.FLUX_TEST_AUTHORIZED_USD ?? "—"}) ≥ estimado (USD ${pf.estimateUsd}) y ≤ USD ${HARD_CAP_USD}`, Number.isFinite(authorized) && authorized >= pf.estimateUsd && authorized <= HARD_CAP_USD],
      ["frase de confirmación", process.env.FLUX_TEST_CONFIRM === CONFIRM_PHRASE],
    ];
    for (const [g, ok] of gates) check(`puerta: ${g}`, ok, ok ? "ok" : "no se cumple");
    if (gates.every(([, ok]) => ok)) {
      try { await generateOnce(pf.estimateUsd); }
      catch (err) {
        // Never retried. A request id already in the report means fal may have billed: reconcile it, do not resend.
        const e = err as { message?: string; reason?: string; providerJobId?: string };
        check("generación", false, `${e.reason ?? "error"}: ${String(e.message ?? err).slice(0, 200)}${e.providerJobId ? ` (request_id ${e.providerJobId})` : ""}`);
      }
    } else {
      check("generación", null, "NO ejecutada: falta una puerta (no se gastó nada)");
    }
  }
  report.finishedAt = new Date().toISOString();
  report.verdict = report.checks.every((c) => c.ok === true) ? "OK" : "NO-OK";
  writeReport();
  const lines = [`## FLUX ${mode === "generate" ? "prueba real (1 imagen)" : "preflight (USD 0)"} — ${report.verdict}`, "", "| comprobación | resultado | detalle |", "|---|---|---|",
    ...report.checks.map((c) => `| ${c.check} | ${c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "—"} | ${c.detail.replace(/\|/g, "/")} |`), ""];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (report.verdict !== "OK") process.exitCode = 1;
  return report;
}

if (process.argv[1] && /flux-real-test\.ts$/.test(process.argv[1])) void main();
