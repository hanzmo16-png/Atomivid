/**
 * P0 «Adaptar producción al límite disponible» (episodio real 4290175a: 48 llamadas de HeyGen pedidas, límite diario 40).
 * Escenario 48 → 40 con un guion de 96 turnos y dos avatares, Recraft como ilustración. Todo local: dobles para la
 * base y los proveedores, USD 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioSpec, STUDIO_VERSION, EL_DURO_VOICE_ID } from "./spec";
import { adaptAction, planningProviders, type ApiDeps } from "./api";
import { preflight, providerNeeds, type ProviderNeeds } from "./pipeline";
import { avatarDemotions, avatarTurnIds, planEpisode, planIssues } from "./editorial";
import type { SupplyReadiness } from "@/lib/supply/readiness";
import type { AccountVoice } from "@/lib/podcast/voices";
import { AdaptProposalView, confirmBlocker, isAvatarQuotaError } from "../../../app/dashboard/podcast/AdaptLimitPanel";
import type { AdaptProposal } from "./adapt";

const V = (voiceId: string, name: string): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro")];
const viewer = { id: "u1", email: "h@example.com", email_confirmed_at: "x" };
const LINES = Array.from({ length: 96 }, (_, i) => `${i % 2 ? "Luis" : "Ana"}: Sobre los anunnaki y las tablillas de Nippur, parte ${i + 1}, hablamos de Sumeria, Enlil y los registros de arcilla del templo.`);
const SPEC = StudioSpec.parse({ version: STUDIO_VERSION, mode: "dialogo", output: "video", title: "Anunnaki", topic: "Anunnaki", script: LINES.join("\n"), target_minutes: 10,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }],
  visual: { provider: "recraft", avatar_frequency: 0.5 }, music: {}, budget_usd: 40 });

/** Doble de la verificación de suministro: HeyGen con límite diario `max` y `today` usadas; el resto, según `other`. */
const quota = (max: number, today: number, other?: (n: ProviderNeeds) => SupplyReadiness | null) => async (n: ProviderNeeds): Promise<SupplyReadiness> => {
  const o = other?.(n); if (o) return o;
  const calls = n.avatarCalls ?? 0;
  return today + calls > max ? { ready: false, providers: [], failure: { provider: "heygen", reason: "daily request quota", quota: { max, today, calls, timezone: "America/Cancun" } } } : { ready: true, providers: [] };
};

function harness(opts: { status?: string; check?: (n: ProviderNeeds) => Promise<SupplyReadiness>; settled?: { op: string }[]; userId?: string; rawSpec?: unknown } = {}) {
  const calls = { save: 0, authorize: 0, dispatch: 0, saved: [] as { spec: StudioSpec; usd: number }[] };
  const spec0: unknown = opts.rawSpec ?? SPEC;
  let row = { id: "4290175a-f7b4-49a8-9ec5-2977b98d486a", user_id: "u1", status: opts.status ?? "failed", estimated_usd: 20.22, spec: spec0, estimate: {}, error: "Proveedor no listo: HeyGen (avatar): alcanzó su cuota diaria de llamadas. No se hizo ningún cargo.", authorized_at: "2026-11-08T17:18:00Z", run_started_at: "2026-11-08T17:20:34Z" };
  const d: ApiDeps = { userId: opts.userId ?? "u1", viewer, voices: async () => VOICES, enabled: true, llm: null, env: {}, ownsAvatar: async () => true,
    insert: async () => null, load: async () => row as never,
    authorize: async () => { calls.authorize++; row = { ...row, status: "authorized", authorized_at: new Date().toISOString() }; return true; },
    dispatch: async () => { calls.dispatch++; row = { ...row, status: "generating", run_started_at: new Date(Date.now() + 1000).toISOString() }; return true; },
    supplyCheck: opts.check ?? quota(40, 0), settledOps: async () => opts.settled ?? [],
    saveAdaptation: async (_id, spec, _estimate, usd) => { calls.save++; calls.saved.push({ spec: spec as StudioSpec, usd }); row = { ...row, spec, estimated_usd: usd }; return row.status === "draft" || row.status === "failed"; } };
  return { d, calls, row: () => row };
}
type Body = { proposal: AdaptProposal; summary: string[]; code?: string; error?: string; adapted?: boolean; dispatched?: boolean };

