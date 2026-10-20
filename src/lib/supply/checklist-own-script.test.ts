/**
 * Checklist antes de generar + guion propio (2026-10-18). ROJO = main (bb3e4549) / PR #148: a Reel could only
 * be written by Atomicvid, avatar text was counted with its own 2.5 words/s rule, and the checklist did not
 * exist. VERDE = one counting module for screen and server, the customer's narration is never rewritten, and
 * every refusal happens before the paid call (proven with call counters).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { acceptanceWindow, fitForDuration, fitForMaximum, MAX_NARRATION_CHARS, narrationStats, normalizeNarration, recommendedCapacity, splitIntoScenes } from "@/lib/video/narration-fit";
import { buildOwnScriptDraft, draftFit, hasRenderableScript, isOwnScriptDraft, narrationPreserved, scriptSourceOf } from "@/lib/video/own-script";
import { formProduction, type FormProductionInput } from "@/lib/video/form-production";
import { OwnScriptPlanError, planOwnScript } from "@/lib/ai/script";
import { runScriptGeneration } from "@/lib/video/script-generation";
import { pendingRequestCta } from "@/lib/video/request-view";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { checkProduction, ownScriptPlanCeilingUsd, productionDemands, scriptGenerationCeilingUsd, type CheckRequest } from "./production-check";
import type { ScriptOpRow } from "./script-intent";

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const words = (n: number, word = "palabra") => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? `${word}.` : word)).join(" ");
const OFFERED = [30, 60, 90];
const FLAGS: FeatureFlags = { ...getFeatureFlags(), imageGenerationEnabled: false, visualDirectorEnabled: false, musicProvider: "curated-library" } as FeatureFlags;
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "cliente@example.test", email_confirmed_at: "2026-10-01" };

// ---------------------------------------------------------------- 3. Contador y validación de duración

test("calibración 30/60/90: capacidad recomendada centrada en el objetivo del guion generado (targetWordsFor)", () => {
  assert.deepEqual(OFFERED.map(d => [recommendedCapacity(d).minWords, recommendedCapacity(d).maxWords]), [[76, 92], [152, 184], [227, 277]]);
  // The generated script aims at targetWordsFor(d) = (d − 0.5) × 2.8: inside the recommended band for every duration.
  for (const d of OFFERED) { const t = Math.round((d - 0.5) * 2.8); assert.ok(t >= recommendedCapacity(d).minWords && t <= recommendedCapacity(d).maxWords, `${d}s`); }
});

test("compatibilidad con el worker: lo que se permite iniciar cabe con a lo sumo UNA corrección de ritmo acotada; lo bloqueado no cabe ni así", () => {
  for (let n = 10; n <= 320; n += 3) {
    const stats = narrationStats(words(n));
    for (const d of OFFERED) {
      const fit = fitForDuration(stats, d, OFFERED);
      const { strict } = acceptanceWindow(d);
      const mid = stats.estimate.mid;
      // generate-video.ts: speed = actual / target clamped to 0.85–1.15, then ±10 % (duration-check.ts).
      const corrected = mid / Math.min(1.15, Math.max(0.85, mid / d));
      const workerAccepts = (mid >= strict.min && mid <= strict.max) || (corrected >= strict.min && corrected <= strict.max);
      if (fit.verdict === "compatible" || fit.verdict === "borderline") assert.ok(workerAccepts, `${n} palabras / ${d}s permitido pero el worker lo rechazaría`);
      if ((fit.verdict === "too_long" || fit.verdict === "too_short") && stats.chars <= MAX_NARRATION_CHARS) assert.ok(!workerAccepts, `${n} palabras / ${d}s bloqueado aunque el worker lo aceptaría`);
    }
  }
});

test("ROJO/VERDE: texto que claramente no cabe — mensaje con solución, sin cambiar nada automáticamente", () => {
  const fit = fitForDuration(narrationStats(words(168)), 30, OFFERED);
  assert.equal(fit.verdict, "too_long");
  assert.equal(fit.allowed, false);
  assert.match(fit.message, /^Tu guion duraría aproximadamente \d+–\d+ segundos y elegiste 30\. Selecciona 60 segundos o acorta el texto\.$/);
  assert.deepEqual(fit.compatibleDurations, [60]);
  // Too short is also blocked (the worker would stop it after paying the voice).
  assert.equal(fitForDuration(narrationStats(words(40)), 30, OFFERED).verdict, "too_short");
  // Near the limit: allowed, with an honest warning.
  const near = fitForDuration(narrationStats(words(100)), 30, OFFERED);
  assert.equal(near.verdict, "borderline"); assert.equal(near.allowed, true); assert.match(near.message, /conservamos el audio/);
  // Technical limit is distinct from the recommended capacity.
  assert.equal(fitForDuration(narrationStats("a ".repeat(MAX_NARRATION_CHARS)), 90, OFFERED).verdict, "over_limit");
});

test("conteo: números, símbolos, puntuación y saltos de línea se cuentan como se narran; los espacios no inflan el conteo", () => {
  const plain = narrationStats("En mil novecientos noventa y cinco", "es");
  const digits = narrationStats("En 1995", "es");
  assert.ok(digits.spokenWords >= plain.spokenWords - 1, "«1995» se pronuncia como varias palabras");
  assert.equal(narrationStats("el 30%").spokenWords, narrationStats("el 30 por ciento").spokenWords);
  // Whitespace is normalised the same way the server stores and bills it.
  assert.equal(normalizeNarration("Hola   mundo.\r\n\r\n\r\n  Fin  "), "Hola mundo.\n\nFin");
  assert.equal(narrationStats("Hola   mundo.\r\n\r\nFin").chars, narrationStats("Hola mundo. Fin").chars, "Reel: líneas = escenas unidas por espacio");
  // Avatar reads the text as written: line breaks are pauses.
  assert.ok(narrationStats(words(40).replace(/\. /g, ".\n"), "es", "avatar").estimate.max > narrationStats(words(40), "es", "avatar").estimate.max);
});

test("avatar con texto: mismo módulo; el límite duro usa el extremo lento (antes 2.5 palabras/s propio)", () => {
  assert.equal(fitForMaximum(narrationStats(words(100), "es", "avatar"), 45).verdict, "compatible");
  const over = fitForMaximum(narrationStats(words(130), "es", "avatar"), 45);
  assert.equal(over.allowed, false);
  assert.match(over.message, /límite de Avatar es 45/);
  const actions = src("src/app/dashboard/new/actions.ts");
  assert.doesNotMatch(actions, /estimateAvatarNarrationSeconds\(ttsText\)/, "ROJO: el formulario contaba con otra regla");
  assert.match(actions, /const ttsText = form\.stats\?\.text \?\? ""/);
});

// ---------------------------------------------------------------- 2. Guion propio: nunca reescrito

test("guion propio: las escenas son el texto exacto, cortado solo entre frases", () => {
  const text = "Primera frase del guion. Segunda frase, con coma.\n\n¿Una pregunta? Una exclamación! Y el cierre…";
  const scenes = splitIntoScenes(text, 30);
  assert.equal(scenes.join(" "), normalizeNarration(text).replace(/\n+/g, " "));
  for (const s of scenes) assert.match(s, /[.!?…]$/, "nunca se corta dentro de una frase");
  const draft = buildOwnScriptDraft(text, "Mi video", 30);
  assert.ok(isOwnScriptDraft(draft));
  assert.equal(hasRenderableScript(draft), false, "sin escenas visuales no se puede renderizar");
  assert.equal(hasRenderableScript({ beats: [] }), true, "Long Form y demás guiones conservan su significado");
  assert.equal(pendingRequestCta("x", draft).label, "Preparar escenas");
  assert.equal(pendingRequestCta("x", null).label, "Generar guion");
});

test("ROJO/VERDE: el plan de escenas no puede cambiar la narración — el modelo no la devuelve; conteo de llamadas acotado", async () => {
  const scenes = ["Uno dos tres.", "Cuatro cinco seis.", "Siete ocho."];
  let calls = 0;
  const visual = (n: number) => ({ stop_reason: "end_turn", parsed_output: { title: "T", segments: Array.from({ length: n }, (_, i) => ({ visualQuery: `query ${i}`, visualConcepts: [`query ${i}`, `alt ${i}`], emphasisWords: ["dos", "inventada"] })) } });
  const plan = await planOwnScript({ scenes, style: "x", durationSeconds: 30 }, async () => { calls++; return visual(3); });
  assert.equal(calls, 1);
  assert.deepEqual(plan.segments.map(s => s.text), scenes);
  assert.deepEqual(plan.segments[0].emphasisWords, ["dos"], "solo palabras que existen en el texto");
  // The schema has no text field: a provider that tried to rewrite cannot place it.
  assert.doesNotMatch(src("src/lib/ai/script.ts").slice(src("src/lib/ai/script.ts").indexOf("OwnScenePlanSchema = z.object")).slice(0, 400), /text: z\./);
  // Wrong count: ONE retry, then a typed error (no loop of paid calls).
  calls = 0;
  await assert.rejects(planOwnScript({ scenes, style: "x", durationSeconds: 30 }, async () => { calls++; return visual(2); }), OwnScriptPlanError);
  assert.equal(calls, 2);
  const draft = buildOwnScriptDraft(scenes.join(" "), "t", 30);
  assert.equal(narrationPreserved(draft, { segments: draft.segments.map(s => ({ text: s.text })) }), true);
  assert.equal(narrationPreserved(draft, { segments: draft.segments.map((s, i) => ({ text: i ? s.text : s.text + " extra" })) }), false);
});

test("ROJO/VERDE: un fallo al preparar las escenas conserva el texto del cliente (antes script_json quedaba en null)", async () => {
  const draft = buildOwnScriptDraft(words(84), "t", 30);
  const patches: Record<string, unknown>[] = [];
  const out = await runScriptGeneration({ generate: async () => { throw new Error("proveedor caído"); }, persist: async (p) => { patches.push(p); },
    guard: true, loadRows: async () => [], keepOnFailure: draft });
  assert.equal(out.status, 500);
  assert.equal(patches[0].status, "failed");
  assert.deepEqual(patches[0].script_json, draft);
  // A generated script keeps the previous behaviour.
  patches.length = 0;
  await runScriptGeneration({ generate: async () => { throw new Error("x"); }, persist: async (p) => { patches.push(p); }, guard: true, loadRows: async () => [] });
  assert.equal(patches[0].script_json, null);
});

test("servidor: guion propio enrutado sin reescritura; render y regenerar escena lo respetan", () => {
  const route = src("src/app/api/generate/[id]/script/route.ts");
  assert.match(route, /if \(draft\?\.source === "own"\) \{[\s\S]*?planOwnScriptForRequest\([\s\S]*?if \(!narrationPreserved\(draft, result\.script\)\) throw new OwnNarrationChangedError\(\);/);
  const check = route.indexOf("checkProductionForRequest("), run = route.indexOf("await runScriptGeneration(");
  assert.ok(check > 0 && check < run, "checklist antes de la llamada pagada");
  assert.match(route.slice(check, run), /requestId: id,\s*fit: draft \? draftFit\(/);
  const render = src("src/app/api/generate/[id]/render/route.ts");
  assert.ok(render.indexOf("if (isOwnScriptDraft(videoRequest.script_json))") < render.indexOf("await reserveJobSupply("), "un borrador sin escenas nunca reserva ni despacha");
  assert.match(src("src/app/api/generate/[id]/script/regenerate-scene/route.ts"), /scriptSourceOf\(videoRequest\.script_json\) === "own"\) \{\s*newScene = \{ \.\.\.newScene, text: current\.text/);
  assert.equal(scriptSourceOf({ source: "own", segments: [] }), "own");
  // History: an unplanned draft that failed retries /script («Preparar escenas»), never the render.
  assert.match(src("src/components/video/RequestCard.tsx"), /\(hasRenderableScript\(request\.script_json\) \|\| request\.recorded_audio_path \? \(/);
});

// ---------------------------------------------------------------- 4. Validación compartida formulario/servidor

const FORM: FormProductionInput = { mode: "visual", topic: "Mi video", style: "Educativo", durationSeconds: 30, language: "es", scriptChoice: "own",
  ownText: words(84), adaptAccepted: false, avatarNarrationSource: "tts", maxAvatarSeconds: 45 };

test("la misma función valida el formulario en vivo y la acción del servidor; una llamada directa no la salta", () => {
  assert.equal(formProduction(FORM).inputError, null);
  assert.equal(formProduction(FORM).fit?.verdict, "compatible");
  assert.equal(formProduction({ ...FORM, ownText: words(168) }).fit?.allowed, false);
  assert.match(formProduction({ ...FORM, scriptChoice: "adapt" }).inputError ?? "", /acepta su costo/);
  assert.equal(formProduction({ ...FORM, scriptChoice: "adapt", adaptAccepted: true }).inputError, null);
  assert.match(formProduction({ ...FORM, scriptChoice: "otra" as never }).inputError ?? "", /no válida/);
  assert.match(formProduction({ ...FORM, mode: "avatar", avatarNarrationSource: "tts", durationSeconds: 60 }).inputError ?? "", /no está disponible/, "solo duraciones de la modalidad");
  assert.equal(formProduction({ ...FORM, mode: "avatar", avatarNarrationSource: "recording", durationSeconds: 90 }).inputError, null, "la grabación usa la duración real");
  const actions = src("src/app/dashboard/new/actions.ts");
  const enforce = actions.indexOf("const form = formProduction("), insert = actions.indexOf('mode: "visual",\n      status: "pending",'), voice = actions.indexOf("await gatedVoiceSynthesize(");
  assert.ok(enforce > 0 && enforce < insert && enforce < voice);
  assert.match(actions, /if \(form\.fit && !form\.fit\.allowed\) redirect\(/);
  assert.match(actions, /script_json: form\.draft,/);
  assert.match(src("src/app/api/production-check/route.ts"), /const form = formProduction\(/);
});

// Corrección 2: the old claim «dos pestañas = una solicitud» was false (one randomUUID per tab). The behaviour,
// with row and paid-call counters for each case, is proven in draft-idempotency.test.ts.
test("el id del envío se resuelve antes de la rama Reel y el Reel inserta con él", () => {
  const actions = src("src/app/dashboard/new/actions.ts");
  const id = actions.indexOf("requestIdForSubmission(user.id, formData, lookup)"), visual = actions.indexOf('if (mode === "visual") {');
  assert.ok(id > 0 && id < visual, "el id del envío se resuelve antes de la rama Reel");
  assert.match(actions, /id: requestId,\n      user_id: user\.id,/);
  assert.match(actions, /if \(error\.code === "23505"\) redirect\(created\);/);
});

// ---------------------------------------------------------------- 4. Checklist (servidor), con contadores

function supply(state: Record<string, { level: string; free: number | null }>) {
  const policy = (provider: string, unit: string) => ({ provider, enabled: true, unit, unit_cost_usd: unit === "character" ? 0.0002 : 1, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "America/Cancun", evidence: "owner-funded" });
  const policies = [{ ...policy("__global__", "usd"), daily_cap_usd: 40, monthly_cap_usd: 300 }, policy("elevenlabs", "character"), policy("anthropic", "usd")];
  return {
    from() { return { select() { return { in: async (_k: string, v: string[]) => ({ data: policies.filter(p => v.includes(p.provider)), error: null }) }; } }; },
    async rpc(name: string, args: { p_provider: string | null }) {
      if (name === "pi_supply_spend") return { data: 0, error: null };
      const s = state[args.p_provider ?? ""];
      return { data: s ? { level: s.level, reason: "fresh", free: s.free } : { level: "UNKNOWN", reason: "unconfigured", free: null }, error: null };
    },
  } as unknown as SupabaseClient;
}
const GREEN = { elevenlabs: { level: "GREEN", free: 1_000_000 }, anthropic: { level: "GREEN", free: 100 } };
const OWN: CheckRequest = { mode: "visual", duration_seconds: 30, language: "es", topic: "t", style: "s", recorded_audio_path: null, script_json: buildOwnScriptDraft(words(84), "t", 30) };
const run = (over: Partial<Parameters<typeof checkProduction>[0]> = {}, deps: Partial<NonNullable<Parameters<typeof checkProduction>[0]["deps"]>> = {}) =>
  checkProduction({ service: supply(GREEN), user: USER, ownerId: USER.id, request: OWN, stage: "before_script", voiceProvider: "elevenlabs", flags: FLAGS,
    fit: draftFit(OWN.script_json as never, 30, "es"), ...over,
    deps: { assertCanGenerate: async () => ({ allowed: true as const }), guard: true, processingConfigured: () => true, loadScriptRows: async () => [], now: () => new Date("2026-10-18T19:00:00Z"), ...deps } });
const status = (c: Awaited<ReturnType<typeof run>>) => Object.fromEntries(c.checklist.map(i => [i.id, i.status]));

test("checklist completo y en orden: cada punto refleja una comprobación real", async () => {
  const c = await run({ requestId: "r1" });
  assert.equal(c.outcome, "ready");
  assert.deepEqual(c.checklist.map(i => i.id), ["input", "fit", "plan", "providers", "processing", "balances", "budget", "operations"]);
  assert.deepEqual(new Set(Object.values(status(c))), new Set(["ok"]));
  assert.match(c.checklist.find(i => i.id === "providers")!.detail, /guiones, voz/);
  assert.match(c.checklist.find(i => i.id === "budget")!.detail, /no es el precio exacto/);
});

test("guion propio: se dimensiona con su texto REAL y con el plan de escenas, no con el techo de un guion generado", () => {
  const own = productionDemands(OWN, "elevenlabs", "before_script", { flags: FLAGS });
  const chars = (OWN.script_json as { segments: { text: string }[] }).segments.map(s => s.text).join(" ").length;
  assert.equal(own.demands.find(d => d.provider === "elevenlabs")!.units, chars * 2, "voz: caracteres reales × una corrección de ritmo");
  const scenes = (OWN.script_json as { segments: { text: string }[] }).segments.map(s => s.text);
  assert.ok(ownScriptPlanCeilingUsd({ scenes, style: "s", durationSeconds: 30 }) < scriptGenerationCeilingUsd({ topic: "t", style: "s", durationSeconds: 30 }));
});

test("ROJO/VERDE con contadores: cada bloqueo previsible detiene ANTES de la llamada pagada y dice quién actúa", async () => {
  let paid = 0;
  const startIfReady = async (c: Awaited<ReturnType<typeof run>>) => { if (c.outcome === "ready") paid++; return c; };
  const cases: [string, Promise<Awaited<ReturnType<typeof run>>>, string, string, string][] = [
    ["texto no cabe", run({ fit: fitForDuration(narrationStats(words(168)), 30, OFFERED) }), "fit", "blocked", "cliente"],
    ["dato inválido", run({ inputError: "Duración no válida" }), "input", "blocked", "cliente"],
    ["plan agotado", run({}, { assertCanGenerate: async () => ({ allowed: false as const, reason: "Alcanzaste el límite de tu plan." }) }), "plan", "blocked", "cliente"],
    ["plan ilegible", run({}, { assertCanGenerate: async () => { throw new Error("db"); } }), "plan", "unverified", "atomicvid"],
    ["voz en RED", run({ service: supply({ ...GREEN, elevenlabs: { level: "RED", free: 0 } }) }), "balances", "blocked", "atomicvid"],
    ["saldo caducado", run({ service: supply({ ...GREEN, elevenlabs: { level: "UNKNOWN", free: null } }) }, {}), "balances", "unverified", "atomicvid"],
    ["procesamiento sin configurar", run({}, { processingConfigured: () => false }), "processing", "blocked", "atomicvid"],
    ["llamada en curso", run({ requestId: "r1" }, { loadScriptRows: async () => [{ status: "SUBMITTED", shot_id: "script", updated_at: "2026-10-18T18:59:50Z", idempotency_key: "k" }] as ScriptOpRow[] }), "operations", "blocked", "atomicvid"],
    ["ledger ilegible", run({ requestId: "r1" }, { loadScriptRows: async () => { throw new Error("db"); } }), "operations", "unverified", "atomicvid"],
  ];
  for (const [name, pending, id, st, who] of cases) {
    const c = await startIfReady(await pending);
    assert.notEqual(c.outcome, "ready", name);
    const item = c.checklist.find(i => i.id === id)!;
    assert.equal(item.status, st, `${name}: ${item.detail}`);
    assert.equal(item.responsible, who, name);
    if (who === "atomicvid") assert.doesNotMatch(`${c.title} ${c.message} ${c.next} ${item.detail}`, /\bRecarga\b|recarga al menos|añade créditos|compra (más|créditos)/, `${name}: nunca pedir al cliente recargar por Atomicvid`);
  }
  assert.equal(paid, 0, "ninguna llamada pagada en los nueve casos");
  // Exactly at the provider's free capacity: allowed (≥, not >).
  const units = productionDemands(OWN, "elevenlabs", "before_script", { flags: FLAGS }).demands.find(d => d.provider === "elevenlabs")!.units;
  assert.equal((await run({ service: supply({ ...GREEN, elevenlabs: { level: "GREEN", free: units } }) })).outcome, "ready");
  assert.equal((await run({ service: supply({ ...GREEN, elevenlabs: { level: "GREEN", free: units - 1 } }) })).outcome, "provider_unavailable");
});

test("una grabación propia no exige saldo de voz; un recorrido no pide proveedores que no usa", () => {
  const rec = productionDemands({ mode: "avatar", duration_seconds: 30, recorded_audio_path: "form-upload", script_json: { segments: [{ text: "—" }] } }, "elevenlabs", "before_render", { flags: FLAGS });
  assert.equal(rec.demands.some(d => d.provider === "elevenlabs"), false);
});

test("formulario: el resultado anterior se invalida al cambiar datos y la pantalla usa las funciones del servidor", () => {
  const hook = src("src/components/video/ProductionChecklist.tsx");
  assert.match(hook, /return state\.key === key \? state : \{ status: enabled \? "checking" : "idle"/, "una respuesta para otros datos nunca se muestra como actual");
  assert.match(hook, /controller\.abort\(\)/);
  const form = src("src/app/dashboard/new/NewVideoForm.tsx");
  assert.match(form, /fitForDuration\(narrationStats\(ownText, language, "visual"\), selectedDuration, availableDurations\)/);
  assert.match(form, /"Crea mi guion"/); assert.match(form, /"Usar mi propio guion"/);
  assert.match(src("src/components/video/NarrationFitMeter.tsx"), /from "@\/lib\/video\/narration-fit"/);
});

test("una llamada de guion en curso o incierta conserva la respuesta 409 de siempre y se explica con exactitud", async () => {
  const { checkHttpStatus, checkResponseBody } = await import("./production-check");
  const inFlight = await run({ requestId: "r1" }, { loadScriptRows: async () => [{ status: "SUBMITTED", shot_id: "script", updated_at: "2026-10-18T18:59:50Z", idempotency_key: "k" }] as ScriptOpRow[] });
  assert.equal(checkHttpStatus(inFlight), 409);
  assert.match(inFlight.title, /generación en curso/);
  const pending = await run({ requestId: "r1" }, { loadScriptRows: async () => [{ status: "RECONCILIATION_REQUIRED", shot_id: "script", updated_at: "2026-10-18T10:00:00Z", idempotency_key: "k" }] as ScriptOpRow[] });
  assert.equal(checkHttpStatus(pending), 409);
  assert.match(pending.title, /pendiente de confirmar/);
  assert.equal(checkResponseBody(pending).outcome.retry, "support");
});

test("el formulario se renderiza con ambas opciones, la comprobación previa y sin pedir recargas", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { NewVideoForm } = await import("@/app/dashboard/new/NewVideoForm");
  const html = renderToStaticMarkup(React.createElement(NewVideoForm, { action: () => {}, avatarModeEnabled: true, existingAvatars: [] }));
  assert.match(html, /Crea mi guion/); assert.match(html, /Usar mi propio guion/);
  assert.match(html, /Comprobación antes de gastar/);
  assert.match(html, /Completa el tema y el estilo/);
  assert.match(html, /name="submission_id"/);
  const { NarrationFitMeter } = await import("@/components/video/NarrationFitMeter");
  const meter = renderToStaticMarkup(React.createElement(NarrationFitMeter, { text: words(168), language: "es", mode: "visual", targetSeconds: 30, offeredDurations: OFFERED, onSelectDuration: () => {} }));
  assert.match(meter, /data-verdict="too_long"/);
  assert.match(meter, /Usar 60 segundos/);
  assert.match(meter, /Recomendado para 30 s/);
});

// ---------------------------------------------------------------- PR149 CORRECCIÓN-1: partición exacta

/** Cases a naive «split at every period» corrupts (auditor's table + ES/EN extensions). */
const EXACT_CASES: [string, string][] = [
  ["decimal", "El resultado fue 3.14 por ciento. Esto importa."],
  ["miles", "En 2026 el precio fue $1.500. Escucha esto."],
  ["dominio", "Visita ejemplo.com para conocer más."],
  ["abreviatura y sigla", "El Dr. Pérez llegó a EE. UU. en 1999. Luego volvió."],
  ["hora inglesa", "Mr. Smith arrived at 5 p.m. today. Then he left."],
  ["iniciales", "J. R. R. Tolkien escribió mucho. ¿Lo leíste?"],
  ["porcentaje y fecha", "El 12,5% subió el 18/10/2026. ¡Increíble! Nadie lo esperaba…"],
  ["comillas y paréntesis", "Dijo «basta.» (Nadie respondió.) Luego habló otra vez."],
  ["e.g. inglés", "Use short words, e.g. cat or dog. It helps a lot."],
  ["saltos de línea", "Primera parte.\n\nSegunda parte con 2.5 litros.\nTercera parte."],
  ["espacios raros", "Hola  mundo.   Fin\tdel texto."],
  ["sin puntuación", "una sola frase sin signos finales"],
];

