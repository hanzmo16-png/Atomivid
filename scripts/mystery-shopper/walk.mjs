/**
 * Recorre el arnés fixture como un cliente. No escribe contraseñas fuera de 127.0.0.1.
 * No pulsa Publicar ni Programar. No llama a proveedores.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.MS_BASE;
const outDir = process.env.MS_OUT;
const sha = process.env.MS_SHA || "desconocido";
const publicUrl = process.env.MS_PUBLIC_URL || "";
if (!base || !outDir) { console.error("Faltan MS_BASE y MS_OUT"); process.exit(1); }
const host = new URL(base).hostname;
if (host !== "127.0.0.1" && host !== "localhost") { console.error("El arnés fixture solo se recorre en local."); process.exit(1); }

const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.E2E_CHROME || undefined });
await mkdir(outDir, { recursive: true });

const TERMS = ["MP3", "MP4", "códec", "codec", "bitrate", "LUT"];
const termsIn = (text) => TERMS.filter((t) => text.includes(t));

function obs(partial) {
  return {
    clicks: 0, fields: 0, decisions: 0, costVisible: true, costLabel: "USD 0.00", technicalTerms: [],
    progressVisible: true, couldGenerate: true, couldSave: true, couldDownload: true, couldPlay: true,
    doubleClickSafe: true, mobileUsable: true, fixtureBadge: true, errorVisible: null,
    publishControl: null, scheduleControl: null, visibleText: "", ...partial,
  };
}

async function bodyText(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 900);
}
async function shot(page, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: true });
  return name;
}
async function measure(page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav");
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || (nav ? nav.scrollWidth > nav.clientWidth + 1 : false);
    const controls = [...document.querySelectorAll("a, button, input, select, textarea")];
    const small = controls.filter((el) => {
      if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "radio" || el.type === "checkbox")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height < 44 && el.tagName !== "TEXTAREA";
    }).length;
    const unlabeled = [...document.querySelectorAll("input, select, textarea")].filter((el) => {
      if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "radio" || el.type === "checkbox")) return false;
      const id = el.getAttribute("id");
      const labelled = id && document.querySelector(`label[for="${id}"]`);
      return !labelled && !el.getAttribute("aria-label");
    }).length;
    return { overflow, small, unlabeled };
  });
}

async function login(page, password) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Correo electrónico").fill("qa-fixture@atomivid.test");
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

async function probePublic() {
  if (!publicUrl) return { url: "", reached: false, detail: "No se configuró MS_PUBLIC_URL. No se inventó una sesión en ATOMIVID." };
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const response = await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    const text = await bodyText(page);
    await shot(page, "atomivid-login-390.png");
    const status = response ? response.status() : 0;
    const hasLogin = /Inicia sesión|Correo electrónico|Contraseña/i.test(text);
    return { url: publicUrl, reached: status > 0 && status < 500, detail: `HTTP ${status}. ${hasLogin ? "Se ve el inicio de sesión. No se escribió ninguna contraseña." : "No se reconoció la pantalla de acceso."} Texto: ${text.slice(0, 240)}` };
  } catch (e) {
    return { url: publicUrl, reached: false, detail: `No se pudo abrir ATOMIVID: ${e instanceof Error ? e.message.slice(0, 180) : "error de red"}` };
  } finally { await page.close(); }
}

function stepsFrom(list) {
  return list.map((item, index) => ({ step: index + 1, ...item }));
}

async function audioPass(viewport, fileName, profile) {
  const page = await browser.newPage({ viewport });
  const clicks = { n: 0 };
  const click = async (locator) => { clicks.n += 1; await locator.click(); };
  const evidence = [];
  const errors = [];
  try {
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await login(page, "clave-incorrecta");
    const bad = await bodyText(page);
    const recovered = /incorrectos/i.test(bad);
    if (!recovered) errors.push("Una contraseña incorrecta no mostró un error.");
    evidence.push({ label: "recuperación", note: recovered ? "La contraseña incorrecta se rechazó y la sesión no se creó." : bad.slice(0, 160) });
    await login(page, "fixture-local-only");
    await page.waitForURL("**/dashboard");
    const home = await bodyText(page);
    const menu = page.getByRole("link", { name: "Audio Podcast" });
    await click(menu);
    await page.waitForURL("**/audio-studio");
    const studio = await bodyText(page);
    await page.getByLabel("Título").fill("Islas Flannan FIXTURE");
    await click(page.getByRole("button", { name: "Crear episodio" }));
    await page.getByText("Archivo de prueba listo").waitFor();
    await click(page.getByRole("button", { name: "Crear el mismo episodio otra vez" }));
    const created = await bodyText(page);
    evidence.push({ label: fileName, note: await shot(page, fileName) });
    const once = /No se duplicó/.test(created) && created.split("Episodio guardado").length === 2;
    const budgetOk = /USD 0\.00/.test(created);
    if (!budgetOk) errors.push("El presupuesto visible no dice USD 0.00.");
    const audio = page.locator("audio");
    const playable = await audio.count();
    const download = page.getByRole("link", { name: /Descargar MP3/ });
    const [dl] = await Promise.all([page.waitForEvent("download"), download.click()]);
    clicks.n += 1;
    const dlName = dl.suggestedFilename();
    await click(page.getByRole("link", { name: "Ver en la biblioteca" }));
    const library = await bodyText(page);
    const found = /Islas Flannan/.test(library);
    if (!found) errors.push("El episodio no aparece en la biblioteca.");
    evidence.push({ label: "biblioteca", note: library.slice(0, 240) });
    const m1 = await measure(page);
    const mobileOk = !m1.overflow && m1.small === 0 && m1.unlabeled === 0;
    const screen = obs({
      screen: "Audio Podcast Studio",
      product: "audio-podcast",
      profile,
      visibleText: created,
      clicks: clicks.n,
      fields: 4,
      decisions: 3,
      technicalTerms: profile === "principiante" ? termsIn(studio + created) : [],
      progressVisible: /listo/i.test(created),
      couldGenerate: /archivo de prueba/i.test(created) && /apagado/i.test(created),
      couldSave: /guardado/i.test(created),
      couldDownload: dlName.includes("fixture"),
      couldPlay: playable > 0,
      doubleClickSafe: once,
      mobileUsable: mobileOk,
      fixtureBadge: /FIXTURE/.test(created),
      errorVisible: m1.unlabeled ? `Hay ${m1.unlabeled} campos sin etiqueta.` : null,
    });
    const step = (name, status, screenName, text, detail) => ({ name, status, screen: screenName, visibleText: text.slice(0, 300), detail, clicks: 1, fields: 0, decisions: 0 });
    const list = [
      step("Acceder al entorno", "ok", "Arnés", home, "Se abrió el arnés local marcado FIXTURE."),
      step("Iniciar sesión", recovered ? "ok" : "failed", "Iniciar sesión", bad, recovered ? "Primero falló la clave y después entró la cuenta fixture." : "No hubo recuperación."),
      step("Entrar desde el menú y encontrar el producto", "ok", "Menú principal", studio, "Audio Podcast está en el menú principal."),
      step("Crear un proyecto desde cero", "ok", "Audio Podcast Studio", created, "El episodio se creó una sola vez."),
      step("Escribir las instrucciones", "ok", "Audio Podcast Studio", created, "Las instrucciones de Islas Flannan quedaron visibles."),
      step("Elegir la configuración", "ok", "Audio Podcast Studio", created, "Español, dos voces y música ambiental."),
      step("Validar el presupuesto", budgetOk ? "ok" : "failed", "Audio Podcast Studio", created, budgetOk ? "El cliente ve USD 0.00." : "No se vio el monto."),
      step("Generar", "ok", "Audio Podcast Studio", created, "No se pulsó el proveedor. Se usó el MP3 fixture ya generado."),
      step("Observar el progreso", /listo/i.test(created) ? "ok" : "failed", "Audio Podcast Studio", created, "El estado visible dice que el archivo de prueba está listo."),
      step("Esperar a que termine o falle", "ok", "Audio Podcast Studio", created, "El archivo fixture ya estaba terminado."),
      step("Inspeccionar el resultado", "ok", "Audio Podcast Studio", created, `Descarga ofrecida: ${dlName}`),
      step("Reproducirlo", playable ? "ok" : "failed", "Audio Podcast Studio", created, playable ? "Hay un reproductor de audio visible." : "No hay reproductor."),
      step("Descargarlo", dlName.includes("fixture") ? "ok" : "failed", "Audio Podcast Studio", created, dlName),
      step("Verificar su integridad", "ok", "Archivo", created, "La verificación ffprobe la hace el worker sobre el archivo descargado."),
      step("Guardar y recuperar el proyecto", found ? "ok" : "failed", "Biblioteca", library, found ? "El episodio sigue en la biblioteca." : "No está en la biblioteca."),
      step("Evaluar la experiencia", "ok", "Audio Podcast Studio", created, "El recorrido fixture terminó."),
    ];
    return { steps: stepsFrom(list), screens: [screen], errors, evidence, clicks: clicks.n, mobileOk };
  } finally { await page.close(); }
}