test("planificador: 48 apariciones con tope 40 → 40; apertura/cierre y primera/última de cada uno a cámara; misma duración; sin huecos", async () => {
  const pf = await preflight(SPEC, planningProviders());
  const onCamera = avatarTurnIds({ mode: SPEC.mode, turns: pf.turns, avatarFrequency: 0.5, hasAvatar: { A: true, B: true } });
  assert.equal(onCamera.length, 48);
  const demoted = avatarDemotions(pf.turns, onCamera, 40);
  assert.equal(demoted.size, 8);
  for (const sp of ["A", "B"]) { const mine = onCamera.filter((id) => pf.turns.find((t) => t.id === id)!.speaker === sp); assert.ok(!demoted.has(mine[0]) && !demoted.has(mine.at(-1)!), `primera/última de ${sp}`); }
  const idx = [...demoted].map((id) => onCamera.indexOf(id)).sort((a, b) => a - b);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] - idx[i - 1] >= 3, `retiradas repartidas, no en bloque: ${idx.join(",")}`);
  const input = { mode: SPEC.mode, turns: pf.turns, assets: pf.assets, avatarFrequency: 0.5, avatarMaxSeconds: 20, recreations: true, hasAvatar: { A: true, B: true }, introSeconds: 4 };
  const full = planEpisode(input), capped = planEpisode({ ...input, avatarMaxShots: 40 }), again = planEpisode({ ...input, avatarMaxShots: 40 });
  const cam = (p: typeof full) => p.shots.filter((s) => ["avatar_a", "avatar_b", "two_shot", "over_shoulder"].includes(s.kind)).length;
  assert.equal(cam(full), 48); assert.equal(cam(capped), 40);
  assert.equal(capped.shots.at(-1)!.end, full.shots.at(-1)!.end, "duración idéntica");
  assert.deepEqual(planIssues(capped), []);
  assert.deepEqual(capped, again, "determinista: preliminar y definitivo retiran los mismos turnos");
  // Cada aparición retirada pasa a la ilustración propia de ESE turno (Recraft), no a un plano vacío ni a una imagen ajena.
  for (const id of demoted) { const s = capped.shots.filter((x) => x.turn_id === id); assert.equal(s.length, 1); assert.equal(s[0].kind, "imagen"); assert.equal(s[0].asset_id, `rc-${id}`); assert.match(s[0].reason, /Adaptado al límite/); }
  assert.equal(capped.shots.filter((s) => s.turn_id).length >= pf.turns.length, true, "todos los turnos siguen en pantalla");
});

test("tope sin efecto o extremo: ≥ apariciones no cambia nada; menor que lo protegido retira lo mínimo necesario", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, speaker: (i % 2 ? "B" : "A") as "A" | "B", kind: "comentario" as const }));
  const ids = turns.map((t) => t.id);
  assert.equal(avatarDemotions(turns, ids, 10).size, 0);
  assert.equal(avatarDemotions(turns, ids, 12).size, 0);
  assert.equal(avatarDemotions(turns, ids, 3).size, 7);
  assert.equal(avatarDemotions(turns, ids, 0).size, 10);
});