test("CORRECCIÓN-1 ROJO/VERDE: el guion propio llega a la voz carácter por carácter (cifras, dominios, abreviaturas, ES/EN)", async () => {
  const { canonicalNarration } = await import("@/lib/video/narration-fit");
  for (const [name, text] of EXACT_CASES) {
    for (const d of OFFERED) {
      const draft = buildOwnScriptDraft(text, "t", d);
      const voiceInput = draft.segments.map(s => s.text).join(" "); // exactly what generate-video.ts sends
      assert.equal(voiceInput, canonicalNarration(text, "visual"), `${name} @${d}s`);
      assert.ok(draft.segments.every(s => s.text.length > 0 && s.text === s.text.trim()), `${name}: escenas sin bordes inventados`);
      assert.equal(narrationPreserved(draft, draft), true);
    }
  }
  // No cut inside figures, domains, abbreviations, initials or acronyms.
  const at = (text: string) => buildOwnScriptDraft(text, "t", 90).segments.map(s => s.text);
  assert.deepEqual(at("El Dr. Pérez llegó a EE. UU. en 1999. Luego volvió."), ["El Dr. Pérez llegó a EE. UU. en 1999.", "Luego volvió."]);
  assert.deepEqual(at("Mr. Smith arrived at 5 p.m. today. Then he left."), ["Mr. Smith arrived at 5 p.m. today.", "Then he left."]);
  assert.deepEqual(at("J. R. R. Tolkien escribió mucho. ¿Lo leíste?"), ["J. R. R. Tolkien escribió mucho.", "¿Lo leíste?"]);
  // The check compares with the CUSTOMER's canonical text, not only with the stored draft.
  const draft = buildOwnScriptDraft("El resultado fue 3.14 por ciento. Esto importa.", "t", 30);
  const tampered = { ...draft, segments: [{ text: "El resultado fue 3.", visualQuery: "" }, { text: "14 por ciento. Esto importa.", visualQuery: "" }] };
  assert.equal(narrationPreserved(tampered, tampered), false, "ROJO del auditor: un borrador ya alterado no pasa la verificación");
  // Counter, draft and check share the same canonicaliser.
  assert.equal(narrationStats("Hola\n\nmundo.").text, canonicalNarration("Hola\n\nmundo.", "visual"));
});
