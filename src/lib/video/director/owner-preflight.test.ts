/**
 * Preflight determinista del propietario (chatgpt-30): Director de Reels y Long Form Cinematic V6 con dependencias
 * ficticias. Todo offline: cuentas sintéticas (.test), entornos literales, `fetch` bloqueado, ninguna llamada pagada.
 * Cada caso refleja una fila de la matriz GO/NO-GO: lo que Vercel muestra, lo que el worker decide y en qué orden
 * bloquea respecto al gasto. No cambia el producto: solo fija su comportamiento actual.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GeneratedScript } from "@/lib/providers/types";
import { DirectorInspectionPanel } from "@/components/video/DirectorInspectionPanel";
import { directorInspectionAllowed, directorRenderAllowed, resolveDirectorRender } from "./render-access";
import { cinematicDirectorRenderEnabled } from "./flag";
import { inspectReel } from "./reel-inspection";
import { directorRecordPath, parseDirectorRecord } from "@/lib/video/director-applied";
import { assertCinematicV6Account, CinematicV6AccessError, cinematicV6Enabled } from "@/lib/video/long-form/cinematic-v6-access";
import { productPlan } from "@/lib/video/long-form/product-plan";
import { getRealLongFormProviderNames, type ProductionPlanBeatInput } from "@/lib/video/long-form/production-plan";
import { PRODUCT_DEFAULT_PLAN_VERSION } from "@/lib/video/long-form/production-plan-types";
import { showcaseBeats, SHOWCASE_TOPIC } from "@/lib/video/long-form/showcase-fixtures";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("owner preflight: red prohibida"); }) as typeof fetch;
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

// Cuentas sintéticas (dominio reservado .test): ningún correo ni UUID real.
const OWNER = { email: "Propietario@Example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const OTHER = { email: "otra@example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const REEL = { mode: "visual", recorded_audio_path: null };
// Entorno de Vercel (páginas) y del worker (Actions) como objetos separados: la matriz cruza ambos.
const VERCEL_ON = { CINEMATIC_DIRECTOR_RENDER_ENABLED: "1", CINEMATIC_DIRECTOR_V2_ENABLED: "1", CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };
const WORKER_ON = { CINEMATIC_DIRECTOR_RENDER_ENABLED: "true", CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };
const WORKER_OFF = { CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };

const SCRIPT: GeneratedScript = {
  title: "Preflight sintético",
  segments: [
    { text: "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo?", visualQuery: "tired creator laptop", visualConcepts: ["tired creator at laptop", "person checking clock"], energy: "high" },
    { text: "Escribe tu idea y la aplicación prepara guion, voz e imágenes.", visualQuery: "app screen typing", visualConcepts: ["hands typing on phone app", "app pantalla"], energy: "medium" },
    { text: "Síguenos para enterarte del lanzamiento.", visualQuery: "person smiling at camera", visualConcepts: ["woman smiling at camera", "creator waving"], energy: "low" },
  ],
};

// ---------------------------------------------------------------- Reel Director

test("Reel GO: cuenta piloto confirmada + Reel visual + ambos entornos encendidos → panel con nota de render y worker dirige", async () => {
  assert.equal(directorInspectionAllowed(OWNER, REEL, VERCEL_ON), true);
  assert.equal(directorRenderAllowed(OWNER, REEL, VERCEL_ON), true);
  const panel = inspectReel(SCRIPT, { renderEnabled: directorRenderAllowed(OWNER, REEL, VERCEL_ON) });
  assert.ok(panel.status !== "error");
  assert.equal(panel.mode, "proposal");
  assert.equal(panel.executable, false);
  assert.equal(panel.paidCalls, 0, "la inspección nunca paga");
  assert.equal(panel.renderRequest, "eligible");
  assert.match(panel.note, /se solicita/i, "antes del render solo «solicitado»");
  assert.match(panel.note, /solo se confirma después del render/);
  assert.doesNotMatch(panel.note, /ese plan dirige el montaje/, "ninguna promesa categórica antes del resultado");
  let lookups = 0;
  assert.equal(await resolveDirectorRender(REEL, async () => { lookups++; return OWNER; }, WORKER_ON), true);
  assert.equal(lookups, 1, "el worker consulta la cuenta dueña una vez");
  assert.equal(networkCalls, 0);
});

test("Reel NO-GO (cuenta no piloto): sin panel en Revisión y montaje clásico en el worker, aunque todo esté encendido", async () => {
  assert.equal(directorInspectionAllowed(OTHER, REEL, VERCEL_ON), false, "la página no calcula ninguna inspección");
  assert.equal(directorRenderAllowed(OTHER, REEL, VERCEL_ON), false);
  assert.equal(await resolveDirectorRender(REEL, async () => OTHER, WORKER_ON), false);
  assert.equal(await resolveDirectorRender(REEL, async () => ({ ...OWNER, email_confirmed_at: null }), WORKER_ON), false, "correo sin confirmar");
  assert.equal(await resolveDirectorRender(REEL, async () => OWNER, { ...WORKER_ON, CINEMATIC_DIRECTOR_PILOT_EMAILS: "" }), false, "lista vacía en el worker");
});

test("Reel NO-GO (Vercel ON, worker OFF): Revisión no puede prometer el Director; el worker monta en clásico; «aplicado» nunca aparece", async () => {
  // C1: the review page only knows Vercel's environment, so before the render it may say "eligible / requested",
  // never that the Director WILL drive the montage, and never "applied".
  const panel = inspectReel(SCRIPT, { renderEnabled: directorRenderAllowed(OWNER, REEL, VERCEL_ON) });
  assert.ok(panel.status !== "error");
  assert.equal(panel.renderRequest, "eligible", "nota de Revisión calculada con el entorno de Vercel: elegible, no aplicado");
  assert.doesNotMatch(panel.note, /dirige el montaje|dirigirá|\baplicado\b/, "sin promesa: el worker decide con su propia configuración");
  assert.match(panel.note, /montaje (es el )?clásico/, "dice qué pasa si el worker no coincide");
  assert.match(panel.note, /solo se confirma después del render/);
  const html = renderToStaticMarkup(createElement(DirectorInspectionPanel, { inspection: panel }));
  assert.match(html, /elegible/);
  assert.doesNotMatch(html, /\baplicado\b|dirige el montaje/, "el panel previo nunca muestra «aplicado» como estado");
  assert.match(html, /Estado antes del render: elegible · se solicitará al generar/);
  const proposalOnly = inspectReel(SCRIPT, { renderEnabled: false });
  assert.ok(proposalOnly.status !== "error");
  assert.equal(proposalOnly.renderRequest, "proposal_only");
  assert.match(proposalOnly.note, /No cambia el guion ni el render/);
  let lookups = 0;
  assert.equal(await resolveDirectorRender(REEL, async () => { lookups++; return OWNER; }, WORKER_OFF), false, "sin interruptor en Actions no hay Director");
  assert.equal(lookups, 0, "ni siquiera consulta la cuenta");
  // Con directorRender=false generate-video.ts no escribe director.json: la página del video no tiene registro que leer.
  assert.equal(parseDirectorRecord(null), null);
  assert.equal(parseDirectorRecord({ ok: false, blockers: [] }), null, "un registro bloqueado tampoco se presenta como aplicado");
});

test("Reel NO-GO inverso (Vercel OFF, worker ON): Revisión no muestra nada, el worker sí dirige y la página del video oculta el panel", async () => {
  const vercelOff = { CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };
  assert.equal(directorInspectionAllowed(OWNER, REEL, vercelOff), false);
  assert.equal(directorRenderAllowed(OWNER, REEL, vercelOff), false);
  assert.equal(await resolveDirectorRender(REEL, async () => OWNER, WORKER_ON), true);
  assert.equal(cinematicDirectorRenderEnabled(vercelOff), false, "la página del video condiciona el panel a este interruptor en Vercel");
});

test("Reel: la decisión del worker se toma del row y la cuenta, tras reservar suministro y antes de generar; el Director no añade llamadas pagadas", () => {
  const runJob = src("src/lib/video/run-job.ts");
  const reserve = runJob.indexOf("await reserveJobSupply(");
  const decide = runJob.indexOf("const directorRender = mode === \"visual\" && await resolveDirectorRender(row");
  const generate = runJob.indexOf("await generateVideoFromScript({");
  assert.ok(reserve > 0 && decide > reserve && generate > decide, "orden: reserva → decisión del Director → generación");
  assert.match(runJob, /console\.log\("\[atomivid:director\]", JSON\.stringify\(\{ requestId, directorRender \}\)\)/, "observable en el log del worker");
  const gv = src("src/lib/video/generate-video.ts");
  assert.match(gv, /if \(directorRender && cinematicDirectorRenderEnabled\(\)\) \{\n\s+const \{ directReel, directorBlockMessage \} = await import\("@\/lib\/video\/director\/reel-render"\);/, "el worker vuelve a leer su propio interruptor");
  assert.match(gv, /if \(!directed\.ok\) throw new Error\(directorBlockMessage\(directed\.blockers\)\);/, "un plan no montable detiene el render de forma explícita");
  assert.doesNotMatch(gv.slice(gv.indexOf("6b. Director"), gv.indexOf("7. Ensamblar")), /ledger|paidCall|fetch\(/, "el bloque del Director no paga ni descarga");
  assert.equal(directorRecordPath("u/req/attempt-2/reel-1080x1920.mp4"), "u/req/attempt-2/director.json");
});

// ---------------------------------------------------------------- Long Form Cinematic V6

const providers = getRealLongFormProviderNames();
const IMPACT: Record<string, [number, string]> = {
  "quiet street": [3, "opens the story in its place and year"],
  "Fixture Person portrait": [3, "introduces the protagonist"],
  "front page": [2, "the record that carries the event"],
  "the gazette headline": [3, "the reveal of the event"],
  schematic: [1, "the evidence explained calmly"],
};
function withImpact(beats: ProductionPlanBeatInput[]): (ProductionPlanBeatInput & { purpose: string })[] {
  return beats.map((b) => ({
    ...b, purpose: `${b.type} purpose`,
    visuals: (b.visuals as Record<string, unknown>[]).map((v) => {
      const key = Object.keys(IMPACT).find((k) => String(v.description).startsWith(k));
      return key ? { ...v, impact: IMPACT[key][0], impactReason: IMPACT[key][1] } : v;
    }),
  }));
}
const V6_VERCEL = { CINEMATIC_V6_ENABLED_EMAILS: "propietario@example.test" };
const V6_WORKER_EMPTY = { CINEMATIC_V6_ENABLED_EMAILS: "" };

test("Long Form GO v3: guion antiguo (sin impacto) con cuenta habilitada → plan estándar v3 y el worker no consulta la cuenta", async () => {
  const r = productPlan({ beats: showcaseBeats, topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: cinematicV6Enabled(OWNER, V6_VERCEL) });
  assert.equal(r.engine, "default");
  assert.equal(r.plan.version, PRODUCT_DEFAULT_PLAN_VERSION);
  assert.equal(r.plan.version, 3);
  assert.match(r.reason, /guion anterior a V6/);
  let lookups = 0;
  await assertCinematicV6Account(r.plan, async () => { lookups++; return null; }, V6_WORKER_EMPTY);
  assert.equal(lookups, 0, "v1–v4 no consultan nada: el entorno del worker es irrelevante para v3");
});

test("Long Form GO v6: guion nuevo con impacto + cuenta habilitada → plan v6; el worker con la misma lista lo deja pasar", async () => {
  const r = productPlan({ beats: withImpact(showcaseBeats), topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: cinematicV6Enabled(OWNER, V6_VERCEL) });
  assert.equal(r.engine, "cinematic-v6");
  assert.equal(r.plan.version, 6);
  assert.ok(r.plan.sequences && r.plan.sequences.length > 0);
  await assertCinematicV6Account(r.plan, async () => OWNER, V6_VERCEL);
  assert.equal(networkCalls, 0);
});

test("Long Form NO-GO: plan v6 confirmado en Vercel, worker sin permiso → bloquea con el mensaje fijo ANTES de reservar o pagar", async () => {
  const r = productPlan({ beats: withImpact(showcaseBeats), topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: true });
  assert.equal(r.plan.version, 6);
  for (const [label, loadUser, env] of [
    ["worker sin lista", async () => OWNER, V6_WORKER_EMPTY],
    ["lista sin la cuenta", async () => OTHER, V6_VERCEL],
    ["correo sin confirmar", async () => ({ ...OWNER, email_confirmed_at: null }), V6_VERCEL],
    ["consulta de cuenta falla", async () => { throw new Error("auth down"); }, V6_VERCEL],
  ] as const) {
    await assert.rejects(assertCinematicV6Account(r.plan, loadUser, env), (e: unknown) => e instanceof CinematicV6AccessError && /No se ejecutó ninguna llamada pagada/.test(e.message), label);
  }
  const runJob = src("src/lib/video/run-job.ts");
  const assertAt = runJob.indexOf("await assertCinematicV6Account(longFormPlan");
  const reserve = runJob.indexOf("await reserveJobSupply(");
  const generate = runJob.indexOf("await generateLongFormVideoFromScript({");
  assert.ok(assertAt > 0 && assertAt < reserve && reserve < generate, "orden: comprobación de cuenta → reserva → generación");
});

test("Long Form: cuenta sin V6 en Vercel nunca ve v6 aunque el guion lo declare; CINEMATIC_V6_ALL_USERS exige correo confirmado", () => {
  const r = productPlan({ beats: withImpact(showcaseBeats), topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: cinematicV6Enabled(OTHER, V6_VERCEL) });
  assert.equal(r.plan.version, 3);
  assert.match(r.reason, /no está habilitado para esta cuenta/);
  assert.equal(cinematicV6Enabled(OTHER, { CINEMATIC_V6_ALL_USERS: "true" }), true);
  assert.equal(cinematicV6Enabled({ ...OTHER, email_confirmed_at: null }, { CINEMATIC_V6_ALL_USERS: "true" }), false);
  assert.equal(cinematicV6Enabled(OWNER, { CINEMATIC_V6_ALL_USERS: "TRUE " }), true, "trim + minúsculas");
  assert.equal(cinematicV6Enabled(OWNER, { CINEMATIC_V6_ALL_USERS: "1" }), false, "solo la palabra true activa a todos");
});

// ---------------------------------------------------------------- Coherencia de la UI (texto de las páginas)

test("UI: Revisión calcula nota y panel con la decisión real del usuario; Configurar nombra el motor por la misma función; «aplicado» solo con director.json", () => {
  const review = src("src/app/dashboard/review/[id]/page.tsx");
  assert.match(review, /directorInspectionAllowed\(user, data\)\s*\?\s*inspectReel\(data\.script_json, \{ renderEnabled: directorRenderAllowed\(user, data\) \}\)\s*:\s*null/);
  const configure = src("src/app/dashboard/long-form/configure/[id]/page.tsx");
  assert.match(configure, /const cinematicV6 = cinematicV6Enabled\(user\);/);
  assert.match(configure, /engine: engine\.engine === "cinematic-v6" \? "Cinematic V6 \(plan v6\)" : `Plan estándar \(v\$\{plans\.balanced\.version\}\)`/);
  assert.match(configure, /\{cinematicV6 && <p role="status"/, "el aviso de motor solo aparece a cuentas habilitadas");
  assert.match(configure, /Cinematic V6 activo para este guion \(plan v6\)\. Requiere material verificado y curado/);
  assert.match(configure, /Este guion se producirá con el plan estándar \(v\$\{PRODUCT_DEFAULT_PLAN_VERSION\}\): \$\{engine\.reason\}/);
  for (const route of ["src/app/api/generate/[id]/confirm-production/route.ts", "src/app/api/generate/[id]/refresh-capacity/route.ts"]) {
    assert.match(src(route), /cinematicV6: cinematicV6Enabled\(user\)/, `${route} usa la misma decisión que Configurar`);
  }
  const videos = src("src/app/dashboard/videos/[id]/page.tsx");
  assert.match(videos, /const directorRows = cinematicDirectorRenderEnabled\(\) && request\.status === "completed" && request\.video_path && request\.mode !== "long_form" && request\.mode !== "avatar"\s*\?\s*await loadDirectorApplied\(/);
  assert.match(videos, /\{directorRows && directorRows\.length > 0 && <DirectorAppliedPanel rows=\{directorRows\} \/>\}/);
  const panel = src("src/components/video/DirectorAppliedPanel.tsx");
  assert.match(panel, /Director: recetas aplicadas \(\{rows\.length\} planos\)/);
  // Un director.json bien formado y ok:true es lo único que produce filas; cualquier otra cosa no muestra nada.
  const rows = parseDirectorRecord({ ok: true, applied: [{ shotId: "s1", anchorText: "a", recipeId: "reel-hook-visual", planned: { movement: "push_in" }, applied: { startSeconds: 0, endSeconds: 2, motion: "push_in", transitionIn: "cut", transitionOut: "cut", label: "ilustrativa" } }] });
  assert.equal(rows?.length, 1);
  assert.equal(parseDirectorRecord({ ok: true, applied: [{ shotId: "s1" }] }), null);
});

test("render.yml: Reel recibe interruptor (var) y piloto (secret) salvo Long Form; Long Form recibe la lista V6 (secret) y ALL_USERS (var)", () => {
  const yml = src(".github/workflows/render.yml");
  assert.match(yml, /CINEMATIC_V6_ENABLED_EMAILS: \$\{\{ secrets\.CINEMATIC_V6_ENABLED_EMAILS \}\}/);
  assert.match(yml, /CINEMATIC_V6_ALL_USERS: \$\{\{ vars\.CINEMATIC_V6_ALL_USERS \}\}/);
  assert.match(yml, /CINEMATIC_DIRECTOR_RENDER_ENABLED: \$\{\{ \(github\.event\.client_payload\.mode != 'long_form' && inputs\.mode != 'long_form'\) && vars\.CINEMATIC_DIRECTOR_RENDER_ENABLED \|\| '' \}\}/);
  assert.match(yml, /CINEMATIC_DIRECTOR_PILOT_EMAILS: \$\{\{ \(github\.event\.client_payload\.mode != 'long_form' && inputs\.mode != 'long_form'\) && secrets\.CINEMATIC_DIRECTOR_PILOT_EMAILS \|\| '' \}\}/);
  assert.doesNotMatch(yml, /CINEMATIC_DIRECTOR_V2_ENABLED/, "el interruptor de inspección es solo de Vercel: el worker no lo necesita");
});