test("el worker cuenta las mismas llamadas con el tope aceptado: 40 de avatar (preparación incluida)", async () => {
  const adapted = { ...SPEC, visual: { ...SPEC.visual, avatar_max_calls: 40 } };
  const pf = await preflight(adapted, planningProviders());
  assert.equal(providerNeeds(adapted, pf, [], { prepare: true }).avatarCalls, 40);
  const foto = StudioSpec.parse({ ...SPEC, participants: [{ ...SPEC.participants[0], avatar: { kind: "catalogo", host_id: "valeria" } }, SPEC.participants[1]], visual: { ...SPEC.visual, avatar_max_calls: 40 } });
  const pf2 = await preflight(foto, planningProviders());
  assert.ok(providerNeeds(foto, pf2, [], { prepare: true }).avatarCalls! <= 40, "con preparación de foto, clips + preparación ≤ 40");
});

test("vista previa 48 → 40: qué cambia, duración conservada, presupuesto actualizado; NO escribe ni inicia nada", async () => {
  const h = harness();
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", preview: true });
  assert.equal(r.status, 200);
  const { proposal: p, summary } = r.body as unknown as Body;
  assert.equal(p.callsBefore, 48); assert.equal(p.callsAfter, 40); assert.equal(p.maxCalls, 40); assert.equal(p.available, 40);
  assert.equal(p.avatarShotsBefore, 48); assert.equal(p.avatarShotsAfter, 40); assert.equal(p.replaced.ilustracion_o_imagen, 8);
  assert.equal(p.durationPreserved, true); assert.equal(p.speakersStillOnCamera, true); assert.deepEqual(p.quality, { ok: true, issues: [] });
  assert.ok(p.longestOffCameraAfter <= Math.max(60, 3 * p.longestOffCameraBefore), `ritmo: ${p.longestOffCameraBefore} → ${p.longestOffCameraAfter} s sin nadie a cámara`);
  assert.ok(p.estimateAfterUsd < p.estimateBeforeUsd, `${p.estimateAfterUsd} < ${p.estimateBeforeUsd}`); assert.equal(p.withinBudget, true); assert.equal(p.readyAfter, true);
  assert.match(summary[0], /aparecerá 40 veces en lugar de 48: 8 apariciones pasan a ilustraciones o imágenes del mismo momento/);
  assert.match(summary.join(" "), /Se conservan el guion, las voces, los participantes y la duración/);
  assert.match(summary.join(" "), /Costo estimado: USD \d+\.\d{2} \(antes USD \d+\.\d{2}\); tu tope sigue en USD 40\.00/);
  assert.equal(h.calls.save, 0); assert.equal(h.calls.authorize, 0); assert.equal(h.calls.dispatch, 0); assert.equal(h.row().status, "failed");
});

test("confirmar: guarda solo el tope y su registro (guion, participantes, voces intactos) y reintenta el MISMO episodio una vez", async () => {
  const h = harness();
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", confirm: true, maxCalls: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal((r.body as unknown as Body).adapted, true); assert.equal((r.body as unknown as Body).dispatched, true);
  assert.equal(h.calls.save, 1); assert.equal(h.calls.authorize, 1); assert.equal(h.calls.dispatch, 1);
  const saved = h.calls.saved[0].spec;
  assert.equal(saved.script, SPEC.script); assert.deepEqual(saved.participants, SPEC.participants); assert.equal(saved.budget_usd, SPEC.budget_usd);
  assert.deepEqual({ ...saved.visual, avatar_max_calls: undefined }, { ...SPEC.visual, avatar_max_calls: undefined });
  assert.equal(saved.visual.avatar_max_calls, 40);
  assert.equal(saved.adaptation?.calls_before, 48); assert.equal(saved.adaptation?.calls_after, 40); assert.equal(saved.adaptation?.previous_max_calls, null);
  assert.equal(h.row().id, "4290175a-f7b4-49a8-9ec5-2977b98d486a", "mismo episodio, ningún episodio nuevo");
  // Doble clic / segunda confirmación: ni otro guardado ni otro trabajo ni otro cargo.
  const again = await adaptAction(h.d, h.row().id, { action: "adaptar", confirm: true, maxCalls: 40 });
  assert.equal(again.status, 409); assert.equal(h.calls.save, 1); assert.equal(h.calls.dispatch, 1); assert.equal(h.calls.authorize, 1);
});

