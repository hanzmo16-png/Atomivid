/**
 * Mystery Shopper 3.0 — misiones de generación REAL como cliente (autorización t899u, tope acumulado USD 8.50).
 *
 * Solo se pulsa «Generar» si TODO se cumple: job.mode === "real", MYSTERY_SHOPPER_REAL_ENABLED=1 (interruptor),
 * la reserva atómica en v3/ledger cabe en el tope acumulado y en el del módulo, y el monto que la app pide autorizar
 * es ≤ al reservado. En modo gratuito la misma misión recorre todo hasta la autorización y se detiene (USD 0).
 * El gasto se liquida con el «Gastado» que muestra la app (fuente: interfaz), nunca con la estimación.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { LiveStep, MediaCheck, PageMetrics } from "../../src/lib/mystery-shopper/live";
import { detectMedia, detectProgress, type Incident } from "../../src/lib/mystery-shopper/v3/detect";
import { runYoutubeStudio } from "./youtube-mission";
import { MODULE_CAP_USD, type LedgerState, type Reservation, type Settlement } from "../../src/lib/mystery-shopper/v3/ledger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- playwright no es dependencia de la app.
type Page = any;
type StepFn = (name: string, fn: () => Promise<{ state: LiveStep["state"]; detail: string }>) => Promise<LiveStep>;
export type RealCtx = {
  page: Page; jobId: string; baseUrl: string; out: string; real: boolean;
  step: StepFn; goto: (p: string) => Promise<PageMetrics>; metrics: (s: number | null, ms: number) => Promise<PageMetrics>;
  mark: (i: number, met: boolean, evidence: string) => void; cIdx: (re: RegExp) => number; act: (a: string, d?: string) => void;
  probe: (file: string, requested: number | null, inLibrary: boolean | null) => Promise<MediaCheck>; media: MediaCheck[];
  incidents: Incident[]; setCritical: (s: string) => void; setHumanGate: (s: string) => void; addSpend: (usd: number) => void;
  ledger: { state(): Promise<LedgerState>; reserve(r: Reservation): Promise<{ ok: boolean; reason: string }>; settle(s: Settlement): Promise<void>; stopped?(): Promise<boolean> } | null;
  sleep?: (ms: number) => Promise<void>;
  /** Interruptor leído en el momento de cada clic que cuesta (MYSTERY_SHOPPER_REAL_ENABLED === "1"). */
  killSwitch?: () => boolean;
  /** Tope de gasto de ESTA ejecución (job.maxBudgetUsd); además del acumulado y del módulo. */
  runCapUsd?: number;
  ffprobe?: string; ffmpeg?: string;
};

export const usdOf = (t: string | null | undefined): number | null => { const m = /(\d+(?:[.,]\d{1,2})?)/.exec(String(t ?? "").replace(/\s/g, "")); return m ? Number(m[1].replace(",", ".")) : null; };

