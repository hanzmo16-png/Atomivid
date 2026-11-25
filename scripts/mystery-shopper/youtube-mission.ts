/**
 * Mystery Shopper 3.0 — YouTube Studio (Long Form) COMPLETO como cliente real (aprobado por Hans: t900s5862).
 *
 * Recorrido: abrir la beta (404/redirección = BLOQUEO) → tema + idioma + duración → «Crear y revisar guion» (cobro de
 * guion) → seguir la preparación → configurar (estrategia visual más barata, voz) → leer el techo que la app autorizaría →
 * «Confirmar y generar video» (cobro de render) → seguir el progreso REAL (etapa + barra) detectando atascos, retrocesos y
 * generaciones interminables → reproducir → descargar el MP4 → ffprobe/ffmpeg (duración vs pedida, A/V, audio, corrupción)
 * → comprobar que aparece en el historial (biblioteca de videos).
 *
 * Cada clic que cuesta dinero pasa por `ytSpendGuard`: modo real + interruptor MYSTERY_SHOPPER_REAL_ENABLED=1 leído en el
 * momento del clic + sin STOP en el libro + reserva atómica dentro del tope acumulado USD 8.50, del tope del módulo y del
 * tope de la ejecución. Si algo no cuadra, NO se pulsa (esa es la vía de cancelación: Long Form no ofrece «Cancelar» al
 * cliente una vez iniciado, y nunca se pulsan reintentos/reanudaciones que cuestan).
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { canReserve, MODULE_CAP_USD, type LedgerState } from "../../src/lib/mystery-shopper/v3/ledger";
import { incrementalRenderReserve, verifiedReusableScript } from "./long-form-incremental-reserve";
import { detectAv, detectMedia, detectProgress, type Incident } from "../../src/lib/mystery-shopper/v3/detect";
import { measureVideo, type VideoMeasure } from "./av-check";
import type { RealCtx } from "./real-missions";

export const YT_LIMITS = {
  minutes: 3, // mínimo que acepta el formulario (3–30)
  scriptReserveUsd: 0.6,
  scriptTimeoutMs: 25 * 60_000,
  renderTimeoutMs: 60 * 60_000,
  stallMs: 10 * 60_000,
  pollMs: 15_000,
  durationTolerance: 0.15,
};
export type YtLimits = typeof YT_LIMITS;

const usd = (t: string | null | undefined): number | null => { const m = /(\d+(?:[.,]\d{1,4})?)/.exec(String(t ?? "").replace(/\s|,(?=\d{3}\b)/g, "")); return m ? Number(m[1].replace(",", ".")) : null; };
const r2 = (n: number) => Math.round(n * 100) / 100;
export const dur = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
const Q = { timeout: 1500 }; // lecturas de sondeo: nunca esperar 30 s por un elemento que ya no existe

/** Guardia de gasto: TODO debe cumplirse antes de un clic que cuesta. Pura (probada en v3/youtube.test.ts). */
export function ytSpendGuard(i: { real: boolean; killSwitch: boolean; stopped: boolean; ledger: LedgerState | null; amountUsd: number | null; runCapUsd: number; runCommittedUsd: number }): { ok: boolean; reason: string } {
  if (!i.real) return { ok: false, reason: "Modo gratuito: no se pulsa nada que cueste." };
  if (!i.killSwitch) return { ok: false, reason: "Interruptor MYSTERY_SHOPPER_REAL_ENABLED apagado en el momento del clic." };
  if (i.stopped) return { ok: false, reason: "STOP presente en el libro de gasto: generación real detenida." };
  if (!i.ledger) return { ok: false, reason: "Sin libro de gasto no se genera." };
  if (i.amountUsd === null || !Number.isFinite(i.amountUsd) || i.amountUsd <= 0) return { ok: false, reason: "La app no mostró un monto verificable para autorizar." };
  if (i.runCommittedUsd + i.amountUsd > i.runCapUsd + 1e-9) return { ok: false, reason: `Supera el tope de esta ejecución: USD ${r2(i.runCommittedUsd)} + ${r2(i.amountUsd)} > ${r2(i.runCapUsd)}.` };
  return canReserve(i.ledger, "youtube", i.amountUsd);
}

