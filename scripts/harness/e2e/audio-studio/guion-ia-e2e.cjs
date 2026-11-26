/**
 * Guion con IA (P0 2026-11-25) — recorrido de cliente en móvil, USD 0: arnés local con AUDIO_STUDIO_SCRIPT_AI=fixture
 * (escritura determinista sin red) y la voz de prueba local. Caso de aceptación: «Las líneas y momias de Nazca»,
 * 30 minutos, dos voces y notas de dirección personalizadas. Dispositivos 390x844 y 412x915.
 *
 * Comprueba: no existe la plantilla «Generar estructura de guion»; el botón escribe el guion COMPLETO (escaleta + 3
 * bloques) con progreso real (pasos guardados por el servidor); recargar a mitad retoma desde el último paso; el
 * guion usa tema y notas, tiene las dos voces y ~30 min, sin pautas ni marcadores narrables; queda editable; una pauta
 * añadida a mano bloquea «Generar MP3» antes de consumir créditos; sin desbordamiento ni controles tapados.
 *
 *   E2E_OUT=<dir> E2E_BASE=http://127.0.0.1:3300 node guion-ia-e2e.cjs
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3300";
const OUT = path.resolve(process.env.E2E_OUT ?? "guion-ia-out"); fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "movil-390x844": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, userAgent: ANDROID_UA },
  "movil-412x915": { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: ANDROID_UA },
};
const TOPIC = "Las líneas y momias de Nazca";
const NOTES = "Tono de documental riguroso pero cercano, para público general. Explica qué está comprobado y qué es especulación. Incluye la polémica de las supuestas momias de tres dedos y por qué la comunidad científica las rechaza.";
const MARKERS = /Reemplaza esta pauta|Desarrolla esta idea|Responde, pregunta o añade un matiz|\(Reemplaza|unas \d+ palabras|\[|\*\*|Notas de dirección/;
let fails = 0, passes = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const summary = {};
  try {
    for (const [dev, opts] of Object.entries(DEVICES)) {
      const ctx = await browser.newContext({ ...opts, locale: "es-MX" });
      await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
      const p = await ctx.newPage(); p.setDefaultTimeout(90000);
      const steps = [], generar = [];
      p.on("response", async (r) => {
        if (!/\/guion$/.test(r.url()) || r.request().method() !== "POST") return;
        const req = JSON.parse(r.request().postData() || "{}"); const b = await r.json().catch(() => null);
        steps.push({ action: req.action, status: r.status(), step: b?.scriptStep ? `${b.scriptStep.step}/${b.scriptStep.steps}` : null });
      });
      p.on("request", (r) => { if (/\/api\/audio-studio\/projects\/[0-9a-f-]+$/.test(r.url()) && r.method() === "POST" && /"generar"/.test(r.postData() ?? "")) generar.push(r.url()); });
      // Cada paso tarda ~1,2 s (como una llamada real corta): se puede ver el avance y recargar a mitad.
      await p.route("**/guion", async (route) => { if (/"paso"/.test(route.request().postData() ?? "")) await new Promise((ok) => setTimeout(ok, 1200)); await route.continue(); });

      await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
      await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
      await p.locator('header a[href="/dashboard/audio-studio"]:visible').first().click(); await p.waitForURL(/\/dashboard\/audio-studio$/);
      await p.fill("#audio-new-title", TOPIC);
      await p.locator('[data-testid="audio-new"] input[name=voiceCount][value="2"]').check();
      await p.locator('[data-testid="audio-new"] button[type=submit]').click();
      await p.waitForURL(/\/dashboard\/audio-studio\/[0-9a-f-]{36}$/); await p.getByTestId("audio-editor").waitFor();
      const id = p.url().split("/").pop();

      check(`[${dev}] ya no existe «Generar estructura de guion»`, (await p.getByText("Generar estructura de guion").count()) === 0 && (await p.getByTestId("audio-outline").count()) === 0);
      await p.getByTestId("audio-target").fill("30"); await p.getByTestId("audio-target").blur();
      await p.getByTestId("audio-notes").fill(NOTES);
      await p.getByTestId("audio-budget").fill("50");
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado", null, { timeout: 30000 });
      const btn = p.getByTestId("audio-ai-write");
      check(`[${dev}] botón «Escribir el guion completo con IA» visible y táctil`, await btn.isVisible() && ((await btn.boundingBox())?.height ?? 0) >= 44);
      await shot(p, `${dev}-01-antes`);
      await btn.click();

      // Progreso real: el panel muestra el paso guardado y el porcentaje sube.
      await p.getByTestId("audio-ai-progress").waitFor();
      const seen = new Set();
      const sample = async () => { const v = await p.locator('[data-testid="audio-ai-progress"] [role=progressbar]').getAttribute("aria-valuenow").catch(() => null); if (v) seen.add(Number(v)); };
      await sample();
      check(`[${dev}] el editor queda bloqueado mientras la IA escribe`, await p.getByTestId("audio-script").isDisabled());
      await shot(p, `${dev}-02-progreso`);
      if (dev === "movil-412x915") {
        // Recargar a mitad: el trabajo sigue desde el último paso guardado.
        await p.waitForFunction(() => Number(document.querySelector('[data-testid="audio-ai-progress"] [role=progressbar]')?.getAttribute("aria-valuenow")) >= 25, null, { timeout: 30000 });
        await sample();
        await p.reload(); await p.getByTestId("audio-editor").waitFor();
        const after = await p.locator('[data-testid="audio-ai-progress"] [role=progressbar]').getAttribute("aria-valuenow").catch(() => null);
        check(`[${dev}] tras recargar, el progreso guardado sigue (≥ 25 %) y se retoma solo`, Number(after) >= 25, after);
        await shot(p, `${dev}-03-retomado`);
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 60000 && await p.getByTestId("audio-ai-progress").count()) { await sample(); await p.waitForTimeout(150); }
      await p.getByTestId("audio-ai-done").waitFor({ timeout: 60000 });
      const pcts = [...seen].sort((a, b) => a - b);
      check(`[${dev}] el porcentaje avanzó por pasos reales (${pcts.join(" → ")} %)`, pcts.length >= 2 && pcts[0] < pcts[pcts.length - 1], pcts);
      const pasos = steps.filter((s) => s.action === "paso" && s.status === 200).map((s) => s.step);
      check(`[${dev}] servidor: escaleta + 3 bloques = 4 pasos (${pasos.join(", ")})`, pasos.at(-1) === "4/4" && new Set(pasos).size === pasos.length && pasos.length >= (dev === "movil-412x915" ? 3 : 4), steps);

      const script = await p.getByTestId("audio-script").inputValue();
      const lines = script.split("\n").filter((l) => l.trim() && !l.startsWith("## "));
      check(`[${dev}] guion completo sobre el tema (no plantilla)`, /Nazca/.test(script) && /momias/.test(script) && lines.length > 40, script.slice(0, 200));
      check(`[${dev}] la escaleta usa las notas de dirección (especulación, momias de tres dedos)`, /especulaci[oó]n/i.test(script) && /dedos/i.test(script));
      check(`[${dev}] estructura temática con títulos «## » (no se narran)`, (script.match(/^## /gm) ?? []).length === 3);
      check(`[${dev}] dos voces presentes`, lines.some((l) => l.startsWith("Voz 1:")) && lines.some((l) => l.startsWith("Voz 2:")));
      check(`[${dev}] sin pautas, instrucciones ni marcadores narrables`, !MARKERS.test(script), (script.match(MARKERS) ?? [])[0]);
      const stats = await p.getByTestId("audio-script-stats").innerText();
      const mins = Number((stats.match(/≈ ([\d.,]+) min/) ?? [])[1]?.replace(",", "."));
      check(`[${dev}] duración calculada ≈ 30 min (${mins})`, mins >= 25 && mins <= 36, stats);
      check(`[${dev}] aviso de resultado con minutos escritos frente a pedidos`, /para 30 pedidos/.test(await p.getByTestId("audio-ai-done").innerText()));
      check(`[${dev}] sin avisos de narración en la validación previa`, !/se narraría/.test(await p.getByTestId("audio-production").innerText()));
      await shot(p, `${dev}-04-terminado`);

      // Editable después.
      await p.getByTestId("audio-script").fill(`${script}\n\nVoz 1: Una línea añadida a mano por la persona.`);
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado", null, { timeout: 30000 });
      check(`[${dev}] el guion se puede editar y guardar`, /añadida a mano/.test((await p.evaluate(async (x) => (await (await fetch(`/api/audio-studio/projects/${x}`)).json()).script, id))));

      // Validación previa al consumo de créditos de voz: una pauta añadida bloquea «Generar MP3».
      const cur = await p.getByTestId("audio-script").inputValue();
      await p.getByTestId("audio-script").fill(`${cur}\n\nVoz 2: Desarrolla esta idea con un ejemplo cotidiano. (Reemplaza esta pauta por unas 300 palabras.)`);
      await p.waitForFunction(() => /se narraría/.test(document.querySelector('[data-testid="audio-readiness"]')?.textContent ?? ""), null, { timeout: 10000 });
      check(`[${dev}] una pauta en el guion se marca antes de gastar`, /se narraría/.test(await p.getByTestId("audio-readiness").innerText()));
      const gen = p.getByTestId("audio-generate");
      check(`[${dev}] «Generar MP3» bloqueado con la pauta`, (await gen.count()) === 0 || await gen.isDisabled());
      await p.getByTestId("audio-script").fill(cur);
      await p.waitForFunction(() => document.querySelector('[data-testid="audio-save-state"]')?.textContent === "Guardado", null, { timeout: 30000 });

      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`[${dev}] sin desbordamiento horizontal`, overflow <= 0, overflow);
      check(`[${dev}] ninguna generación de audio enviada (sin créditos consumidos)`, generar.length === 0, generar);
      summary[dev] = { id, steps, pcts, minutes: mins, lines: lines.length, chars: script.length };
      fs.writeFileSync(path.join(OUT, `${dev}-guion.txt`), script);
      await ctx.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, "guion-ia-summary.json"), JSON.stringify({ passes, fails, summary }, null, 2));
  console.log(`RESULTADO ${fails ? "FALLA" : "OK"} — ${passes} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
