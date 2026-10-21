/** Integración con el gate REAL de pagos (ledger + resultados en memoria), espeak-ng como proveedor simulado. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { NarrationCapError } from "../narrate";
import { buildProduction, PodcastProduction } from "./production";
import { narrateProduction, verifyMaster, speakerSubtitles } from "./narrate-v2";
import { applyTurnAction } from "./turns";
import { espeakVoice, type EspeakCall } from "./espeak-provider";

const has = (b: string) => { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
if (process.env.CI && !has("espeak-ng")) throw new Error("espeak-ng es obligatorio en CI: estas pruebas no pueden omitirse en silencio");
const skip = !has("espeak-ng");
const VA = "voiceAAAA0001", VB = "voiceBBBB0002", DURO = "CeFSZuaHs4SxcBxb9nCr";
const voices = [VA, VB].map((id, i) => ({ voiceId: id, name: `Voz ${i}`, category: "premade", language: "es", accent: null, gender: null, previewUrl: null }))
  .concat([{ voiceId: DURO, name: "duro hans", category: "cloned", language: "es", accent: null, gender: null, previewUrl: null }]);
const ENV = { PRIVATE_VOICE_GRANTS: `${DURO}=owner@example.com` };
const OWNER = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "owner@example.com", email_confirmed_at: "2026-01-01" }, OTHER = { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "otro@example.com", email_confirmed_at: "2026-01-01" };
const EP = { id: "22222222-2222-4222-8222-222222222222", user_id: "aaaaaaaa-0000-4000-8000-000000000001", language: "es" as const };
const DIALOGUE = "A: Bienvenidos, hoy hablamos de huracanes.\n\nB: ¿Por qué se forman en el Caribe?\n\nA: Resulta que necesitan agua de al menos veintiséis grados.\n\nB: ¡No me digas! Quizás por eso duran más.\n\nA: Al final, prepararse es lo importante.";

function harness(fail?: (c: EspeakCall) => void) {
  const log: EspeakCall[] = [], stored = new Map<string, Buffer>(), recs = new Map<string, Buffer>();
  const deps = { ledger: memoryLedgerStore(), results: memoryResultStore(), modelId: "eleven_multilingual_v2",
    voiceFor: (vid: string, settings: { stability: number; style: number } | null) => ({ provider: espeakVoice(vid, settings, log, (v) => (v === VA || v === DURO ? 0 : 1), fail), identity: getVoiceIdentity("es", vid, settings ?? undefined) }),
    getRecording: async (p: string) => { const b = recs.get(p); if (!b) throw new Error("RECORDING_MISSING"); return b; },
    putAudio: async (p: string, b: Buffer) => { stored.set(p, b); }, capUsd: null as number | null, music: null };
  return { deps, log, stored, recs };
}
const conv = (style: "standard" | "emotional", viewer = OWNER, vA = DURO) => buildProduction({ mode: "conversation", style, dialogue: DIALOGUE,
  participants: [{ id: "A", name: "Hans", voiceId: vA }, { id: "B", name: "Invitada", role: "curiosa", voiceId: VB }] }, voices, viewer, ENV);

test("A/B: cada turno se sintetiza SOLO con la voz de su participante; repetir no vuelve a llamar", { skip }, async () => {
  const b = conv("emotional"); assert.ok(b.ok); const prod = (b as { production: PodcastProduction }).production;
  const h = harness();
  const out = await narrateProduction(h.deps, EP, prod);
  assert.equal(h.log.length, 5);
  for (const c of h.log) { const turn = prod.turns.find((t) => t.text === c.text)!; assert.equal(c.voiceId, turn.speaker === "A" ? DURO : VB, `turno ${turn.id}`); }
  assert.deepEqual(out.timeline.map((t) => t.speaker), ["A", "B", "A", "B", "A"]);
  assert.equal(new Set(out.timeline.map((t) => t.sha256)).size, 5);
  const v = await verifyMaster(saveTmp(h.stored.get(out.audioPath)!));
  assert.ok(v.ok, v.issues.join(", "));
  assert.match(speakerSubtitles(out.timeline, { A: "Hans", B: "Invitada" })[1].text, /^\[Invitada\]/);
  const again = await narrateProduction(h.deps, EP, prod);
  assert.equal(h.log.length, 5, "0 llamadas nuevas al reanudar");
  assert.equal(again.reusedSegments, 5);
  // Editar UN turno → exactamente una síntesis nueva
  const edited = PodcastProduction.parse({ ...prod, turns: prod.turns.map((t) => t.id === "T004" ? { ...t, text: "¡Vaya! No lo sabía." } : t) });
  await narrateProduction(h.deps, EP, edited);
  assert.equal(h.log.length, 6); assert.equal(h.log[5].voiceId, VB);
});

test("emocional vs estándar: ajustes y velocidad solo cuando el significado lo justifica; estándar = identidad previa", { skip }, async () => {
  const std = (conv("standard") as { production: PodcastProduction }).production, emo = (conv("emotional") as { production: PodcastProduction }).production;
  const h1 = harness(); await narrateProduction(h1.deps, EP, std);
  assert.ok(h1.log.every((c) => c.speed === undefined && c.settings === null));
  const h2 = harness(); await narrateProduction(h2.deps, EP, emo);
  assert.ok(h2.log.some((c) => c.speed !== undefined), "algún turno cambia de ritmo");
  assert.ok(h2.log.some((c) => c.speed === undefined), "no es una ralentización global");
  assert.equal(getVoiceIdentity("es", VA).voiceSettingsJson, getVoiceIdentity("es", VA, undefined).voiceSettingsJson, "claves de caché previas intactas");
});

test("mixto: turnos con grabación propia NO llaman a TTS y conservan su hash", { skip }, async () => {
  const prod0 = (conv("standard") as { production: PodcastProduction }).production;
  const h = harness();
  const ep = { ...EP, status: "draft", production: prod0 };
  let saved: Record<string, unknown> = {};
  const deps = (body: Record<string, unknown>, userId = "aaaaaaaa-0000-4000-8000-000000000001") => ({ userId, episode: ep, body, signUpload: async () => "tok", download: async (p: string) => h.recs.get(p) ?? null, save: async (patch: Record<string, unknown>) => { saved = patch; ep.production = patch.production as PodcastProduction; return true; } });
  const hashes: Record<string, string> = {};
  for (const t of prod0.turns.filter((x) => x.speaker === "A")) {
    const ticket = await applyTurnAction(deps({ action: "ticket", mime: "audio/wav", size: 1000 }));
    assert.equal(ticket.status, 200);
    const p = ticket.body.path as string, wav = recWav(t.text);
    h.recs.set(p, wav); hashes[t.id] = createHash("sha256").update(wav).digest("hex");
    assert.equal((await applyTurnAction(deps({ action: "attach", turnId: t.id, path: p }))).status, 200);
  }
  assert.equal((saved.estimated_usd as number) > 0, true);
  const out = await narrateProduction(h.deps, EP, ep.production);
  assert.equal(h.log.length, 2, "solo los 2 turnos de B");
  assert.ok(h.log.every((c) => c.voiceId === VB));
  for (const e of out.timeline.filter((x) => x.source === "own_recording")) assert.equal(e.sha256, hashes[e.turn_id]);
  // seguridad: otra cuenta / ruta ajena
  assert.equal((await applyTurnAction(deps({ action: "edit", turnId: "T001", text: "x" }, "bbbbbbbb-0000-4000-8000-000000000002"))).status, 404);
  assert.equal((await applyTurnAction(deps({ action: "attach", turnId: "T001", path: "u-other/podcasts/x/uploads/y" }))).status, 403);
});

test("El Duro: solo su dueño; otra cuenta no puede usarlo; A y B nunca la misma voz", () => {
  assert.equal(conv("standard", OWNER).ok, true);
  const other = conv("standard", OTHER); assert.equal(other.ok, false);
  const same = buildProduction({ mode: "conversation", style: "standard", dialogue: DIALOGUE, participants: [{ id: "A", voiceId: VA }, { id: "B", voiceId: VA }] }, voices, OWNER, ENV);
  assert.equal(same.ok, false);
});

test("errores: límite antes de pagar; timeout ambiguo bloquea sin volver a llamar", { skip }, async () => {
  const prod = (conv("standard") as { production: PodcastProduction }).production;
  const h = harness(); h.deps.capUsd = 0;
  await assert.rejects(narrateProduction(h.deps, EP, prod), NarrationCapError); assert.equal(h.log.length, 0);
  let n = 0;
  const h2 = harness(() => { if (++n === 2) throw new Error("socket hang up (timeout)"); });
  await assert.rejects(narrateProduction(h2.deps, EP, prod));
  const calls = h2.log.length;
  await assert.rejects(narrateProduction(h2.deps, EP, prod), ReconciliationRequiredError);
  assert.equal(h2.log.length, calls, "el segmento incierto no se vuelve a pedir");
});

function saveTmp(b: Buffer) { const f = path.join(mkdtempSync(path.join(tmpdir(), "m-")), "a.m4a"); writeFileSync(f, b); return f; }
function recWav(text: string) { const d = mkdtempSync(path.join(tmpdir(), "rec-")), f = path.join(d, "r.wav"); execFileSync("espeak-ng", ["-v", "es", "-p", "20", "-w", f, text]); return Buffer.from(readFileSync(f)); }