/** Etapas sin barra (preparación del guion): atasco = misma etapa más de maxStallMs; interminable = sin terminar tras maxTotalMs. */
export function stageIncidents(module: "youtube", screen: string, samples: { t: number; stage: string; done?: boolean }[], limits: { maxTotalMs: number; maxStallMs: number }): Incident[] {
  if (!samples.length) return [];
  const pseudo = samples.map((s, i) => ({ t: s.t, pct: null as number | null, state: s.done ? "listo" : s.stage, i }));
  const out = detectProgress({ module, screen, repro: ["YouTube Studio: preparar guion de 3 min"] }, pseudo, { maxTotalMs: limits.maxTotalMs, maxStallMs: limits.maxStallMs });
  let since = samples[0].t;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].stage !== samples[i - 1].stage || samples[i].done) { since = samples[i].t; continue; }
    if (samples[i].t - since >= limits.maxStallMs) {
      out.push({ ...detectProgress({ module, screen, repro: [] }, [{ t: 0, pct: 10 }, { t: limits.maxStallMs, pct: 10 }], { maxTotalMs: Infinity, maxStallMs: limits.maxStallMs })[0], title: `La etapa «${samples[i].stage.slice(0, 80)}» no cambia en ${dur(samples[i].t - since)}`, repro: ["YouTube Studio: preparar guion de 3 min"], screenshot: null });
      break;
    }
  }
  return out;
}

/** Long Form promete no mostrar nunca 100 % mientras procesa (ProductionProgressCard): si lo hace, es progreso falso. */
export function renderIncidents(screen: string, samples: { t: number; pct: number | null; state: string }[], limits: { maxTotalMs: number; maxStallMs: number }): Incident[] {
  const ctx = { module: "youtube" as const, screen, repro: ["YouTube Studio: confirmar y generar video de 3 min"] };
  const out = detectProgress(ctx, samples, limits);
  const fake = samples.find((s) => s.pct !== null && s.pct >= 100 && s.state === "processing");
  if (fake) out.push({ ...detectProgress(ctx, [{ t: 0, pct: 0 }, { t: 1, pct: -1 }], limits)[0], title: "La barra marca 100 % mientras sigue procesando", evidence: [`t=${Math.round(fake.t / 1000)} s · ${fake.pct}%`] });
  return out;
}

type Rows = Record<string, string>;
async function rows(page: RealCtx["page"]): Promise<Rows> {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll("dt")].map((dt) => [dt.textContent?.trim() ?? "", (dt.nextElementSibling?.textContent ?? "").trim()])));
}

