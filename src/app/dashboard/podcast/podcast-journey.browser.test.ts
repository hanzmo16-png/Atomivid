// Interacción REAL en Chromium (Playwright) con los componentes reales del podcast: clics, efectos, sessionStorage y
// recargas. Servicios simulados: fetch y router (no hay HTTP/DB reales). Se omite si Playwright o Chromium no existen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Superficie mínima de Playwright que usa esta prueba (el proyecto no depende de playwright; se usa el instalado en el entorno).
type Locator = { fill(v: string): Promise<void>; click(): Promise<void>; inputValue(): Promise<string>; selectOption(v: string): Promise<unknown>; waitFor(): Promise<void>; count(): Promise<number>; isDisabled(): Promise<boolean>; isEnabled(): Promise<boolean>; isVisible(): Promise<boolean> };
type Page = {
  goto(u: string): Promise<unknown>; evaluate<R, A>(fn: (a: A) => R | Promise<R>, arg: A): Promise<R>; getByLabel(t: string | RegExp): Locator; getByRole(r: string, o: { name: string }): Locator;
  getByText(t: string): Locator; textContent(sel: string): Promise<string | null>; waitForFunction(fn: () => boolean): Promise<unknown>; addInitScript(fn: () => void): Promise<void>; close(): Promise<void>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type PW = { chromium: { launch(o?: { executablePath?: string }): Promise<Browser> } };
const req = createRequire(__filename);
const pw: PW | null = (() => {
  const roots = [process.cwd(), process.env.PLAYWRIGHT_NODE_PATH, (() => { try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return undefined; } })(), "/opt/node-tools/node_modules"].filter(Boolean) as string[];
  for (const r of roots) { try { return req(req.resolve("playwright", { paths: [r] })) as PW; } catch { /* next */ } }
  return null;
})();
const skip = !pw && "Playwright no disponible";

let server: Server, base = "", browser: Browser;
const voices = [{ voiceId: "v1", name: "Lucía", language: "es", accent: null, gender: null, previewUrl: null }, { voiceId: "v2", name: "Mateo", language: "es", accent: null, gender: null, previewUrl: null }];
const newProps = (owner: string) => ({ ownerId: owner, voices, voicesError: null, usdPer1kChars: 0.3, maxChars: 50000 });
const panelProps = (over: Record<string, unknown> = {}) => ({ episodeId: "e1", status: "none", stage: null, stalled: false, error: null, canRequest: true, playUrl: null, downloadUrl: null, sizeMb: null, minutes: null,
  remainingUsd: 0, budgetUsd: 2, scheduledAt: null, spentUsd: null, historicalUsd: 0, runBudgetUsd: null, minimumRunUsd: 0, runColumn: true, seconds: null, checks: null,
  reviewStatus: "pending", reviewNote: null, publishStatus: "held", review: { id: "e1", title: "Caso Roswell", language: "es", source: "tts", script: null, voice_id: "v1", voice_name: "Lucía", status: "ready" }, confirmToken: "huella-1", ...over });

before(async () => {
  if (!pw) return;
  const out = mkdtempSync(path.join(tmpdir(), "podcast-ui-"));
  await (await import("esbuild")).build({ entryPoints: [path.join(__dirname, "__browser__/journey-entry.tsx")], bundle: true, outfile: path.join(out, "bundle.js"), platform: "browser", format: "iife",
    jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' }, banner: { js: "globalThis.process=globalThis.process||{env:{}};" }, logLevel: "error" });
  const js = readFileSync(path.join(out, "bundle.js"));
  server = createServer((r, s) => { if (r.url === "/bundle.js") { s.writeHead(200, { "content-type": "text/javascript" }); s.end(js); } else { s.writeHead(200, { "content-type": "text/html" }); s.end('<!doctype html><div id="app"></div><script src="/bundle.js"></script>'); } });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: "/opt/pw-browsers/chromium" });
});
after(async () => { await browser?.close(); server?.close(); });

type Hooks = { __mount: (k: string, p: unknown) => void; __fetches: Array<{ url: string; body: Record<string, unknown> }>; __pushes: string[]; __signedOut: number; __fetchReply: unknown };
async function open(page: Page, kind: string, props: unknown) {
  await page.goto(base);
  await page.evaluate((a: { k: string; p: unknown }) => (window as unknown as Hooks).__mount(a.k, a.p), { k: kind, p: props });
}
const fetches = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fetches, null);
const storageKeys = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).sort(), null);