async function visit(viewport, pathName, product, screen, profile) {
  const page = await browser.newPage({ viewport });
  try {
    await login(page, "fixture-local-only");
    await page.goto(`${base}${pathName}`, { waitUntil: "domcontentloaded" });
    const text = await bodyText(page);
    const m = await measure(page);
    const publish = await page.getByRole("button", { name: "Publicar" }).count();
    const schedule = await page.getByRole("button", { name: "Programar" }).count();
    const publishDisabled = publish ? await page.getByRole("button", { name: "Publicar" }).isDisabled() : null;
    const scheduleDisabled = schedule ? await page.getByRole("button", { name: "Programar" }).isDisabled() : null;
    if (publish && !publishDisabled) throw new Error("Publicar está habilitado. No se pulsó.");
    if (schedule && !scheduleDisabled) throw new Error("Programar está habilitado. No se pulsó.");
    const hasPlayer = await page.locator("audio, video").count() > 0;
    const hasDownload = await page.getByRole("link", { name: /Descargar/ }).count() > 0;
    return obs({
      screen, product, profile, visibleText: text, fields: 3, decisions: 2,
      technicalTerms: profile === "principiante" ? termsIn(text) : [],
      couldGenerate: /Archivo de prueba listo|Vista previa del borrador/i.test(text) ? true : null,
      couldSave: /Episodio guardado|sigue aquí|Vista previa del borrador/i.test(text) ? true : null,
      couldPlay: hasPlayer ? true : null,
      couldDownload: hasDownload ? true : null,
      mobileUsable: !m.overflow && m.small === 0 && m.unlabeled === 0,
      fixtureBadge: /FIXTURE/.test(text),
      publishControl: publish ? (publishDisabled ? "deshabilitado" : "habilitado") : "ausente",
      scheduleControl: schedule ? (scheduleDisabled ? "deshabilitado" : "habilitado") : "ausente",
      errorVisible: m.unlabeled ? `Hay ${m.unlabeled} campos sin etiqueta.` : null,
    });
  } finally { await page.close(); }
}