export async function runYoutubeStudio(c: RealCtx, limits: YtLimits = YT_LIMITS): Promise<void> {
  const { page } = c;
  const sleep = c.sleep ?? ((ms: number) => page.waitForTimeout(ms));
  const killSwitch = c.killSwitch ?? (() => false);
  const runCap = Math.min(c.runCapUsd ?? 0, MODULE_CAP_USD.youtube);
  let runCommitted = 0;
  const topic = `QA Mystery Shopper ${c.jobId.slice(-6)}: cómo se forman las nubes y por qué llueve`;
  const requestedSeconds = limits.minutes * 60;

  const guard = async (amount: number | null) => ytSpendGuard({ real: c.real, killSwitch: killSwitch(), stopped: c.ledger?.stopped ? await c.ledger.stopped().catch(() => true) : false, ledger: c.ledger ? await c.ledger.state().catch(() => null) : null, amountUsd: amount, runCapUsd: runCap, runCommittedUsd: runCommitted });
  const reserve = async (key: string, amount: number | null, label: string): Promise<boolean> => {
    let ok = false;
    await c.step(`Reservar ${label} en el libro (tope USD 8.50 · módulo USD ${MODULE_CAP_USD.youtube} · ejecución USD ${r2(runCap)})`, async () => {
      const g = await guard(amount);
      if (!g.ok) { c.act("gasto", `NO se pulsa (${label}): ${g.reason}`); return { state: "BLOCKED", detail: g.reason }; }
      const r = await c.ledger!.reserve({ key, module: "youtube", jobId: c.jobId, reservedUsd: amount!, at: new Date().toISOString() });
      ok = r.ok; if (ok) runCommitted = r2(runCommitted + amount!);
      return r.ok ? { state: "PASS", detail: `Reservado USD ${amount!.toFixed(2)} para ${label}.` } : { state: "BLOCKED", detail: r.reason };
    });
    return ok;
  };
  const settle = async (key: string, spentUsd: number, source: string) => {
    await c.ledger!.settle({ key, spentUsd: r2(spentUsd), source, at: new Date().toISOString() });
    c.addSpend(spentUsd);
  };

  // 1 · Acceso (la beta privada devuelve 404 a cuentas sin acceso)
  let open = false;
  await c.step("Abrir YouTube Studio (Long Form)", async () => {
    const met = await c.goto("/dashboard/long-form/new");
    const u = new URL(page.url()); const err = u.searchParams.get("error");
    const h = String(await page.locator("h1").first().innerText({ timeout: 3000 }).catch(() => ""));
    const gate = met?.httpStatus === 404 || /no encontramos esa página/i.test(h) ? `HTTP 404 en ${u.pathname} («${h.trim() || "sin título"}»)` : err || !/long-form\/new/.test(u.pathname) ? `Redirigido a ${u.pathname}${err ? ` (${err})` : ""}` : null;
    if (gate) {
      c.setHumanGate("La cuenta QA no tiene acceso a la beta de YouTube/Long Form (solo el dueño, la cuenta interna o una cuenta listada en BETA_QA_USER_IDS (correo confirmado) entra a la beta).");
      c.mark(c.cIdx(/Encuentra el video/), false, gate);
      return { state: "BLOCKED", detail: `Sin acceso a la beta: ${gate}` };
    }
    open = true; c.mark(c.cIdx(/Encuentra el video/), true, "Formulario visible.");
    return { state: "PASS", detail: "Formulario de Long Form abierto." };
  });
  if (!open) return;

  const resumeRequest = process.env.MS_YOUTUBE_RESUME_REQUEST_ID;
  const scriptKey = resumeRequest ? process.env.MS_YOUTUBE_EXISTING_SCRIPT_KEY ?? "" : `${c.jobId}-yt-script`;
  let configureHref = "";
  let resumeScriptSpent: number | null = null;
  if (resumeRequest) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(resumeRequest)) { c.setHumanGate("Preparación existente inválida; no se genera otro guion."); return; }
    const existing = await c.ledger?.state().catch(() => null) ?? null;
    resumeScriptSpent = verifiedReusableScript(existing, scriptKey);
    if (resumeScriptSpent === null) { c.setHumanGate("Guion previo sin liquidación verificable; no se genera ni se perdona gasto."); return; }
    runCommitted = resumeScriptSpent;
    configureHref = `/dashboard/long-form/configure/${resumeRequest}`;
    await c.step("Reutilizar preparación y guion ya liquidado (sin nuevo cobro)", async () => ({ state: "PASS", detail: "La preparación existente se verificó contra el libro; no se pulsa crear guion." }));
  } else {
  // 2 · Formulario (sin costo)
  await c.step(`Escribir tema, idioma español y duración ${limits.minutes} min`, async () => {
    await page.getByLabel("¿De qué trata tu video?").fill(topic);
    await page.getByLabel("Idioma de la narración").selectOption("es");
    await page.getByLabel("Duración (minutos)").fill(String(limits.minutes));
    const costNote = await page.getByText(/usa créditos del proveedor|cuestan más/i).first().isVisible().catch(() => false);
    c.mark(c.cIdx(/acepta tema/), true, `Tema, idioma y ${limits.minutes} min escritos.`);
    c.mark(c.cIdx(/costo antes/), costNote, costNote ? "El formulario avisa que el guion usa créditos y que la voz/imágenes se cobran tras confirmar." : "Sin aviso de costo en el formulario.");
    return { state: "PASS", detail: "Formulario listo." };
  });
  if (!c.real) {
    await c.step("Modo gratuito: se detiene antes de «Crear y revisar guion» (cobro de guion)", async () => ({ state: "SKIP", detail: "Modo gratuito o interruptor apagado: USD 0." }));
    return;
  }

  // 3 · Guion (cobro): reserva → clic
  if (!await reserve(scriptKey, limits.scriptReserveUsd, "el guion")) return;
  let jobUrl = "";
  await c.step("Pulsar «Crear y revisar guion»", async () => {
    if (!killSwitch()) { await settle(scriptKey, 0, "no se pulsó (interruptor apagado)"); return { state: "BLOCKED", detail: "Interruptor apagado justo antes del clic." }; }
    await page.getByRole("button", { name: "Crear y revisar guion" }).click();
    c.act("gasto", "«Crear y revisar guion» pulsado (guion)");
    await page.waitForURL((u: URL) => u.searchParams.has("script_job") || /long-form\/jobs\//.test(u.pathname) || u.searchParams.has("error"), { timeout: 120_000 });
    const u = new URL(page.url());
    const id = u.searchParams.get("script_job") ?? /long-form\/jobs\/([0-9a-f-]{36})/.exec(u.pathname)?.[1] ?? null;
    if (!id) return { state: "FAIL", detail: `La app no creó la preparación: ${u.searchParams.get("error") ?? u.pathname}` };
    if (u.searchParams.get("existing") === "1") c.act("aviso", "La app reutilizó una preparación existente (mismo tema): no se cobró otra.");
    jobUrl = `/dashboard/long-form/jobs/${id}`;
    return { state: "PASS", detail: `Preparación ${id} creada.` };
  });
  if (!jobUrl) { await settle(scriptKey, limits.scriptReserveUsd, "reserva (la preparación no se confirmó; se asume el peor caso)"); return; }

  // 4 · Seguir la preparación del guion
  const sSamples: { t: number; stage: string; done?: boolean }[] = [];
  await c.step(`Seguir la preparación del guion (máx. ${dur(limits.scriptTimeoutMs)})`, async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < limits.scriptTimeoutMs) {
      await c.goto(jobUrl);
      const card = (await page.locator("main").innerText(Q).catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
      const link = page.getByRole("link", { name: "Revisar y configurar producción" });
      const done = await link.isVisible().catch(() => false);
      sSamples.push({ t: Date.now() - t0, stage: card, done });
      if (done) { configureHref = String(await link.getAttribute("href")); break; }
      if (/Fallo técnico|Objeción editorial|Interrumpido/.test(card)) break;
      await sleep(limits.pollMs);
    }
    await writeFile(path.join(c.out, "youtube-guion-progreso.json"), JSON.stringify(sSamples, null, 1)).catch(() => {});
    const inc = stageIncidents("youtube", "/dashboard/long-form/jobs/[id]", sSamples, { maxTotalMs: limits.scriptTimeoutMs, maxStallMs: limits.stallMs });
    c.incidents.push(...inc);
    if (configureHref) return { state: "PASS", detail: `Guion listo en ${Math.round((sSamples.at(-1)?.t ?? 0) / 1000)} s.` };
    const last = sSamples.at(-1)?.stage ?? "";
    c.setCritical(`YouTube Studio no terminó el guion: ${last.slice(0, 160)}`);
    return { state: "FAIL", detail: `Sin guion listo. ${inc.map((i) => i.title).join(" · ") || last.slice(0, 160)}` };
  });

  }

  // 5 · Configurar producción (sin costo hasta confirmar)
  let ceiling: number | null = null; let scriptSpent: number | null = null; let strategyLabel = ""; let voice = "";
  if (configureHref) await c.step("Configurar: estrategia visual más barata, voz y techo de gasto", async () => {
    await c.goto(configureHref);
    const radios = page.locator('input[type="radio"][name="strategy"]');
    const n = await radios.count();
    let best = -1, bestUsd = Infinity;
    for (let i = 0; i < n; i++) {
      const txt = await radios.nth(i).locator("xpath=ancestor::label[1]").innerText().catch(() => "");
      const v = usd(/(?:subtotal|~)\s*[^\d]*([\d.,]+)/i.exec(txt)?.[1] ?? null);
      if (v !== null && v < bestUsd) { bestUsd = v; best = i; strategyLabel = txt.split("\n")[0].trim(); }
    }
    if (best >= 0) await radios.nth(best).check();
    const picker = page.locator("#reel_voice_picker");
    if (await picker.isEnabled().catch(() => false)) voice = await picker.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent?.trim() ?? "");
    const details = page.getByText("Ver plan y costos detallados");
    if (await details.isVisible().catch(() => false)) await details.click();
    await sleep(1500);
    const r = await rows(page);
    await writeFile(path.join(c.out, "youtube-configurar.json"), JSON.stringify({ strategy: strategyLabel, voice, rows: r }, null, 1)).catch(() => {});
    scriptSpent = usd(r["Guion ya gastado"]);
    const techo = r["Techo que se autorizaría"];
    ceiling = techo && !/no cabe|sin verificar/i.test(techo) ? usd(techo) : null;
    const blocked = await page.getByRole("alert").filter({ hasText: /No se puede iniciar/ }).first().innerText(Q).catch(() => "");
    c.mark(c.cIdx(/costo antes/), ceiling !== null, ceiling !== null ? `Techo visible antes de confirmar: USD ${ceiling.toFixed(2)} (estimado ${r["Costo estimado de proveedores"] ?? "?"}, límite ${r["Límite autorizado por producción"] ?? "?"}).` : `Sin techo verificable: «${techo ?? "no mostrado"}».`);
    if (blocked) return { state: "BLOCKED", detail: blocked };
    return ceiling !== null ? { state: "PASS", detail: `Estrategia «${strategyLabel || "?"}», voz «${voice || "predeterminada"}», techo USD ${ceiling.toFixed(2)}.` } : { state: "FAIL", detail: `La app no muestra un techo verificable («${techo ?? "no mostrado"}»): no se confirma.` };
  });
  if (resumeRequest) {
    if (scriptSpent === null || Math.abs(scriptSpent - resumeScriptSpent!) > 0.000001) {
      c.setHumanGate("El gasto de guion mostrado no coincide con la liquidación previa; no se genera."); return;
    }
  } else {
  // Liquidar el guion con lo que muestra la app («Guion ya gastado»), o con la reserva si no lo muestra.
  await c.step("Liquidar el gasto del guion", async () => {
    const v = scriptSpent ?? limits.scriptReserveUsd;
    await settle(scriptKey, v, scriptSpent === null ? "reserva (la app no mostró «Guion ya gastado»)" : "interfaz «Guion ya gastado»");
    runCommitted = r2(runCommitted - limits.scriptReserveUsd + v);
    return { state: scriptSpent === null ? "FAIL" : "PASS", detail: `Guion liquidado en USD ${v.toFixed(2)}.` };
  });
  }
  if (!configureHref || ceiling === null) return;

  // 6 · Render: el techo total ya incluye el guion liquidado; reservar el resto.
  const renderKey = `${c.jobId}-yt-render`;
  const state = await c.ledger!.state().catch(() => null);
  const prior = verifiedReusableScript(state, scriptKey);
  const renderReserve = incrementalRenderReserve(ceiling, scriptSpent, prior);
  if (renderReserve === null || renderReserve <= 0) {
    c.setHumanGate("No se verificó el gasto previo del guion contra el libro: no se autoriza ni se libera presupuesto.");
    return;
  }
  if (!await reserve(renderKey, renderReserve, "el render (resto del techo total, guion ya liquidado)")) return;
  let videoPath = "";
  await c.step("Pulsar «Confirmar y generar video»", async () => {
    if (!killSwitch()) { await settle(renderKey, 0, "no se pulsó (interruptor apagado)"); return { state: "BLOCKED", detail: "Interruptor apagado justo antes del clic." }; }
    const btn = page.getByRole("button", { name: "Confirmar y generar video" });
    if (await btn.isDisabled().catch(() => true)) { await settle(renderKey, 0, "botón deshabilitado: no se pulsó"); return { state: "BLOCKED", detail: "«Confirmar y generar video» deshabilitado." }; }
    await btn.click();
    c.act("gasto", `«Confirmar y generar video» pulsado (techo USD ${ceiling!.toFixed(2)})`);
    const went = await page.waitForURL(/\/dashboard\/videos\/[0-9a-f-]{36}/, { timeout: 120_000 }).then(() => true, () => false);
    if (!went) {
      const err = await page.getByRole("alert").first().innerText(Q).catch(() => "sin mensaje");
      c.setHumanGate("La confirmación no avanzó de forma acreditada; reserva conservada hasta verificar si se aceptó el render. No se reenvía.");
      return { state: "BLOCKED", detail: `La confirmación no avanzó; sin asumir ausencia de cargo: ${err}` };
    }
    videoPath = new URL(page.url()).pathname;
    return { state: "PASS", detail: `Producción iniciada: ${videoPath}` };
  });
  if (!videoPath) return;

  // 7 · Progreso real del render
  const rSamples: { t: number; pct: number | null; state: string; stage: string }[] = [];
  let outcome = "timeout" as "completed" | "failed" | "stalled" | "timeout";
  await c.step(`Seguir el progreso real hasta el MP4 (máx. ${dur(limits.renderTimeoutMs)})`, async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < limits.renderTimeoutMs) {
      await c.goto(videoPath);
      const done = await page.getByTestId("result-video").isVisible().catch(() => false);
      const stalled = await page.getByTestId("long-form-stage-stalled").isVisible().catch(() => false);
      const failed = await page.getByRole("alert").filter({ hasText: /No se pudo generar|Producción cancelada/ }).first().isVisible().catch(() => false);
      const pctRaw = await page.locator('[role="progressbar"]').first().getAttribute("aria-valuenow", Q).catch(() => null);
      const stage = await page.getByTestId("long-form-stage").innerText(Q).catch(() => "");
      const state = done ? "completed" : failed ? "failed" : stalled ? "stalled" : "processing";
      rSamples.push({ t: Date.now() - t0, pct: pctRaw === null ? null : Number(pctRaw), state, stage });
      if (state !== "processing") { outcome = state; break; }
      await sleep(limits.pollMs);
    }
    await writeFile(path.join(c.out, "youtube-render-progreso.json"), JSON.stringify(rSamples, null, 1)).catch(() => {});
    const inc = renderIncidents("/dashboard/videos/[id]", rSamples, { maxTotalMs: limits.renderTimeoutMs, maxStallMs: limits.stallMs });
    if (!rSamples.some((x) => x.pct !== null)) inc.push(...stageIncidents("youtube", "/dashboard/videos/[id]", rSamples.map((s) => ({ t: s.t, stage: `${s.stage} ${s.pct ?? ""}`, done: s.state === "completed" })), { maxTotalMs: Infinity, maxStallMs: limits.stallMs }).filter((i) => i.kind !== "endless_generation"));
    if (outcome === "stalled") inc.push({ ...renderIncidents("/dashboard/videos/[id]", [{ t: 0, pct: 5, state: "processing" }, { t: limits.stallMs, pct: 5, state: "processing" }], { maxTotalMs: Infinity, maxStallMs: 1 })[0], title: "La app declara que la producción dejó de reportar avances" });
    if (outcome === "timeout" || outcome === "stalled") c.act("cancelación", "Long Form no ofrece «Cancelar» al cliente: se deja de esperar, se liquida el techo y se reporta.");
    c.incidents.push(...inc);
    c.mark(c.cIdx(/progreso real/), rSamples.some((s) => s.pct !== null) && !inc.some((i) => i.kind === "wrong_progress"), `${rSamples.length} muestras; ${inc.map((i) => i.title).join(" · ") || "sin anomalías"}`);
    if (outcome === "completed") return { state: "PASS", detail: `MP4 listo en ${Math.round((rSamples.at(-1)?.t ?? 0) / 1000)} s.` };
    const err = outcome === "failed" ? await page.getByRole("alert").first().innerText(Q).catch(() => "falló") : outcome === "stalled" ? "La producción dejó de reportar avances." : `No terminó en ${dur(limits.renderTimeoutMs)}.`;
    c.setCritical(`YouTube Studio no entregó el MP4: ${err}`);
    return { state: "FAIL", detail: err };
  });
  // La app no muestra el gasto final: contabilizar el resto reservado del techo total.
  await c.step("Liquidar el gasto del render", async () => {
    await settle(renderKey, renderReserve, "resto del techo total autorizado, guion ya liquidado; peor caso, no factura del proveedor");
    return { state: "PASS", detail: `Render contabilizado en USD ${renderReserve.toFixed(2)} (resto del techo, peor caso).` };
  });
  if (outcome !== "completed") return;

  // 8 · Reproducir, descargar y medir
  let file = ""; let measure: VideoMeasure | null = null;
  await c.step("Reproducir el video", async () => {
    await page.getByTestId("play-video").click().catch(() => {});
    const played = await page.getByTestId("result-video").evaluate(async (el: HTMLVideoElement) => {
      const codec = el.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      el.muted = true;
      try { await el.play(); await new Promise((r) => setTimeout(r, 3000)); return { ok: el.currentTime > 0 && !el.error, t: el.currentTime, d: el.duration, w: el.videoWidth, h: el.videoHeight, codec, err: el.error?.code ?? null }; }
      catch (e) { return { ok: false, t: el.currentTime, d: el.duration, w: el.videoWidth, h: el.videoHeight, codec, err: el.error?.code ?? String(e) }; }
    });
    // Chromium de Playwright no trae H.264/AAC: eso es del navegador del worker, no de ATOMIVID (MS_CHROME=google-chrome lo resuelve).
    if (!played.ok && (played.codec === "" || played.err === 4)) {
      c.act("reproducción", `NO MEDIDA en este navegador (sin H.264/AAC): ${JSON.stringify(played)}`);
      return { state: "SKIP", detail: "El navegador del worker no reproduce H.264/AAC: reproducción NO MEDIDA aquí (la decodificación completa la mide ffmpeg). Usar MS_CHROME=/usr/bin/google-chrome." };
    }
    c.mark(c.cIdx(/reproduce/), played.ok, JSON.stringify(played));
    return played.ok ? { state: "PASS", detail: `Avanza a ${played.t.toFixed(1)} s de ${Number(played.d).toFixed(1)} s (${played.w}×${played.h}).` } : { state: "FAIL", detail: `No reproduce: ${JSON.stringify(played)}` };
  });
  await c.step("Descargar el MP4 y medirlo (ffprobe/ffmpeg)", async () => {
    const href = await page.getByRole("link", { name: "Descargar video" }).first().getAttribute("href");
    if (!href) return { state: "FAIL", detail: "Sin enlace «Descargar video»." };
    const res = await page.request.get(new URL(href, c.baseUrl).toString(), { timeout: 300_000 });
    if (!res.ok()) return { state: "FAIL", detail: `Descarga HTTP ${res.status()}` };
    file = path.join(c.out, `youtube-${videoPath.split("/").pop()}.mp4`);
    await writeFile(file, await res.body());
    measure = await measureVideo(file, { ffprobe: c.ffprobe, ffmpeg: c.ffmpeg });
    await writeFile(path.join(c.out, "youtube-medicion.json"), JSON.stringify(measure, null, 1)).catch(() => {});
    const ctx = { module: "youtube" as const, screen: videoPath, repro: ["Descargar el MP4 del video de YouTube"] };
    const inc = [
      ...detectMedia(ctx, { file: measure.file, decodeOk: measure.decodeOk, container: measure.container, durationSeconds: measure.durationSeconds, requestedSeconds, meanVolumeDb: measure.meanVolumeDb, maxSilenceSeconds: measure.maxSilenceSeconds, width: measure.video?.width ?? null, height: measure.video?.height ?? null, expectAspect: "16:9", expectKind: "mp4" }, limits.durationTolerance),
      ...detectAv(ctx, measure),
    ];
    c.incidents.push(...inc);
    c.mark(c.cIdx(/descarga/), measure.decodeOk, `${path.basename(file)} · ${measure.sizeBytes ?? "?"} bytes`);
    const dur = measure.durationSeconds;
    const p0 = inc.filter((i) => i.severity === "P0" || i.severity === "P1");
    return !p0.length ? { state: "PASS", detail: `${dur?.toFixed(1)} s (pedido ${requestedSeconds} s), ${measure.video?.width}×${measure.video?.height}, audio ${measure.audio?.codec}, A/V Δ ${measure.video && measure.audio && measure.video.durationSeconds !== null && measure.audio.durationSeconds !== null ? Math.abs(measure.video.durationSeconds - measure.audio.durationSeconds).toFixed(2) : "?"} s, volumen ${measure.meanVolumeDb} dB.` }
      : { state: "FAIL", detail: p0.map((i) => i.title).join(" · ") };
  });
  // 9 · Biblioteca (historial del panel)
  await c.step("Confirmar que el video aparece en el historial (biblioteca)", async () => {
    await c.goto("/dashboard");
    const id = videoPath.split("/").pop()!;
    const inLib = await page.locator(`a[href*="/dashboard/videos/${id}"]`).first().isVisible().catch(() => false);
    if (file) c.media.push(await c.probe(file, requestedSeconds, inLib));
    c.mark(c.cIdx(/biblioteca|historial/i), inLib, inLib ? "Visible en el historial." : "No aparece en el historial.");
    return inLib ? { state: "PASS", detail: "El video está en el historial del panel." } : { state: "FAIL", detail: "El video no aparece en el historial." };
  });
}