/** Guion propio de ~470 palabras (≈ 3 min a 150 ppm), con «Voz 1:/Voz 2:» o una sola voz. Sin IA, sin costo. */
export function qaScript(lang: "es" | "en", voices: 1 | 2): string {
  const es = [
    "Hoy hablamos de cómo se forman las nubes y por qué algunas traen lluvia y otras no.",
    "Todo empieza con el sol, que calienta el mar, los lagos y la tierra húmeda, y convierte parte de esa agua en vapor invisible.",
    "Ese vapor sube con el aire caliente. Mientras más alto llega, más frío encuentra, y ahí ocurre algo curioso.",
    "El vapor se pega a partículas diminutas de polvo, sal o polen, y se convierte en gotitas que sí podemos ver.",
    "Millones de esas gotitas juntas forman una nube. Por eso una nube no es humo ni algodón: es agua flotando.",
    "Las nubes altas y delgadas, como los cirros, están hechas de cristales de hielo y casi nunca dejan caer lluvia.",
    "Las nubes bajas y grises, en cambio, pueden cubrir todo el cielo y dejar una llovizna suave durante horas.",
    "Y luego están los cúmulos, esas nubes blancas que parecen montañas. Si crecen mucho, se vuelven tormentas.",
    "Dentro de una nube de tormenta el aire sube y baja con fuerza. Las gotas chocan, se unen y se hacen pesadas.",
    "Cuando pesan más de lo que el aire puede sostener, caen. Eso es la lluvia, así de sencillo y así de poderoso.",
    "A veces las gotas suben y bajan tantas veces que se congelan en capas, y entonces cae granizo.",
    "Los rayos aparecen porque el roce entre hielo y agua separa cargas eléctricas, como cuando frotas un globo.",
    "Un dato que sorprende: una nube mediana puede pesar tanto como cien elefantes, y aun así flota.",
    "Flota porque ese peso está repartido en un volumen enorme, y el aire que la rodea es todavía más denso.",
    "Si quieres predecir el clima en casa, mira la forma de las nubes por la mañana y cómo cambian en la tarde.",
    "Cúmulos que crecen hacia arriba después del mediodía suelen anunciar tormenta antes de que oscurezca.",
    "Un cielo con nubes muy altas y finas puede avisar que un frente frío llegará en uno o dos días.",
    "Esta semana, sal un momento, mira hacia arriba y trata de reconocer qué tipo de nube tienes encima.",
    "Gracias por escuchar este episodio de prueba de ATOMIVID. Nos encontramos en el próximo programa.",
  ];
  const en = [
    "Today we talk about how clouds form and why some of them bring rain while others simply drift by.",
    "It all starts with the sun, which warms the ocean, lakes and wet ground, turning part of that water into invisible vapor.",
    "That vapor rises with warm air. The higher it goes, the colder it gets, and that is where something curious happens.",
    "The vapor sticks to tiny particles of dust, salt or pollen, and becomes droplets that we can actually see.",
    "Millions of those droplets together make a cloud. So a cloud is not smoke or cotton: it is water floating in the sky.",
    "High, thin clouds such as cirrus are made of ice crystals and almost never produce rain at the ground.",
    "Low gray clouds can cover the whole sky and leave a gentle drizzle that lasts for hours.",
    "Then there are cumulus clouds, the white ones that look like mountains. When they grow tall, they turn into storms.",
    "Inside a storm cloud, air moves up and down with real force. Droplets collide, merge and become heavy.",
    "When they weigh more than the air can hold, they fall. That is rain, simple and powerful at the same time.",
    "Sometimes droplets travel up and down so many times that they freeze in layers, and hail comes down.",
    "Lightning appears because the friction between ice and water separates electric charges, like rubbing a balloon.",
    "Here is a surprising fact: an average cloud can weigh as much as a hundred elephants and still float.",
    "It floats because that weight is spread over a huge volume, and the surrounding air is even denser.",
    "If you want to forecast the weather at home, look at the shape of the clouds in the morning and again in the afternoon.",
    "Cumulus clouds that keep growing upward after noon often announce a storm before dark.",
    "A sky full of very high, thin clouds can mean a cold front will arrive within a day or two.",
    "This week, step outside for a moment, look up, and try to name the kind of cloud above you.",
    "Thank you for listening to this ATOMIVID test episode. See you in the next one.",
  ];
  const lines = lang === "es" ? es : en;
  const body = [...lines, ...lines.slice(0, 6)];
  const tag = (i: number) => (voices === 2 ? (lang === "es" ? `Voz ${(i % 2) + 1}: ` : `Voice ${(i % 2) + 1}: `) : "");
  return body.map((l, i) => `${tag(i)}${l}`).join("\n\n");
}

export type AudioVariant = { id: string; lang: "es" | "en"; voices: 1 | 2; voiceIds: string[]; title: string };
export const AUDIO_VARIANTS: Record<string, AudioVariant> = {
  "audio-real-es": { id: "audio-real-es", lang: "es", voices: 2, voiceIds: ["es-latam-m-profesional", "es-latam-f-profesional"], title: "QA real ES 2 voces" },
  "audio-real-en": { id: "audio-real-en", lang: "en", voices: 1, voiceIds: ["en-us-f-sarah"], title: "QA real EN 1 voice" },
};