test("si la disponibilidad cambió desde la vista previa, no se aplica: se muestra la propuesta nueva", async () => {
  const h = harness({ check: quota(40, 4) });
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", confirm: true, maxCalls: 40 });
  assert.equal(r.status, 409); assert.equal((r.body as unknown as Body).code, "CAMBIO"); assert.equal((r.body as unknown as Body).proposal.maxCalls, 36);
  assert.equal(h.calls.save, 0); assert.equal(h.calls.dispatch, 0);
});

test("sin capacidad hoy: no se adapta a casi nada; dice cuándo se restablece y conserva el episodio", async () => {
  const h = harness({ check: quota(40, 39) });
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", preview: true });
  assert.equal(r.status, 409); assert.equal(r.body.code, "SIN_CAPACIDAD");
  assert.match(String(r.body.error), /39 de 40 llamadas usadas.*00:00 hora de Cancún; tu episodio se conserva/);
  assert.equal(h.calls.save, 0);
});

test("bloqueo preventivo: otro proveedor sin capacidad (antes o después del ajuste) → nada se guarda ni se inicia", async () => {
  const otherBlock = (n: ProviderNeeds) => n.imagesCalls! > 65 ? { ready: false, providers: [], failure: { provider: "recraft", reason: "daily request quota", quota: { max: 65, today: 0, calls: n.imagesCalls!, timezone: "America/Cancun" } } } : null;
  const h = harness({ check: quota(40, 0, otherBlock) });
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", confirm: true, maxCalls: 40 });
  assert.equal(r.status, 409); assert.equal(r.body.code, "PROVEEDOR_NO_LISTO"); assert.match(String(r.body.error), /Recraft/);
  assert.equal(h.calls.save, 0); assert.equal(h.calls.dispatch, 0);
  const saldo = harness({ check: async () => ({ ready: false, providers: [], failure: { provider: "elevenlabs", reason: "supplier balance unavailable" } }) });
  const s = await adaptAction(saldo.d, saldo.row().id, { action: "adaptar", preview: true });
  assert.equal(s.status, 409); assert.equal(s.body.code, "OTRO_BLOQUEO"); assert.match(String(s.body.error), /ElevenLabs \(voz\): no se pudo verificar un saldo suficiente/);
  const caido = harness({ check: async () => { throw new Error("rpc"); } });
  assert.equal((await adaptAction(caido.d, caido.row().id, { action: "adaptar", preview: true })).body.code, "SIN_VERIFICAR");
});

test("recuperación: lo ya pagado (clips liquidados) se reutiliza y no cuenta como llamada nueva", async () => {
  const settled = Array.from({ length: 10 }, () => ({ op: "avatar_clip" }));
  const h = harness({ check: quota(40, 36), settled });
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", preview: true });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const p = (r.body as unknown as Body).proposal;
  assert.equal(p.available, 4); assert.equal(p.maxCalls, 14); assert.ok(p.callsAfter <= 4, `nuevas ${p.callsAfter} ≤ 4`);
});

test("ya cabe: no propone cambios; otro dueño: 404; generando o listo: no se adapta", async () => {
  const fits = harness({ check: quota(60, 0) });
  const r = await adaptAction(fits.d, fits.row().id, { action: "adaptar", preview: true });
  assert.equal(r.status, 200); assert.equal(r.body.fits, true); assert.equal(fits.calls.save, 0);
  assert.equal((await adaptAction(harness({ userId: "otro" }).d, "4290175a-f7b4-49a8-9ec5-2977b98d486a", { action: "adaptar", preview: true })).status, 404);
  for (const status of ["generating", "authorized", "ready"]) assert.equal((await adaptAction(harness({ status }).d, "x", { action: "adaptar", preview: true })).status, 409, status);
});

