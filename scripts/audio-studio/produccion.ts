/**
 * Audio Podcast Studio 1.0 — verificación en producción (USD 0, sin proveedores de pago).
 *
 *   npx tsx scripts/audio-studio/produccion.ts publico <base-url>
 *     Sin sesión ni secretos: la ruta y la API existen (redirección a /login, 401, 415) y los módulos anteriores
 *     siguen respondiendo, en escritorio y con agente de móvil.
 *
 *   npx tsx scripts/audio-studio/produccion.ts episodio
 *     Con SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e INTERNAL_PRODUCTION_OWNER_USER_ID (secretos ya existentes, solo
 *     lectura de su valor): deja cargado el episodio inicial del dueño si falta (idempotente; nunca pisa una versión
 *     editada) y lo vuelve a leer. Solo toca videos/audio-studio/v1/<dueño>/. No imprime secretos ni ids completos.
 */
import { createClient } from "@supabase/supabase-js";
import { AUDIO_STUDIO_BUCKET, AUDIO_STUDIO_PREFIX, storageStore } from "../../src/lib/audio-studio/store";
import { ensureSeed, seedId, view } from "../../src/lib/audio-studio/service";
import { SEED_EPISODE } from "../../src/lib/audio-studio/seed";
import { isUuid } from "../../src/lib/audio-studio/model";

let fails = 0, passes = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) passes++; else fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 300)}`); };
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

async function publico(base: string) {
  for (const [ua, label] of [[undefined, "escritorio"], [MOBILE_UA, "móvil"]] as const) {
    const h: Record<string, string> = ua ? { "user-agent": ua } : {};
    const get = (p: string, init: RequestInit = {}) => fetch(new URL(p, base), { redirect: "manual", ...init, headers: { ...h, ...(init.headers as Record<string, string> | undefined) } });
    const login = await get("/login"); check(`[${label}] /login responde 200`, login.status === 200, login.status);
    const page = await get("/dashboard/audio-studio");
    check(`[${label}] /dashboard/audio-studio existe y sin sesión redirige a /login`, [302, 303, 307, 308].includes(page.status) && /\/login/.test(page.headers.get("location") ?? ""), [page.status, page.headers.get("location")]);
    const editor = await get("/dashboard/audio-studio/00000000-0000-4000-8000-000000000000");
    check(`[${label}] editor sin sesión redirige a /login`, [302, 303, 307, 308].includes(editor.status) && /\/login/.test(editor.headers.get("location") ?? ""), [editor.status, editor.headers.get("location")]);
    const api = await get("/api/audio-studio/projects");
    const apiBody = await api.json().catch(() => null) as { error?: string } | null;
    check(`[${label}] API del estudio desplegada: 401 sin sesión`, api.status === 401 && apiBody?.error === "No autenticado", [api.status, apiBody]);
    const one = await get("/api/audio-studio/projects/00000000-0000-4000-8000-000000000000");
    check(`[${label}] API de proyecto: 401 sin sesión`, one.status === 401, one.status);
    const csrf = await get("/api/audio-studio/projects", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    check(`[${label}] POST que no es JSON → 415`, csrf.status === 415, csrf.status);
    for (const p of ["/", "/dashboard", "/dashboard/podcast", "/dashboard/long-form/new", "/dashboard/new", "/dashboard/billing"]) {
      const r = await get(p);
      check(`[${label}] ${p} sigue respondiendo (${r.status})`, r.status < 500 && (r.status === 200 || [302, 303, 307, 308].includes(r.status)), r.status);
    }
  }
}

async function episodio() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = process.env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim().toLowerCase();
  if (!url || !key || !owner || !isUuid(owner)) { check("secretos disponibles (URL, clave de servicio, id del dueño)", false, "faltan"); return; }
  const bucket = createClient(url, key, { auth: { persistSession: false } }).storage.from(AUDIO_STUDIO_BUCKET);
  const store = storageStore(bucket as never);
  const before = (await bucket.list(`${AUDIO_STUDIO_PREFIX}/${owner}`, { limit: 200 })).data?.length ?? 0;
  console.log(`proyectos del dueño antes: ${before}`);
  const r = await ensureSeed({ store }, owner);
  console.log(`episodio inicial: ${r === "created" ? "creado ahora" : "ya existía (no se tocó)"}`);
  const p = await store.get(owner, seedId(owner));
  check("episodio inicial guardado y legible en producción", !!p);
  if (!p) return;
  const v = view(p);
  check("título exacto", p.title === SEED_EPISODE.title, p.title);
  check("una voz: masculina profesional, español latinoamericano", p.voiceCount === 1 && p.voices[0] === "es-latam-m-profesional", p.voices);
  check("duración objetivo 18 min; estimado 18 ± 1", p.targetMinutes === 18 && Math.abs(v.estimate.estimatedMinutes - 18) <= 1, v.estimate.estimatedMinutes);
  check("música de fondo inteligente", p.music.mode === "inteligente", p.music);
  check(`presupuesto: estimado USD ${v.estimate.estimatedUsd.toFixed(2)} ≤ tope USD ${p.budgetUsd.toFixed(2)}; gastado USD 0.00`, v.estimate.withinBudget && p.spentUsd === 0);
  check("proyecto editable (no archivado)", !p.archivedAt);
  check(r === "created" ? "listo para revisar (sin pendientes)" : "estado actual informado", r !== "created" || v.readiness.length === 0, v.readiness);
  const after = (await bucket.list(`${AUDIO_STUDIO_PREFIX}/${owner}`, { limit: 200 })).data?.length ?? 0;
  check("solo se añadió, como mucho, el episodio inicial", after - before === (r === "created" ? 1 : 0), [before, after]);
}

const [mode, base] = process.argv.slice(2);
(mode === "publico" ? publico(base ?? "https://atomicvid.app") : mode === "episodio" ? episodio() : Promise.reject(new Error("modo: publico | episodio")))
  .then(() => { console.log(`RESULTADO ${fails === 0 ? "OK" : "FALLA"}  ${passes} PASS · ${fails} FAIL`); process.exit(fails === 0 ? 0 : 1); })
  .catch((e) => { console.log("FAIL  excepción", e instanceof Error ? e.message : e); process.exit(1); });