test("crear → revisar → volver conserva y edita → crear: envía lo revisado, navega al episodio y borra el borrador", { skip }, async () => {
  const page = await browser.newPage();
  await open(page, "new", newProps("user-a"));
  await page.getByLabel("Título").fill("Caso Roswell");
  await page.getByLabel("Guion").fill("Primera versión del guion, con más de veinte caracteres.");
  await page.getByLabel(/^Voz/).selectOption("v2");
  await page.getByRole("button", { name: "Revisar antes de crear" }).click();
  await page.getByText("Revisa el episodio").waitFor();
  assert.match(await page.textContent("body") ?? "", /voz guardada «Mateo»/);
  await page.getByRole("button", { name: "Volver a editar" }).click();
  assert.equal(await page.getByLabel("Título").inputValue(), "Caso Roswell", "volver conserva el título");
  assert.equal(await page.getByLabel(/^Voz/).inputValue(), "v2", "volver conserva la voz");
  await page.getByLabel("Guion").fill("Segunda versión del guion, corregida antes de crear.");
  await page.getByRole("button", { name: "Revisar antes de crear" }).click();
  assert.match(await page.textContent("body") ?? "", /Segunda versión del guion/);
  assert.deepEqual(await storageKeys(page), ["atomivid:podcast:borrador:v2:user-a"], "el borrador vive con el dueño mientras se revisa");
  await page.getByRole("button", { name: "Crear episodio (no genera ni cobra)" }).click();
  await page.waitForFunction(() => (window as unknown as Hooks).__pushes.length === 1);
  const f = await fetches(page);
  assert.equal(f.length, 1); assert.equal(f[0].url, "/api/podcast");
  assert.deepEqual(f[0].body, { title: "Caso Roswell", script: "Segunda versión del guion, corregida antes de crear.", language: "es", voiceId: "v2" });
  assert.deepEqual(await page.evaluate(() => (window as unknown as Hooks).__pushes, null), ["/dashboard/podcast/ep-nuevo"]);
  assert.deepEqual(await storageKeys(page), [], "creado el episodio, el borrador se borra");
  await page.close();
});

test("borrador: se recupera tras recargar para A; B no lo ve y lo descarta; al volver A ya no existe (política declarada)", { skip }, async () => {
  const page = await browser.newPage();
  await open(page, "new", newProps("user-a"));
  await page.getByLabel("Título").fill("Borrador de A");
  await page.getByLabel("Guion").fill("Texto privado de la cuenta A, más de veinte caracteres.");
  await open(page, "new", newProps("user-a"));
  await page.getByText("Recuperamos el borrador").waitFor();
  assert.equal(await page.getByLabel("Título").inputValue(), "Borrador de A");
  await open(page, "new", newProps("user-b"));
  assert.equal(await page.getByLabel("Título").inputValue(), "", "B no recibe el borrador de A");
  assert.equal(await page.getByText("Recuperamos el borrador").count(), 0);
  assert.ok(!(await page.textContent("body") ?? "").includes("Texto privado de la cuenta A"));
  assert.deepEqual(await storageKeys(page), [], "el borrador de A se descartó al montar B");
  await open(page, "new", newProps("user-a"));
  assert.equal(await page.getByLabel("Título").inputValue(), "", "volver a A no restaura nada: se descartó al entrar B");
  await page.close();
});

test("borrador antiguo sin dueño se descarta; voz guardada inexistente exige elegir (sin sustitución silenciosa)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => {
    sessionStorage.setItem("atomivid:podcast:nuevo-episodio:v1", JSON.stringify({ v: 1, mode: "tts", title: "Sin dueño", script: "x".repeat(40), language: "es", voiceId: "v1" }));
    sessionStorage.setItem("atomivid:podcast:borrador:v2:user-a", JSON.stringify({ v: 2, owner: "user-a", mode: "tts", title: "Con voz borrada", script: "y".repeat(40), language: "es", voiceId: "voz-borrada" }));
  }, null);
  await open(page, "new", newProps("user-a"));
  assert.equal(await page.getByLabel("Título").inputValue(), "Con voz borrada");
  assert.equal(await page.getByLabel(/^Voz/).inputValue(), "", "no se cambia a la primera voz en silencio");
  await page.getByText("ya no está disponible").waitFor();
  assert.ok(await page.getByRole("button", { name: "Revisar antes de crear" }).isDisabled());
  await page.getByLabel(/^Voz/).selectOption("v1");
  assert.ok(await page.getByRole("button", { name: "Revisar antes de crear" }).isEnabled());
  assert.deepEqual(await storageKeys(page), ["atomivid:podcast:borrador:v2:user-a"], "el formato sin dueño se eliminó");
  await page.close();
});