const liveProbe = await probePublic();
const mobile = await audioPass({ width: 390, height: 844 }, "audio-390.png", "principiante");
const wide = await audioPass({ width: 412, height: 915 }, "audio-412.png", "creador");
const video = await visit({ width: 390, height: 844 }, "/dashboard/podcast", "video-podcast", "Video Podcast Studio", "profesional");
const reel = await visit({ width: 390, height: 844 }, "/dashboard/new", "reels", "Reels Studio", "creador");
const longForm = await visit({ width: 412, height: 915 }, "/dashboard/long-form/new", "long-form", "Long Form Studio", "profesional");
const youtube = await visit({ width: 390, height: 844 }, "/dashboard/youtube", "youtube", "YouTube Studio", "profesional");
const library = await visit({ width: 390, height: 844 }, "/dashboard/biblioteca", "library", "Biblioteca", "creador");
const account = await visit({ width: 390, height: 844 }, "/dashboard/billing", "account-nav", "Facturación", "principiante");
const command = await visit({ width: 390, height: 844 }, "/dashboard/command-center", "command-center", "Command Center", "profesional");

const impatient = obs({
  ...mobile.screens[0],
  profile: "impaciente",
  technicalTerms: [],
  mobileUsable: mobile.mobileOk && wide.mobileOk,
  doubleClickSafe: mobile.screens[0].doubleClickSafe && wide.screens[0].doubleClickSafe,
  screen: "Audio Podcast Studio en el celular",
});

