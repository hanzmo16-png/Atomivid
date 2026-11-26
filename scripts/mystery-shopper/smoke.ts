/**
 * Mystery Shopper 3.0 — smoke gratuito (USD 0): solo HTTP público, sin sesión, sin proveedores, sin escrituras.
 * Comprueba que ATOMIVID responde, que las rutas privadas piden login y que la API admin no se abre sin sesión.
 * Entorno: MS_TARGET_URL (defecto https://atomivid.vercel.app), MS_OUT_DIR (opcional), VERCEL_AUTOMATION_BYPASS_SECRET (solo Previews).
 * Exit 0 = todo PASS; 4 = hay P0/P1.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectNavigationFailure, sanitize, sortIncidents, type Incident } from "../../src/lib/mystery-shopper/v3/detect";

type Check = { name: string; url: string; expect: string; status: number | null; ms: number; location: string | null; pass: boolean };

export async function smoke(target: string, fetchImpl: typeof fetch = fetch, bypass?: string) {
  const headers: Record<string, string> = { "user-agent": "AtomividMysteryShopper/3.0 smoke" };
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const checks: Check[] = [];
  const incidents: Incident[] = [];
  const probe = async (name: string, p: string, expect: string, ok: (s: number | null, loc: string | null) => boolean, module: Incident["module"]) => {
    const t0 = Date.now();
    const res = await fetchImpl(`${target}${p}`, { redirect: "manual", headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const status = res ? res.status : null, location = res?.headers.get("location") ?? null, ms = Date.now() - t0;
    const pass = ok(status, location);
    checks.push({ name, url: p, expect, status, ms, location: location ? sanitize(location.replace(/^https?:\/\/[^/]+/, "")) : null, pass });
    if (!pass) {
      const ctx = { module, screen: p, repro: [`curl -sI ${target}${p}`] };
      const nav = detectNavigationFailure(ctx, { url: p, httpStatus: status, timedOut: status === null, redirectedToLogin: false, authenticated: false });
      incidents.push(nav ?? { id: `${module}-smoke-${checks.length}`, module, kind: "regression", severity: "P1", title: `${name}: se esperaba ${expect} y llegó ${status}${location ? ` → ${location}` : ""}`, evidence: [`HTTP ${status}`], screenshot: null, logs: [], repro: ctx.repro, rootCause: null, fixProposal: "Revisar middleware/ruta." });
    }
    return res;
  };
  const is2xx = (s: number | null) => s !== null && s >= 200 && s < 300;
  const toLogin = (s: number | null, l: string | null) => s !== null && s >= 300 && s < 400 && /\/login/.test(l ?? "");
  await probe("Portada", "/", "HTTP 2xx", (s) => is2xx(s), "account-nav");
  await probe("Login", "/login", "HTTP 2xx", (s) => is2xx(s), "account-nav");
  await probe("Registro", "/register", "HTTP 2xx", (s) => is2xx(s) || (s !== null && s >= 300 && s < 400), "account-nav");
  await probe("Panel sin sesión pide login", "/dashboard", "redirección a /login", toLogin, "account-nav");
  await probe("Audio Studio sin sesión pide login", "/dashboard/audio-studio", "redirección a /login", toLogin, "audio-podcast");
  await probe("Podcast sin sesión pide login", "/dashboard/podcast", "redirección a /login", toLogin, "video-podcast");
  await probe("Reels sin sesión pide login", "/dashboard/new", "redirección a /login", toLogin, "reels");
  await probe("Long Form sin sesión pide login", "/dashboard/long-form/new", "redirección a /login", toLogin, "youtube");
  await probe("Command Center sin sesión pide login", "/dashboard/command-center", "redirección a /login", toLogin, "command-center");
  await probe("API admin cerrada sin sesión", "/api/admin/mystery-shopper", "HTTP 401/403 (o login)", (s, l) => s === 401 || s === 403 || toLogin(s, l), "command-center");
  const sorted = sortIncidents(incidents);
  return { version: "mystery-shopper-3.0-smoke", target, at: new Date().toISOString(), spendUsd: 0, checks, incidents: sorted, pass: checks.filter((c) => c.pass).length, total: checks.length, critical: sorted.filter((i) => i.severity === "P0" || i.severity === "P1").length };
}

if (process.argv[1] && /smoke\.ts$/.test(process.argv[1])) {
  const target = (process.env.MS_TARGET_URL || "https://atomivid.vercel.app").replace(/\/$/, "");
  if (!/^https:\/\/(atomivid(-[a-z0-9-]+)?\.vercel\.app|atomicvid\.app)$/.test(target)) { console.error("Destino no permitido: solo ATOMIVID."); process.exit(1); }
  smoke(target, fetch, process.env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined).then(async (r) => {
    const out = JSON.stringify(r, null, 2);
    console.log(`RESULTADO ${r.pass}/${r.total} PASS · críticos ${r.critical}`);
    for (const c of r.checks) console.log(`${c.pass ? "PASS" : "FAIL"}\t${c.status}\t${c.ms}ms\t${c.name}`);
    if (process.env.MS_OUT_DIR) { await mkdir(process.env.MS_OUT_DIR, { recursive: true }); await writeFile(path.join(process.env.MS_OUT_DIR, "smoke.json"), out); }
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Smoke ${r.target}\n\n${r.pass}/${r.total} PASS · críticos ${r.critical}\n\n| Resultado | HTTP | ms | Comprobación |\n|---|---|---|---|\n${r.checks.map((c) => `| ${c.pass ? "PASS" : "FAIL"} | ${c.status} | ${c.ms} | ${c.name} |`).join("\n")}\n`, { flag: "a" });
    process.exit(r.critical ? 4 : 0);
  });
}