test("fallo de almacenamiento: sin sessionStorage el formulario funciona y crea", { skip }, async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => { for (const m of ["getItem", "setItem", "removeItem", "key"] as const) Storage.prototype[m] = () => { throw new Error("bloqueado"); }; });
  await open(page, "new", newProps("user-a"));
  await page.getByLabel("Título").fill("Sin almacenamiento");
  await page.getByLabel("Guion").fill("El formulario no depende del almacenamiento del navegador.");
  await page.getByRole("button", { name: "Revisar antes de crear" }).click();
  await page.getByRole("button", { name: "Crear episodio (no genera ni cobra)" }).click();
  await page.waitForFunction(() => (window as unknown as Hooks).__fetches.length === 1);
  assert.equal((await fetches(page))[0].body.title, "Sin almacenamiento");
  await page.close();
});

test("cerrar sesión borra todos los borradores de podcast de la pestaña y conserva el resto", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => { sessionStorage.setItem("atomivid:podcast:borrador:v2:user-a", "{}"); sessionStorage.setItem("atomivid:podcast:nuevo-episodio:v1", "{}"); sessionStorage.setItem("otra-app", "1"); }, null);
  await page.evaluate(() => (window as unknown as Hooks).__mount("signout", {}), null);
  await page.getByRole("button", { name: "Salir" }).click();
  await page.waitForFunction(() => (window as unknown as Hooks).__signedOut === 1);
  assert.deepEqual(await storageKeys(page), ["otra-app"]);
  await page.close();
});

test("producir: revisar muestra lo escrito, volver lo conserva, confirmar envía la huella; 409 vuelve al formulario con el aviso", { skip }, async () => {
  const page = await browser.newPage();
  await open(page, "panel", panelProps());
  await page.getByLabel("Presupuesto total del episodio (USD)").fill("3.5");
  await page.getByRole("button", { name: "Revisar y producir" }).click();
  await page.getByText("Revisa antes de producir").waitFor();
  assert.match(await page.textContent("body") ?? "", /USD 3\.50/);
  assert.equal((await fetches(page)).length, 0, "revisar no envía nada");
  await page.getByRole("button", { name: "Volver a editar" }).click();
  assert.equal(await page.getByLabel("Presupuesto total del episodio (USD)").inputValue(), "3.5");
  await page.evaluate(() => { (window as unknown as Hooks).__fetchReply = { status: 409, body: { error: "El episodio cambió desde tu revisión. Vuelve a revisarlo y confirma de nuevo." } }; }, null);
  await page.getByRole("button", { name: "Revisar y producir" }).click();
  await page.getByRole("button", { name: "Confirmar y producir" }).click();
  await page.getByText("El episodio cambió desde tu revisión").waitFor();
  const f = await fetches(page);
  assert.equal(f.length, 1); assert.equal(f[0].url, "/api/podcast/e1/video");
  assert.deepEqual(f[0].body, { budgetUsd: 3.5, runBudgetUsd: null, scheduleAt: null, confirm: "huella-1" });
  assert.ok(await page.getByRole("button", { name: "Revisar y producir" }).isVisible(), "tras el rechazo vuelve al formulario");
  await page.close();
});

test("programar y cancelar: la revisión incluye el inicio programado; cancelar envía solo {cancel:true}", { skip }, async () => {
  const page = await browser.newPage();
  await open(page, "panel", panelProps());
  await page.getByLabel("Programar inicio (opcional)").fill("2026-10-20T10:30");
  await page.getByRole("button", { name: "Revisar y programar" }).click();
  assert.match(await page.textContent("body") ?? "", /programado:/);
  await page.getByRole("button", { name: "Confirmar y programar" }).click();
  await page.waitForFunction(() => (window as unknown as Hooks).__fetches.length === 1);
  const body = (await fetches(page))[0].body;
  assert.equal(body.confirm, "huella-1"); assert.equal(typeof body.scheduleAt, "string");
  await open(page, "panel", panelProps({ status: "scheduled", scheduledAt: "2026-10-20T10:30:00.000Z" }));
  await page.getByRole("button", { name: "Cancelar programación" }).click();
  await page.waitForFunction(() => (window as unknown as Hooks).__fetches.length === 1);
  assert.deepEqual((await fetches(page))[0].body, { cancel: true });
  await page.close();
});