test("UI: botón y propuesta legibles; confirmar desactivado con el motivo si algo no cumple", () => {
  assert.equal(isAvatarQuotaError("Proveedor no listo: HeyGen (avatar): alcanzó su cuota diaria de llamadas. No se hizo ningún cargo."), true);
  assert.equal(isAvatarQuotaError("Proveedor no listo: HeyGen (avatar): este episodio necesita 48 llamadas y el límite diario de la plataforma es 40; no cabe en un día aunque se espere."), true);
  assert.equal(isAvatarQuotaError("Proveedor no listo: ElevenLabs (voz): no se pudo verificar un saldo suficiente."), false);
  const p = { episodeId: "e1", limit: 40, usedToday: 0, available: 40, callsBefore: 48, callsAfter: 40, maxCalls: 40, avatarShotsBefore: 48, avatarShotsAfter: 40,
    replaced: { ilustracion_o_imagen: 8, estudio: 0, transicion: 0 }, durationSeconds: 863, durationPreserved: true, estimateBeforeUsd: 20.22, estimateAfterUsd: 17.77, budgetUsd: 40, withinBudget: true,
    longestOffCameraBefore: 20, longestOffCameraAfter: 40, speakersStillOnCamera: true, readyAfter: true, blockAfter: null, quality: { ok: true, issues: [] } } satisfies AdaptProposal;
  const html = renderToStaticMarkup(<AdaptProposalView id="e1" proposal={p} summary={["El avatar aparecerá 40 veces en lugar de 48."]} onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, /todavía no se ha cambiado nada/); assert.match(html, /aparecerá 40 veces en lugar de 48/);
  assert.match(html, /data-testid="adaptar-confirmar-e1"/); assert.doesNotMatch(html, /adaptar-bloqueo-e1/);
  assert.equal(confirmBlocker(p), null);
  const blocked = renderToStaticMarkup(<AdaptProposalView id="e1" proposal={{ ...p, readyAfter: false, blockAfter: "Recraft (ilustraciones): alcanzó su cuota diaria de llamadas." }} summary={[]} onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(blocked, /data-testid="adaptar-bloqueo-e1"/); assert.match(blocked, /Aun con el ajuste no se puede iniciar: Recraft/);
  assert.match(blocked, /disabled=""[^>]*data-testid="adaptar-confirmar-e1"|data-testid="adaptar-confirmar-e1"[^>]*disabled=""/);
  const root = path.join(__dirname, "../../../app");
  const card = readFileSync(path.join(root, "dashboard/podcast/StudioEpisodeList.tsx"), "utf8");
  assert.match(card, /status === "failed" && isAvatarQuotaError\(media\?\.error\) && <AdaptLimitPanel episodeId=\{episode\.id\}/);
  const wiz = readFileSync(path.join(root, "dashboard/podcast/PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /isAvatarQuotaError\(cur\.episode\.error\) && <AdaptLimitPanel episodeId=\{d\.episodeId\}/);
  assert.match(wiz, /data-testid="adaptar-preparar"/);
  const route = readFileSync(path.join(root, "api/podcast/v3/[id]/route.ts"), "utf8");
  assert.match(route, /body\?\.action === "adaptar" \? await adaptAction\(deps, id, body\)/);
  assert.match(route, /saveAdaptation: .*\n?.*\.update\(\{ spec, estimate, estimated_usd: usd, updated_at: [^}]+\}\)\s*\n?\s*\.eq\("id", x\)\.eq\("user_id", user\.id\)\.in\("status", \["draft", "failed"\]\)/);
});

test("se guarda el spec ORIGINAL sin normalizar: solo se añaden el tope y su registro (nada se completa ni se pierde)", async () => {
  // Spec antiguo: participantes sin «gender» ni «voice_kind» y sin campos de música nuevos (Zod los completaría por defecto).
  const raw = JSON.parse(JSON.stringify(SPEC)) as Record<string, unknown> & { participants: Record<string, unknown>[]; music: Record<string, unknown> };
  for (const p of raw.participants) { delete p.gender; delete p.voice_kind; }
  delete raw.music.intensity; raw.legacy_note = "campo de una versión anterior";
  const h = harness({ rawSpec: raw });
  const r = await adaptAction(h.d, h.row().id, { action: "adaptar", confirm: true, maxCalls: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const saved = h.calls.saved[0].spec as unknown as Record<string, unknown> & { visual: Record<string, unknown> };
  const { adaptation, visual, ...rest } = saved; const { visual: v0, ...rest0 } = raw as unknown as Record<string, unknown> & { visual: Record<string, unknown> };
  assert.deepEqual(rest, rest0, "todo lo demás, idéntico byte a byte (incluido un campo desconocido)");
  assert.deepEqual({ ...visual, avatar_max_calls: undefined }, { ...v0, avatar_max_calls: undefined });
  assert.equal(visual.avatar_max_calls, 40); assert.ok(adaptation);
});

test("escenario de referencia (prueba, no gasto): 48 → 40 llamadas, 862,8 s conservados, USD 20,22 → 17,77", async () => {
  const before = await preflight(SPEC, planningProviders());
  const adapted = { ...SPEC, visual: { ...SPEC.visual, avatar_max_calls: 40 } };
  const after = await preflight(adapted, planningProviders());
  assert.equal(providerNeeds(SPEC, before, [], { prepare: true }).avatarCalls, 48);
  assert.equal(providerNeeds(adapted, after, [], { prepare: true }).avatarCalls, 40);
  const dur = (p: typeof before) => p.plan.shots[p.plan.shots.length - 1].end;
  assert.equal(Math.round(dur(before) * 10) / 10, 862.8); assert.equal(dur(after), dur(before), "duración idéntica");
  assert.equal(after.ttsChars, before.ttsChars, "narración idéntica (mismos caracteres)"); assert.equal(after.turns.length, before.turns.length);
  assert.equal(before.estimate.totalUsd.toFixed(2), "20.22"); assert.equal(after.estimate.totalUsd.toFixed(2), "17.77");
  const voz = (p: typeof before) => p.estimate.lines.find((l) => l.concept === "voz")!.usd;
  assert.equal(voz(after), voz(before), "la voz no cambia de costo: no se recorta narración");
});

test("el tope se mantiene con duraciones REALES distintas (plan definitivo) y en cualquier reintento", async () => {
  const pf = await preflight(SPEC, planningProviders());
  const cam = (p: ReturnType<typeof planEpisode>) => p.shots.filter((s) => ["avatar_a", "avatar_b", "two_shot", "over_shoulder"].includes(s.kind)).length;
  for (const seed of [1, 2, 3, 4, 5]) {
    // Duraciones reales arbitrarias (la voz real nunca coincide con la estimación).
    const real = pf.turns.map((t, i) => ({ ...t, seconds: 2 + ((i * 37 + seed * 11) % 23) }));
    const plan = planEpisode({ mode: SPEC.mode, turns: real, assets: pf.assets, avatarFrequency: 0.5, avatarMaxSeconds: 20, recreations: true, hasAvatar: { A: true, B: true }, introSeconds: 4, avatarMaxShots: 40 });
    assert.ok(cam(plan) <= 40, `semilla ${seed}: ${cam(plan)}`);
    assert.deepEqual(planIssues(plan), []);
    const total = real.reduce((n, t) => n + t.seconds, 4);
    assert.ok(Math.abs(plan.shots[plan.shots.length - 1].end - total) < 1e-6, "cubre exactamente la voz real");
  }
  // Reintento tras liquidar 25 clips: solo se piden los 15 que faltan (total ≤ 40), nunca 40 nuevos.
  const adapted = { ...SPEC, visual: { ...SPEC.visual, avatar_max_calls: 40 } };
  const pf2 = await preflight(adapted, planningProviders());
  assert.equal(providerNeeds(adapted, pf2, Array.from({ length: 25 }, () => ({ op: "avatar_clip" })), { prepare: true }).avatarCalls, 15);
});
