/**
 * Observador de CSP para los arneses de navegador (SOLO en ramas de ensayo; se carga con NODE_OPTIONS=--require).
 * Envuelve playwright.chromium.launch: cada página de cada contexto registra en $CSP_OBSERVER_LOG (jsonl) los mensajes de
 * consola de Content-Security-Policy, separando la política APLICADA (bloquea) del modo INFORME (solo avisa).
 * No cambia el comportamiento de las pruebas: solo escucha. Sin la variable CSP_OBSERVER_LOG no hace nada.
 */
const Module = require("node:module");
const fs = require("node:fs");
const LOG = process.env.CSP_OBSERVER_LOG;
if (LOG) {
  const script = (process.argv[1] ?? "").split("/").slice(-2).join("/");
  const record = (page, text) => {
    let url = ""; try { url = page.url(); } catch { /* página cerrada */ }
    try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), script, report: /report[- ]only/i.test(text), url: url.slice(0, 200), text: text.slice(0, 400) }) + "\n"); } catch { /* sin disco: no interfiere */ }
  };
  const listen = (page) => { if (page.__csp) return; page.__csp = true;
    // Registro de cobertura: cada página observada deja una línea, para que «0 mensajes» nunca sea un falso negativo.
    try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), script, kind: "page" }) + "\n"); } catch { /* sin disco */ }
    page.on("console", (m) => { const t = m.text(); if (/Content Security Policy/i.test(t)) record(page, t); }); };
  const attach = (ctx) => { if (!ctx || ctx.__csp) return; ctx.__csp = true; ctx.on("page", listen); for (const p of ctx.pages()) listen(p); };
  const wrapBrowser = (b) => {
    if (!b || b.__csp) return b; b.__csp = true;
    const nc = b.newContext.bind(b); b.newContext = async (...a) => { const c = await nc(...a); attach(c); return c; };
    const np = b.newPage.bind(b); b.newPage = async (...a) => { const p = await np(...a); attach(p.context()); listen(p); return p; };
    return b;
  };
  const wrapType = (t) => {
    if (!t || t.__csp) return; t.__csp = true;
    const l = t.launch.bind(t); t.launch = async (...a) => wrapBrowser(await l(...a));
    if (t.launchPersistentContext) { const lp = t.launchPersistentContext.bind(t); t.launchPersistentContext = async (...a) => { const c = await lp(...a); attach(c); return c; }; }
  };
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    const out = orig.apply(this, arguments);
    try { if (out && typeof out === "object" && out.chromium && typeof out.chromium.launch === "function") wrapType(out.chromium); } catch { /* nunca rompe la carga */ }
    return out;
  };
}