/** Audio Podcast Studio de punta a punta: crear → configurar → listo → (real) autorizar y generar → progreso → MP3 → biblioteca. */
/** La beta privada responde 404 («No encontramos esa página») o redirige con ?error a cuentas sin acceso: es BLOQUEO, no PASS. */
export async function betaGate(c: RealCtx, met: PageMetrics | null, path: RegExp): Promise<string | null> {
  const u = new URL(c.page.url());
  const err = u.searchParams.get("error");
  const h = String(await c.page.locator("h1").first().innerText({ timeout: 3000 }).catch(() => ""));
  if (met?.httpStatus === 404 || /no encontramos esa página/i.test(h)) return `HTTP 404 en ${u.pathname} («${h.trim() || "sin título"}»)`;
  if (err || !path.test(u.pathname)) return `Redirigido a ${u.pathname}${err ? ` (${err})` : ""}`;
  return null;
}
const BETA_HINT = "solo el dueño, la cuenta interna o una cuenta listada en BETA_QA_USER_IDS (correo confirmado) entra a la beta";

export async function runAudioReal(c: RealCtx, v: AudioVariant): Promise<void> {
  const { page } = c;
  const sleep = c.sleep ?? ((ms: number) => page.waitForTimeout(ms));
  const title = `${v.title} ${c.jobId.slice(-6)}`;
  let projectUrl = "";
  await c.step("Abrir Audio Podcast y crear el episodio", async () => {
    const met = await c.goto("/dashboard/audio-studio");
    const gate = await betaGate(c, met, /\/dashboard\/audio-studio/);
    if (gate) {
      c.setHumanGate(`La cuenta QA no tiene acceso a Audio Podcast Studio (${BETA_HINT}).`);
      c.mark(c.cIdx(/Crea el episodio/), false, gate);
      return { state: "BLOCKED", detail: `Sin acceso a la beta: ${gate}` };
    }
    await page.getByLabel("Título").first().fill(title);
    await page.getByRole("button", { name: "Crear episodio" }).click();
    await page.waitForURL(/audio-studio\/[0-9a-f-]{36}/, { timeout: 30_000 });
    projectUrl = page.url();
    c.mark(c.cIdx(/Crea el episodio/), true, projectUrl.replace(c.baseUrl, ""));
    return { state: "PASS", detail: "Episodio creado." };
  });
  if (!projectUrl) return;
  await c.step(`Configurar ${v.lang.toUpperCase()} · ${v.voices} voz/voces · guion de ~3 min · tope USD 1`, async () => {
    await page.getByTestId("audio-language").selectOption(v.lang);
    await page.getByTestId(`audio-voices-${v.voices}`).check();
    for (let i = 0; i < v.voices; i++) await page.getByTestId(`audio-voice-${i}`).selectOption(v.voiceIds[i]);
    await page.getByTestId("audio-target").fill("5");
    await page.getByTestId("audio-budget").fill("1");
    await page.getByTestId("audio-script").fill(qaScript(v.lang, v.voices));
    await page.getByTestId("audio-save").click();
    await page.waitForFunction(() => !/Guardando/i.test(document.querySelector('[data-testid="audio-save-state"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    const ok = await page.getByTestId("audio-readiness-ok").isVisible().catch(() => false);
    const issues = ok ? [] : await page.getByTestId("audio-readiness").locator("li").allInnerTexts().catch(() => []);
    c.mark(c.cIdx(/Configura idioma/), ok, ok ? "Listo para autorizar." : issues.join(" · "));
    await c.metrics(200, 0);
    return ok ? { state: "PASS", detail: "Guion, voces, música y presupuesto completos." } : { state: "FAIL", detail: `No queda listo: ${issues.join(" · ") || "sin detalle"}` };
  });
  const estimate = usdOf(await page.getByTestId("audio-estimated-usd").innerText().catch(() => null));
  c.mark(c.cIdx(/costo antes/), estimate !== null, estimate !== null ? `Costo estimado visible: USD ${estimate.toFixed(2)}` : "Sin costo visible.");
  const readyBtn = page.getByTestId("audio-ready");
  if (await readyBtn.isVisible().catch(() => false) && await readyBtn.isEnabled().catch(() => false)) { await readyBtn.click(); await sleep(1500); }
  const gen = page.getByTestId("audio-generate");
  const disabledBefore = await gen.isDisabled().catch(() => null);
  c.mark(c.cIdx(/Sin autorizar/), disabledBefore === true, disabledBefore ? "«Generar» deshabilitado hasta autorizar el monto." : "«Generar» habilitado sin autorizar.");
  if (disabledBefore === false) c.setCritical("Se puede generar sin autorizar el cargo.");

  if (!c.real) {
    await c.step("Modo gratuito: se detiene antes de autorizar", async () => ({ state: "SKIP", detail: `Modo gratuito o interruptor apagado: no se autoriza el gasto (estimado USD ${estimate?.toFixed(2) ?? "?"}).` }));
    return;
  }
  // ── Generación real ──
  const authUsd = usdOf(await page.getByTestId("audio-authorize-usd").first().innerText().catch(() => null));
  const key = `${c.jobId}-${v.id}`;
  let reserved = false;
  await c.step("Reservar el gasto en el libro acumulado (tope USD 8.50)", async () => {
    if (!c.ledger) { c.setHumanGate("Sin libro de gasto no se genera."); return { state: "BLOCKED", detail: "Libro de gasto no disponible." }; }
    if (authUsd === null) return { state: "FAIL", detail: "La app no mostró el monto a autorizar." };
    const amount = Math.min(MODULE_CAP_USD["audio-podcast"], 1);
    if (authUsd > amount + 1e-9) return { state: "BLOCKED", detail: `La app pide USD ${authUsd.toFixed(2)} y la reserva máxima es USD ${amount.toFixed(2)}.` };
    const r = await c.ledger.reserve({ key, module: "audio-podcast", jobId: c.jobId, reservedUsd: amount, at: new Date().toISOString() });
    reserved = r.ok;
    return r.ok ? { state: "PASS", detail: `Reservado USD ${amount.toFixed(2)} (app pide ${authUsd.toFixed(2)}). ${r.reason}` } : { state: "BLOCKED", detail: r.reason };
  });
  if (!reserved) return;
  const samples: { t: number; pct: number | null; state?: string }[] = [];
  const t0 = Date.now();
  let finished = "timeout" as "ok" | "error" | "timeout";
  await c.step("Autorizar el monto y generar", async () => {
    await page.getByTestId("audio-authorize").check();
    await gen.click();
    c.act("gasto", `«Generar» pulsado con autorización de USD ${authUsd!.toFixed(2)}`);
    return { state: "PASS", detail: `Generación solicitada (USD ${authUsd!.toFixed(2)} autorizados).` };
  });
  await c.step("Seguir el progreso hasta el MP3 (máx. 25 min)", async () => {
    let n = 0;
    while (Date.now() - t0 < 25 * 60_000) {
      await sleep(10_000);
      if (++n % 6 === 0) await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      const pct = await page.locator('[data-testid="audio-progress"] [role="progressbar"]').getAttribute("aria-valuenow").catch(() => null);
      const st = await page.getByTestId("audio-generation-status").innerText().catch(() => "");
      samples.push({ t: Date.now() - t0, pct: pct === null ? null : Number(pct), state: st });
      if (await page.getByTestId("audio-result").isVisible().catch(() => false)) { finished = "ok"; break; }
      if (await page.getByTestId("audio-generation-error").isVisible().catch(() => false)) { finished = "error"; break; }
    }
    await writeFile(path.join(c.out, `progreso-${v.id}.json`), JSON.stringify(samples, null, 1)).catch(() => {});
    const inc = detectProgress({ module: "audio-podcast", screen: "/dashboard/audio-studio/[id]", repro: ["Generar episodio de ~3 min"] }, samples, { maxTotalMs: 25 * 60_000, maxStallMs: 8 * 60_000 });
    c.incidents.push(...inc);
    c.mark(c.cIdx(/progreso real/), samples.some((s) => s.pct !== null) && !inc.some((i) => i.kind === "wrong_progress"), `${samples.length} muestras; ${inc.map((i) => i.title).join(" · ") || "sin anomalías"}`);
    if (finished === "ok") return { state: "PASS", detail: `MP3 listo en ${Math.round((Date.now() - t0) / 1000)} s.` };
    const err = finished === "error" ? await page.getByTestId("audio-generation-error").innerText().catch(() => "error") : "No terminó en 25 min.";
    c.setCritical(`Audio Podcast no entregó el MP3: ${err}`);
    return { state: "FAIL", detail: err };
  });
  // Liquidar con el gasto que muestra la app (aunque haya fallado: puede haber gasto parcial).
  await c.step("Liquidar el gasto real (lo que muestra «Gastado»)", async () => {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    const spent = usdOf(await page.getByTestId("audio-spent-usd").innerText().catch(() => null));
    const value = spent ?? Math.min(MODULE_CAP_USD["audio-podcast"], 1);
    await c.ledger!.settle({ key, spentUsd: value, source: spent === null ? "reserva (la app no mostró «Gastado»)" : "interfaz «Gastado»", at: new Date().toISOString() });
    c.addSpend(value);
    return { state: spent === null ? "FAIL" : "PASS", detail: `Gasto liquidado USD ${value.toFixed(2)}${spent === null ? " (tope reservado: la app no mostró el gasto)" : ""}.` };
  });
  if (finished !== "ok") return;
  let file = "";
  await c.step("Reproducir y descargar el MP3", async () => {
    const played = await page.getByTestId("audio-player").evaluate(async (el: HTMLMediaElement) => { el.muted = true; el.preload = "auto"; try { await el.play(); await new Promise((r) => setTimeout(r, 2500)); return { ok: el.currentTime > 0 && !el.error, t: el.currentTime, d: el.duration }; } catch (e) { return { ok: false, t: 0, d: el.duration, err: String(e) }; } });
    c.mark(c.cIdx(/reproduce/), played.ok, JSON.stringify(played));
    const href = await page.getByTestId("audio-download").getAttribute("href");
    const res = await page.request.get(new URL(href, c.baseUrl).toString(), { timeout: 120_000 });
    const buf = Buffer.from(await res.body());
    file = path.join(c.out, `${v.id}.mp3`);
    await writeFile(file, buf);
    c.mark(c.cIdx(/descarga/), res.ok() && buf.length > 10_000, `HTTP ${res.status()} · ${buf.length} bytes`);
    return res.ok() && played.ok ? { state: "PASS", detail: `Reproduce (${played.t.toFixed(1)} s) y descarga ${buf.length} bytes.` } : { state: "FAIL", detail: `play=${played.ok} descarga HTTP ${res.status()}` };
  });
  if (file) await c.step("Medir el MP3 (ffprobe/ffmpeg)", async () => {
    await c.goto("/dashboard/audio-studio");
    const inLib = await page.getByTestId("audio-library-item").filter({ hasText: title }).first().isVisible().catch(() => false);
    const m = await c.probe(file, null, inLib);
    c.media.push(m);
    const est = 150; // ~3 min de guion; el estudio admite ±2 min respecto al objetivo de 5 min
    const inc = detectMedia({ module: "audio-podcast", screen: "MP3", repro: ["Descargar el MP3"] }, { file: path.basename(file), decodeOk: m.playable, container: m.container, durationSeconds: m.durationSeconds, requestedSeconds: null, meanVolumeDb: null, expectKind: "mp3" });
    c.incidents.push(...inc);
    const durOk = (m.durationSeconds ?? 0) >= est && (m.durationSeconds ?? 0) <= 7 * 60;
    c.mark(c.cIdx(/duración/), durOk && m.playable, `${m.durationSeconds?.toFixed(1)} s · ${m.container} · niveles ${m.musicLevels}`);
    c.mark(c.cIdx(/biblioteca/), inLib, inLib ? "Aparece en la biblioteca." : "No aparece en la biblioteca.");
    return m.playable && durOk && inLib && m.musicLevels !== "FAIL" && !inc.some((i) => i.severity === "P0") ? { state: "PASS", detail: `${m.durationSeconds?.toFixed(1)} s, ${m.container}, niveles ${m.musicLevels}, en biblioteca.` } : { state: "FAIL", detail: `reproducible=${m.playable} niveles=${m.musicLevels} dur=${m.durationSeconds} biblioteca=${inLib} ${inc.map((i) => i.title).join(" · ")}` };
  });
}

/** YouTube Studio (Long Form): recorrido completo como cliente (ver youtube-mission.ts). */
export async function runYoutubeReal(c: RealCtx): Promise<void> {
  await runYoutubeStudio(c);
}