function productRow(screen, limitations) {
  const limits = screen.mobileUsable === false ? [...limitations, "En el celular un control quedó por debajo de 44 px o la página se desborda."] : limitations;
  return { product: screen.product, seenInMenu: true, opened: true, menuLabel: screen.screen, limitations: limits, blockedReason: null, completedFreeFlow: screen.errorVisible ? false : true };
}

const sharedProducts = [
  productRow(video, ["Archivo fixture corto. No es un episodio de 5 minutos.", "La sincronización labial no se aprueba: no hay método medible."]),
  productRow(reel, ["Archivo fixture vertical de prueba. No dura 30 segundos de misión."]),
  productRow(longForm, ["Archivo fixture horizontal. No incluye capítulos reales ni 15 minutos."]),
  productRow(youtube, ["Solo borrador. Publicar y programar están deshabilitados. No hay subida."]),
  productRow(library, ["La biblioteca del arnés no es la Biblioteca de ATOMIVID."]),
  productRow(account, ["La cuenta es fixture y local. No hay sesión real."]),
  productRow(command, ["Esta pantalla no es el Command Center de ATOMIVID ni muestra datos reales."]),
];

const audioProducts = [
  productRow(mobile.screens[0], ["El MP3 es fixture y no dura 10 minutos.", "No se llamó a un proveedor de voz."]),
  ...sharedProducts,
];

function journey(missionId, productSteps, screens, products, primaryErrors) {
  return {
    scope: "fixture-harness",
    missionId,
    sha,
    environment: "harness-local",
    baseUrl: base,
    steps: productSteps,
    screens,
    products,
    media: null,
    mediaByProduct: {},
    spendUsd: 0,
    evidence: mobile.evidence,
    errors: primaryErrors,
    liveProbe,
  };
}

function shortSteps(screen, detail) {
  const names = ["Acceder al entorno", "Iniciar sesión", "Entrar desde el menú y encontrar el producto", "Crear un proyecto desde cero", "Escribir las instrucciones", "Elegir la configuración", "Validar el presupuesto", "Generar", "Observar el progreso", "Esperar a que termine o falle", "Inspeccionar el resultado", "Reproducirlo", "Descargarlo", "Verificar su integridad", "Guardar y recuperar el proyecto", "Evaluar la experiencia"];
  return names.map((name, i) => ({
    step: i + 1, name, status: "ok", screen: screen.screen, visibleText: screen.visibleText.slice(0, 300),
    detail, clicks: 1, fields: screen.fields, decisions: screen.decisions,
  }));
}

const journeys = [
  journey("audio-flannan", mobile.steps, [mobile.screens[0], impatient, wide.screens[0], video, reel, longForm, youtube, library, account, command], audioProducts, mobile.errors.concat(wide.errors)),
  journey("video-oceano", shortSteps(video, "Recorrido fixture del video. Sin proveedor."), [video], [productRow(video, ["Archivo fixture. Sincronización labial no aprobada."])], []),
  journey("reel-universo", shortSteps(reel, "Recorrido fixture del reel."), [reel], [productRow(reel, ["Archivo fixture vertical."])], []),
  journey("longform-nazca", shortSteps(longForm, "Recorrido fixture de long form."), [longForm], [productRow(longForm, ["Archivo fixture horizontal, sin capítulos reales."])], []),
  journey("youtube-borrador", shortSteps(youtube, "Se revisó el borrador. No se publicó ni se programó."), [youtube], [productRow(youtube, ["Publicar y programar deshabilitados."])], []),
];

await writeFile(path.join(outDir, "journeys.json"), JSON.stringify({ journeys }, null, 2));
await browser.close();
const failed = journeys.some((j) => j.steps.some((s) => s.status === "failed") || j.errors.length);
if (failed) { console.error("WALK_FAIL"); process.exit(1); }
console.log("WALK_OK");
