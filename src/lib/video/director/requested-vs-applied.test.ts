/**
 * T-34 B3 — Director solicitado vs aplicado. Offline: cuentas sintéticas (.test), entornos literales, `fetch` bloqueado.
 *  - La web (Vercel) guarda en la fila si ESTE intento solicitó el Director (`director_requested`).
 *  - El worker decide ANTES de reservar suministro o pagar: solicitado y no aplicable ⇒ bloqueo tipado, sin montaje
 *    clásico silencioso; no solicitado ⇒ clásico aunque el worker tenga el interruptor encendido.
 *  - «Aplicado» solo con el director.json del intento final (mismo prefijo que el MP4), intervalos válidos y únicos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decideDirectorRender, DirectorUnavailableError } from "./render-access";
import { directorBlockMessage } from "./reel-render";
import { directorRecordPath, parseDirectorRecord } from "@/lib/video/director-applied";
import { isCustomerSafeError } from "@/lib/video/long-form/output-policy";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("B3: red prohibida"); }) as typeof fetch;
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const OWNER = { email: "Propietario@Example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const OTHER = { email: "otra@example.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const REQUESTED = { mode: "visual", recorded_audio_path: null, director_requested: true };
const NOT_REQUESTED = { mode: "visual", recorded_audio_path: null, director_requested: false };
const WORKER_ON = { CINEMATIC_DIRECTOR_RENDER_ENABLED: "true", CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };
const WORKER_OFF = { CINEMATIC_DIRECTOR_PILOT_EMAILS: "propietario@example.test" };

async function blocked(p: Promise<boolean>, reason: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof DirectorUnavailableError, `esperaba DirectorUnavailableError, llegó ${String(e)}`);
    assert.equal(e.reason, reason);
    assert.ok(isCustomerSafeError(e), "mensaje seguro para el cliente");
    assert.match(e.customerMessage, /No se reservó ni se cobró nada/);
    assert.match(e.customerMessage, /no se hizo un montaje clásico en su lugar/);
    assert.doesNotMatch(e.customerMessage, /CINEMATIC_|PILOT_EMAILS|RENDER_ENABLED/, "sin nombres de variables internas");
    return true;
  });
}

test("Reel positivo: solicitado + worker encendido + cuenta piloto confirmada ⇒ Director (una consulta de cuenta)", async () => {
  let lookups = 0;
  assert.equal(await decideDirectorRender(REQUESTED, async () => { lookups++; return OWNER; }, WORKER_ON), true);
  assert.equal(lookups, 1);
  assert.equal(networkCalls, 0);
});

test("Reel negativo: solicitado con el worker apagado ⇒ bloqueo antes de gastar (no clásico silencioso)", async () => {
  let lookups = 0;
  await blocked(decideDirectorRender(REQUESTED, async () => { lookups++; return OWNER; }, WORKER_OFF), "worker_switch_off");
  assert.equal(lookups, 0);
});

test("Reel negativo: solicitado, cuenta fuera de la lista del worker / correo sin confirmar / lista vacía ⇒ bloqueo", async () => {
  await blocked(decideDirectorRender(REQUESTED, async () => OTHER, WORKER_ON), "account_not_enabled");
  await blocked(decideDirectorRender(REQUESTED, async () => ({ ...OWNER, email_confirmed_at: null }), WORKER_ON), "account_not_enabled");
  await blocked(decideDirectorRender(REQUESTED, async () => OWNER, { ...WORKER_ON, CINEMATIC_DIRECTOR_PILOT_EMAILS: "" }), "account_not_enabled");
});

test("Reel negativo: solicitado y la consulta de cuenta falla ⇒ bloqueo (falla cerrado), nunca clásico", async () => {
  await blocked(decideDirectorRender(REQUESTED, async () => { throw new Error("auth down"); }, WORKER_ON), "owner_lookup_failed");
});

test("Reel negativo: solicitado sobre un Reel no elegible (narración grabada) ⇒ bloqueo explicado", async () => {
  await blocked(decideDirectorRender({ ...REQUESTED, recorded_audio_path: "u/r/audio.webm" }, async () => OWNER, WORKER_ON), "not_eligible_reel");
});

test("Reel: no solicitado ⇒ clásico aunque el worker esté encendido (el Director nunca se aplica sin pedirlo) y sin consultar la cuenta", async () => {
  let lookups = 0;
  assert.equal(await decideDirectorRender(NOT_REQUESTED, async () => { lookups++; return OWNER; }, WORKER_ON), false);
  assert.equal(await decideDirectorRender({ mode: "visual", recorded_audio_path: null }, async () => { lookups++; return OWNER; }, WORKER_ON), false, "filas antiguas sin columna");
  assert.equal(await decideDirectorRender({ mode: "long_form", director_requested: true }, async () => { lookups++; return OWNER; }, WORKER_ON), false, "Long Form usa su propia compuerta V6");
  assert.equal(lookups, 0);
});

test("Worker (run-job.ts): lee director_requested y decide ANTES de reservar suministro y antes de cualquier generación", () => {
  const runJob = src("src/lib/video/run-job.ts");
  assert.match(runJob, /\.select\(\s*"[^"]*\bdirector_requested\b[^"]*",?\s*\)/, "el select de la fila del worker incluye la solicitud");
  const decide = runJob.indexOf("const directorRender = mode === \"visual\" && await decideDirectorRender(row");
  const reserve = runJob.indexOf("await reserveJobSupply(");
  const generate = runJob.indexOf("await generateVideoFromScript({");
  assert.ok(decide > 0 && decide < reserve && reserve < generate, "orden: decisión del Director → reserva → generación");
  assert.doesNotMatch(runJob, /resolveDirectorRender\(/, "la decisión antigua (clásico silencioso) ya no se usa");
});

test("Web (render/route.ts): el intento guarda director_requested con la misma decisión que la Revisión", () => {
  const route = src("src/app/api/generate/[id]/render/route.ts");
  assert.match(route, /director_requested: directorRenderAllowed\(user, videoRequest\)/);
  const mark = route.indexOf("director_requested:");
  const trigger = route.indexOf("await worker.trigger(");
  assert.ok(mark > 0 && mark < trigger, "se guarda en la misma transición a processing, antes de despachar");
});

test("migración: columna director_requested booleana, no nula, falsa por defecto (sin escritura desde el navegador)", () => {
  const dir = path.join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((f) => /director_requested/.test(f));
  assert.ok(file, "existe la migración");
  const sql = readFileSync(path.join(dir, file), "utf8");
  assert.match(sql, /alter table public\.video_requests\s+add column if not exists director_requested boolean not null default false/i);
  assert.doesNotMatch(sql, /grant\s+(insert|update)/i, "ningún permiso de escritura nuevo para anon/authenticated");
});

// ---------------------------------------------------------------- Evidencia «aplicado»

const applied = (shotId: string, startSeconds: number, endSeconds: number) => ({
  shotId, anchorText: "a", recipeId: "reel-hook-visual", planned: { movement: "push_in" },
  applied: { startSeconds, endSeconds, motion: "push_in", transitionIn: "cut", transitionOut: "cut", label: "ilustrativa" },
});
const record = (over: Record<string, unknown> = {}) => ({ ok: true, artifactPrefix: "u/req/attempt-2", durationSeconds: 6, applied: [applied("s1", 0, 2), applied("s2", 2, 4.5), applied("s3", 4.5, 6)], ...over });
const VIDEO = "u/req/attempt-2/final.mp4";

test("aplicado: un director.json del intento final con intervalos válidos produce una fila por plano", () => {
  const rows = parseDirectorRecord(record(), VIDEO);
  assert.equal(rows?.length, 3);
  assert.deepEqual(rows?.map((r) => [r.shotId, r.startSeconds, r.endSeconds]), [["s1", 0, 2], ["s2", 2, 4.5], ["s3", 4.5, 6]]);
  assert.equal(directorRecordPath(VIDEO), "u/req/attempt-2/director.json");
});

test("aplicado: un registro de OTRO intento (u otro video) no se presenta como aplicado", () => {
  assert.equal(parseDirectorRecord(record({ artifactPrefix: "u/req/attempt-1" }), VIDEO), null);
  assert.equal(parseDirectorRecord(record({ artifactPrefix: undefined }), VIDEO), null, "registro antiguo sin vínculo ⇒ no verificable");
});

test("aplicado: intervalos inválidos, solapados, fuera del video, duplicados o vacíos ⇒ nada", () => {
  for (const [label, bad] of [
    ["fin <= inicio", [applied("s1", 2, 2)]],
    ["negativo", [applied("s1", -1, 2)]],
    ["no finito", [applied("s1", 0, Number.POSITIVE_INFINITY)]],
    ["solapado", [applied("s1", 0, 3), applied("s2", 2, 6)]],
    ["desordenado", [applied("s2", 2, 6), applied("s1", 0, 2)]],
    ["más allá del video", [applied("s1", 0, 9)]],
    ["plano duplicado", [applied("s1", 0, 2), applied("s1", 2, 6)]],
    ["sin planos", []],
  ] as const) assert.equal(parseDirectorRecord(record({ applied: bad }), VIDEO), null, label);
  assert.equal(parseDirectorRecord(record({ ok: false }), VIDEO), null);
  assert.equal(parseDirectorRecord(record({ durationSeconds: "6" }), VIDEO), null, "duración del video obligatoria y numérica");
});

test("worker (generate-video.ts): el director.json registra el prefijo del intento y la duración final", () => {
  const gv = src("src/lib/video/generate-video.ts");
  assert.match(gv, /artifactPrefix, durationSeconds: finalDurationSeconds,\s*footageSelections,/);
});

test("página del video: «aplicado» solo con evidencia del intento final; solicitado sin evidencia lo dice sin prometer", () => {
  const page = src("src/app/dashboard/videos/[id]/page.tsx");
  assert.match(page, /loadDirectorApplied\(createServiceClient\(\), request\.video_path\)/);
  assert.match(page, /directorRequested && \(!directorRows \|\| directorRows\.length === 0\)/);
  assert.match(page, /loadDirectorRequested\(supabase, request\.id\)/, "lectura aparte y tolerante: la página nunca se rompe por la columna nueva");
  assert.match(page, /Director solicitado, sin evidencia de aplicación en este video/);
  const loader = src("src/lib/video/director-applied.ts");
  assert.match(loader, /parseDirectorRecord\(JSON\.parse\(await data\.text\(\)\), videoPath\)/);
});

// ---------------------------------------------------------------- Mensajes accionables

test("bloqueos del montaje: material, derechos y contrato dicen qué pasó y qué hacer, sin prometer reembolso", () => {
  const material = directorBlockMessage([{ code: "MEDIA_MISSING", shotId: "s2", detail: "sin clip para el plano s2" }]);
  assert.match(material, /material visual/i);
  assert.match(material, /Qué hacer:/);
  const rights = directorBlockMessage([{ code: "LICENSE_NOT_CLEARED_FOR_RENDER", shotId: "s1", detail: "licencia no confirmada" }]);
  assert.match(rights, /derechos|licencia/i);
  assert.match(rights, /no se usó/);
  const contract = directorBlockMessage([{ code: "CONTRACT_INVALID", detail: "x" }]);
  assert.match(contract, /soporte/i);
  for (const m of [material, rights, contract]) {
    assert.match(m, /No se publicó ningún video con montaje clásico/);
    assert.ok(m.length <= 600);
  }
});
