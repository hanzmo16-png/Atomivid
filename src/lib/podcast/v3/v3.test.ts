/** Podcast 3.0 — pruebas puras (sin red, sin ffmpeg, sin proveedores). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioSpec, STUDIO_VERSION, validateSpec, voiceAvailability, EL_DURO_VOICE_ID } from "./spec";
import { parseLabeledScript, narrationTurns, narrationSegments, NARRATION_SEGMENT_WORDS, generateConversation, templateConversation, coherenceIssues } from "./script";
import { planEpisode, planIssues, pickAsset, type VisualAsset } from "./editorial";
import { estimateEpisodeCost, MemoryLedger, paidOnce, opKey, committedUsd, releaseUndelivered, ProviderRejectedError, BudgetExceededError, UnauthorizedChargeError, UncertainChargeError } from "./cost";
import { mixGraph, transitionTimes } from "./audio";
import { shotFrames, wrap, subtitlePages, textLines, FPS } from "./compose";
import { autoMood, trackExpression, BUNDLED_TRACKS, licenseManifest, V2_MOOD_MAP } from "./music-library";
import { defaultDraft, loadDraft, stepErrors, draftToSpec, draftToV2, withVoiceKinds, STEP } from "./wizard";
import { studioAction, authorizeAction, episodeAction, type ApiDeps } from "./api";
import { gatherAssets, turnsFor } from "./pipeline";
import type { AccountVoice } from "@/lib/podcast/voices";

const V = (voiceId: string, name: string, extra: Partial<AccountVoice> = {}): AccountVoice => ({ voiceId, name, category: "premade", language: "es", accent: null, gender: null, previewUrl: null, ...extra } as AccountVoice);
const VOICES = [V("voiceAnaHost1", "Ana"), V("voiceLuisGuest", "Luis"), V(EL_DURO_VOICE_ID, "duro hans", { category: "cloned", isOwner: true } as Partial<AccountVoice>)];
const OWNER = { id: "u1", email: "hans@example.com", email_confirmed_at: "2026-01-01" };
const GRANT = { PRIVATE_VOICE_GRANTS: `${EL_DURO_VOICE_ID}=hans@example.com` };
const spec = (over: Record<string, unknown> = {}) => StudioSpec.parse({ version: STUDIO_VERSION, mode: "dialogo", title: "T", script: "Ana: Hola, ¿qué tal?\nLuis: Muy bien, gracias por invitarme.\nAna: ¿Qué es Europa?\nLuis: Una luna con océano bajo el hielo.", target_minutes: 1,
  participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }],
  visual: {}, music: {}, budget_usd: 5, ...over });

test("spec: conversación válida; voces iguales, sin avatar y El Duro sin concesión se rechazan", () => {
  assert.deepEqual(validateSpec(spec(), VOICES, OWNER, {}), []);
  const same = spec({ participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a" } }, { id: "B", name: "Luis", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "b" } }] });
  assert.ok(validateSpec(same, VOICES, OWNER, {}).some((i) => /distintas/.test(i.message)));
  const noAv = spec({ participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1" }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest" }] });
  assert.ok(validateSpec(noAv, VOICES, OWNER, {}).some((i) => /avatar/.test(i.message)));
  const duro = spec({ mode: "avatar", participants: [{ id: "A", name: "Hans", voice_id: EL_DURO_VOICE_ID, avatar: { kind: "existente", avatar_id: "a" } }] });
  assert.ok(validateSpec(duro, VOICES, OWNER, {}).some((i) => /El Duro no está autorizada/.test(i.message)), "sin concesión: rechazada, nunca sustituida");
  assert.deepEqual(validateSpec(duro, VOICES, OWNER, GRANT), [], "con concesión: válida");
  assert.ok(validateSpec(duro, VOICES, { ...OWNER, email: "otro@example.com" }, GRANT).length > 0, "otra cuenta: rechazada");
});

test("spec: El Duro sin concesión aparece como NO disponible (no se oculta ni se sustituye)", () => {
  const list = voiceAvailability(VOICES, OWNER, {});
  const d = list.find((v) => v.voiceId === EL_DURO_VOICE_ID);
  assert.equal(d?.available, false);
  assert.match(d?.note ?? "", /No disponible: requiere autorización \(PRIVATE_VOICE_GRANTS\)/);
  const granted = voiceAvailability(VOICES, OWNER, GRANT).find((v) => v.voiceId === EL_DURO_VOICE_ID);
  assert.equal(granted?.available, true);
  assert.equal(granted?.kind, "clonada", "con concesión el dueño la elige como voz clonada");
  assert.equal(voiceAvailability(VOICES, { ...OWNER, email: "otra@example.com" }, GRANT).some((v) => v.voiceId === EL_DURO_VOICE_ID), false, "concedida a otra cuenta: oculta");
});

test("asistente: El Duro concedido se guarda voice_kind clonada; sin concesión no se puede avanzar; otra voz sigue sintética", () => {
  const catalog = voiceAvailability(VOICES, OWNER, GRANT);
  const base = defaultDraft();
  const picked = withVoiceKinds({ ...base, modality: "avatar", mode: "avatar", count: 1, title: "T", script: "x".repeat(30), participants: [{ ...base.participants[0], voice_id: EL_DURO_VOICE_ID, voice_kind: "sintetica" }, base.participants[1]] }, catalog);
  assert.equal(picked.participants[0].voice_kind, "clonada");
  assert.equal(draftToSpec(picked).participants[0].voice_kind, "clonada");
  const synth = withVoiceKinds({ ...picked, participants: [{ ...picked.participants[0], voice_id: "voiceAnaHost1", voice_kind: "clonada" }, picked.participants[1]] }, catalog);
  assert.equal(synth.participants[0].voice_kind, "sintetica");
  assert.equal(withVoiceKinds(picked, catalog), picked, "si el tipo ya es correcto no se clona el borrador");
  assert.equal(withVoiceKinds(picked, []), picked, "un catálogo vacío no borra el clon ya guardado");
  const off = voiceAvailability(VOICES, OWNER, {});
  assert.equal(off.find((v) => v.voiceId === EL_DURO_VOICE_ID)?.available, false);
  assert.ok(stepErrors({ ...base, participants: [{ ...base.participants[0], voice_id: EL_DURO_VOICE_ID }, base.participants[1]] }, STEP.voces, { unavailableVoices: off.filter((v) => !v.available).map((v) => v.voiceId) }).some((e) => /no está disponible/));
});

test("spec: foto sin consentimiento explícito no pasa el esquema", () => {
  assert.throws(() => spec({ participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "foto", photo_path: "u1/p.jpg", consent: { given: false, at: "x", text: "xxxxxxxxxxxx" } } }] }));
  assert.throws(() => spec({ participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "foto", photo_path: "u1/../x.jpg", consent: { given: true, at: "x", text: "xxxxxxxxxxxx" } } }] }));
});

test("guion: etiquetas de hablante (nombres, A/B, [B], guiones) → turnos A/B con tipo", () => {
  const p = parseLabeledScript("Ana: Hola a todos.\n— Luis: Gracias, Ana.\nAna: ¿Por qué Europa?\ncontinúa la pregunta\n[Luis]: Porque hay agua.\nAna: Gracias.");
  assert.ok(p);
  assert.deepEqual(p.turns.map((t) => t.speaker), ["A", "B", "A", "B", "A"]);
  assert.equal(p.turns[2].kind, "pregunta");
  assert.match(p.turns[2].text, /continúa la pregunta/);
  assert.equal(p.labels.A, "Ana"); assert.equal(p.labels.B, "Luis");
  assert.equal(parseLabeledScript("Solo un párrafo sin etiquetas."), null);
  assert.equal(parseLabeledScript("A: uno\nB: dos\nC: tres"), null, "más de dos hablantes no es un diálogo A/B");
  assert.deepEqual(parseLabeledScript("Luis: hola\nAna: hola", { A: "Ana", B: "Luis" })!.turns.map((t) => t.speaker), ["B", "A"], "los nombres dados mandan");
});

test("guion: narración con dos voces alterna por párrafo", () => {
  assert.deepEqual(narrationTurns("uno\n\ndos\n\ntres", 2).map((t) => t.speaker), ["A", "B", "A"]);
  assert.deepEqual(narrationTurns("uno\n\ndos", 1).map((t) => t.speaker), ["A", "A"]);
});

test("guion: un párrafo largo de narración se divide en segmentos de oraciones completas (un plano por segmento)", () => {
  // Regresión P1 real (episodio 938479f1): un párrafo de ~55 s quedó en UN turno y por tanto con UNA sola imagen.
  const para = "El cometa interestelar cruzó nuestro sistema solar. Viajaba demasiado rápido para estar atado al Sol, y su brillo cambiaba de forma inesperada. Primero, la velocidad: más de cincuenta kilómetros por segundo. Segundo, la forma: alargada, quizá aplanada. Tercero, el gas: casi invisible. Cada dato cuenta una parte de la historia, y juntos dibujan un visitante que no se parece a nada de lo que conocíamos. Lo que sí sabemos es que vino de otra estrella y que ya se aleja para siempre.";
  const turns = narrationTurns(para, 1);
  assert.ok(turns.length >= 3, `${turns.length} segmentos`);
  assert.equal(turns.map((t) => t.text).join(" "), para, "no se pierde ni se altera texto");
  assert.ok(turns.every((t) => /[.!?…]$/.test(t.text)), "cada segmento termina en oración completa");
  assert.ok(turns.every((t) => t.text.split(" ").length <= NARRATION_SEGMENT_WORDS), "≤ máximo de palabras");
  assert.deepEqual(new Set(turns.map((t) => t.id)).size, turns.length, "ids únicos");
  // Dos voces: los segmentos de un mismo párrafo conservan la voz del párrafo.
  assert.deepEqual([...new Set(narrationTurns(`${para}\n\nCorto.`, 2).map((t) => t.speaker))], ["A", "B"]);
  assert.deepEqual(narrationSegments("Una sola oración sin punto final"), ["Una sola oración sin punto final"]);
});

test("imágenes del estudio: Recraft genera UNA ilustración por turno; la pertinencia no sale de las palabras de la búsqueda", async () => {
  // P1 real (2026-10-28, episodio b9c6784d): las etiquetas de Pexels incluían las palabras de la propia búsqueda, así que
  // un avión, huevos de Pascua o ropa «coincidían» con el turno. Con Recraft no hay búsqueda: cada turno tiene su
  // ilustración y la decide la verificación de la imagen (pipeline.ts), no unas etiquetas.
  const turns = [{ id: "T001", speaker: "A" as const, kind: "pregunta" as const, text: "¿Qué dicen las tablillas cuneiformes de los Anunnaki?" }, { id: "T002", speaker: "B" as const, kind: "respuesta" as const, text: "Hablan de dioses sumerios del cielo y la tierra." }];
  const recraft = { name: "recraft", label: "mock" as const, generateUsd: 0.035, styleUsd: 0.005, async generate() { return { actualUsd: 0.035 }; } };
  const assets = await gatherAssets(turns, recraft, "Anunnaki", false, "Anunnaki y sumerios");
  assert.deepEqual(assets.map((a) => [a.forTurn, a.kind]), [["T001", "ilustracion"], ["T002", "ilustracion"]]);
  const plan = planEpisode({ mode: "narracion", turns: turns.map((t) => ({ ...t, seconds: 5 })), assets, avatarFrequency: 0, avatarMaxSeconds: 20, recreations: false, hasAvatar: { A: false, B: false } });
  assert.deepEqual(plan.shots.map((x) => x.asset_id), ["rc-T001", "rc-T002"], "cada turno usa su propia ilustración");
});

test("generador: LLM simulado coherente se usa; si falla o es incoherente, plantilla determinista", async () => {
  const good = async () => "Ana: Hola, hoy hablamos de volcanes.\nLuis: Gracias por invitarme.\nAna: ¿Qué es un volcán?\nLuis: Una abertura por donde sale magma.\nAna: Gracias.";
  const r1 = await generateConversation({ topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 1 }, good);
  assert.equal(r1.source, "llm"); assert.equal(r1.turns.length, 5);
  const r2 = await generateConversation({ topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 1 }, async () => { throw new Error("x"); });
  assert.equal(r2.source, "plantilla"); assert.match(r2.note ?? "", /plantilla/);
  const r3 = await generateConversation({ topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 1 }, async () => "Ana: monólogo\nAna: otro\nAna: más\nAna: y más");
  assert.equal(r3.source, "plantilla");
  const t = templateConversation({ topic: "la señal Wow!", hostName: "Ana", guestName: "Luis", minutes: 5 });
  assert.deepEqual(coherenceIssues(t), []);
  assert.equal(t[0].kind, "apertura"); assert.equal(t[t.length - 1].kind, "cierre");
  assert.ok(t.some((x) => x.kind === "pregunta") && t.some((x) => x.kind === "reaccion"));
  assert.deepEqual(templateConversation({ topic: "x y z", hostName: "A1", guestName: "B1", minutes: 3 }), templateConversation({ topic: "x y z", hostName: "A1", guestName: "B1", minutes: 3 }), "determinista");
});

const assets: VisualAsset[] = [
  { id: "f1", query: "europa luna hielo", kind: "foto", tags: ["europa", "luna", "hielo"] },
  { id: "f2", query: "oceano agua", kind: "foto", tags: ["oceano", "agua", "océano"] },
  { id: "r1", query: "recreacion europa", kind: "recreacion", tags: ["europa", "oceano"] },
  { id: "x1", query: "gatos", kind: "foto", tags: ["gatos"] },
];

test("editorial: material real antes que recreación; nunca imágenes ajenas al turno ni repetidas", () => {
  assert.equal(pickAsset("La luna Europa tiene hielo", assets, new Set(), true)?.asset.id, "f1");
  assert.equal(pickAsset("Hablemos de Europa", assets, new Set(["f1"]), true)?.asset.id, "r1");
  assert.equal(pickAsset("Hablemos de Europa", assets, new Set(["f1"]), false), null);
  assert.equal(pickAsset("Nada que ver aquí", assets, new Set(), true), null, "sin coincidencias: ninguna (no se fuerza una imagen ajena)");
  const turns = Array.from({ length: 6 }, (_, i) => ({ id: `T00${i + 1}`, speaker: "A" as const, text: "Europa luna hielo océano agua", kind: "narracion" as const }));
  const plan = planEpisode({ mode: "narracion", turns, assets, avatarFrequency: 0, avatarMaxSeconds: 20, recreations: true, hasAvatar: { A: false, B: false }, introSeconds: 3 });
  assert.deepEqual(planIssues(plan), []);
  assert.equal(new Set(plan.assetsUsed).size, plan.assetsUsed.length);
  assert.ok(!plan.assetsUsed.includes("x1"), "la imagen de gatos nunca aparece");
  const rec = plan.shots.find((s) => s.kind === "recreacion");
  assert.equal(rec?.label, "Recreación", "toda recreación lleva la etiqueta en pantalla");
  assert.ok(plan.shots.filter((s) => s.turn_id).every((s) => ["imagen", "recreacion", "archivo", "transicion"].includes(s.kind)), "modo A sin avatar");
});

test("editorial: frecuencia y duración máxima del avatar controlan apariciones; resto del turno → imagen/transición", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: `T${String(i + 1).padStart(3, "0")}`, speaker: "A" as const, text: "x".repeat(600) + " europa", kind: "narracion" as const }));
  const p = planEpisode({ mode: "avatar", turns, assets, avatarFrequency: 0.3, avatarMaxSeconds: 8, recreations: false, hasAvatar: { A: true, B: false } });
  const av = p.shots.filter((s) => s.kind === "avatar_a");
  assert.equal(av.length, 3, "30 % de 10 turnos");
  assert.ok(av.every((s) => s.end - s.start <= 8 + 1e-9));
  assert.equal(p.shots[0].kind, "avatar_a", "el presentador abre el episodio");
  assert.deepEqual(planIssues(p), []);
});

test("editorial: conversación con plano general y primeros planos en el estudio compartido; sin «sobre el hombro»", () => {
  const { turns } = turnsFor(spec());
  const p = planEpisode({ mode: "dialogo", turns: turns.map((t) => ({ ...t, seconds: 4 })), assets, avatarFrequency: 1, avatarMaxSeconds: 30, recreations: true, hasAvatar: { A: true, B: true } });
  const kinds = p.shots.map((s) => s.kind);
  assert.ok(kinds.includes("two_shot") && (kinds.includes("avatar_a") || kinds.includes("avatar_b")), kinds.join());
  assert.ok(!kinds.includes("over_shoulder"), "el oyente oscuro superpuesto se retiró");
  for (const s of p.shots.filter((x) => x.kind === "avatar_a" || x.kind === "avatar_b")) assert.equal(s.kind, s.speaker === "A" ? "avatar_a" : "avatar_b", "el primer plano es de quien habla");
});

test("costos: desglose voz/avatar/imágenes/video/render con tarifas del código", () => {
  const plan = planEpisode({ mode: "avatar", turns: [{ id: "T001", speaker: "A", text: "x".repeat(150), kind: "narracion", seconds: 10 }], assets: [], avatarFrequency: 1, avatarMaxSeconds: 60, recreations: false, hasAvatar: { A: true, B: false } });
  const e = estimateEpisodeCost({ ttsChars: 1000, plan, recreationImages: 2, episodeSeconds: 600, pricing: { elevenLabsUsdPer1kChars: 0.2, scriptInputUsdPer1MTokens: 2, scriptOutputUsdPer1MTokens: 10, renderUsdPerMinute: 0.006, musicUsdPerTrack: 0 } });
  const by = Object.fromEntries(e.lines.map((l) => [l.concept, l.usd]));
  assert.equal(by.voz, 0.2); assert.equal(by.avatar, 0.39); assert.equal(by.imagenes, 0.07); assert.equal(by.video, 0); assert.equal(by.render, 0.108);
  assert.equal(e.totalUsd, 0.768);
});

test("costos: una llamada por clave; reintento reutiliza; rechazo libera; incierto bloquea; sin autorización o sin presupuesto no llama", async () => {
  const L = new MemoryLedger();
  const base = { owner: "u1", episode: "e1", provider: "p", op: "tts", usd: 0.5, budgetUsd: 1, authorized: true };
  let calls = 0;
  const call = async () => { calls++; return { result: "file", actualUsd: 0.5 }; };
  const k1 = opKey({ owner: "u1", episode: "e1", provider: "p", op: "tts", payload: { t: 1 } });
  assert.equal(k1, opKey({ owner: "u1", episode: "e1", provider: "p", op: "tts", payload: { t: 1 } }));
  await paidOnce(L, { ...base, key: k1 }, call);
  const again = await paidOnce(L, { ...base, key: k1 }, call);
  assert.equal(calls, 1); assert.equal(again.reused, true);
  await assert.rejects(paidOnce(L, { ...base, key: "k-other-1", usd: 0.6 }, call), BudgetExceededError);
  assert.equal(calls, 1, "sin presupuesto no se llama al proveedor");
  await assert.rejects(paidOnce(L, { ...base, key: "k2", authorized: false }, call), UnauthorizedChargeError);
  await assert.rejects(paidOnce(L, { ...base, key: "k3", usd: 0.1 }, async () => { throw new ProviderRejectedError("429"); }));
  assert.equal((await L.get("k3"))?.state, "released");
  await paidOnce(L, { ...base, key: "k3", usd: 0.1 }, async () => ({ result: "ok", actualUsd: 0.1 }));
  assert.equal((await L.get("k3"))?.state, "settled", "un rechazo sin cargo se puede reintentar");
  await assert.rejects(paidOnce(L, { ...base, key: "k4", usd: 0.1 }, async () => { throw new Error("timeout"); }));
  assert.equal((await L.get("k4"))?.state, "uncertain");
  await assert.rejects(paidOnce(L, { ...base, key: "k4", usd: 0.1 }, call), UncertainChargeError);
  assert.equal(await committedUsd(L, "e1"), 0.7);
  await L.put({ key: "k5", owner: "u1", episode: "e1", provider: "p", op: "x", state: "reserved", reserved_usd: 0.2, actual_usd: null });
  assert.equal(await releaseUndelivered(L, "e1"), 1);
  assert.equal(await committedUsd(L, "e1"), 0.7, "reserva sin liquidar liberada al no entregar");
  await assert.rejects(paidOnce(L, { ...base, owner: "intruso", key: k1 }, call), /ACCESO_DENEGADO/);
});

test("audio: grafo con ducking por sidechain, fundidos, cortinas y ambiente; sin música no hay cama", () => {
  const g = mixGraph({ total: 60, musicGainDb: -8, stings: true, transitions: [20, 40], ambient: true, music: true }).graph;
  assert.match(g, /sidechaincompress/); assert.match(g, /afade=t=in/); assert.match(g, /afade=t=out:st=56/);
  assert.match(g, /adelay=20000\|20000/); assert.match(g, /amix=inputs=6/);
  const off = mixGraph({ total: 60, musicGainDb: -8, stings: true, transitions: [20], ambient: false, music: false }).graph;
  assert.doesNotMatch(off, /sidechaincompress|\[1:a\]/); assert.match(off, /amix=inputs=1/);
  assert.deepEqual(transitionTimes(Array.from({ length: 13 }, (_, i) => ({ turn_id: `T${i}`, speaker: "A", start: i * 10, end: i * 10 + 9 }))), [59.02, 119.02]);
});

test("música: biblioteca propia CC0 con manifiesto; ambiente automático; puente con Podcast 2.x", () => {
  assert.equal(BUNDLED_TRACKS.length, 8);
  for (const t of BUNDLED_TRACKS) { assert.equal(t.license, "CC0 1.0"); assert.ok(licenseManifest().includes(t.file)); assert.match(trackExpression(t), /^0\.08\*/); }
  assert.equal(autoMood("Un misterio inexplicable: la señal desconocida"), "misterio");
  assert.equal(autoMood("texto neutro"), "documental");
  assert.deepEqual(Object.keys(V2_MOOD_MAP).sort(), ["calm", "enthusiasm", "reflection", "revelation", "suspense"]);
});

test("composición: fotogramas acumulados = duración del audio (sincronía A/V); subtítulos paginados sin perder texto", () => {
  const shots = [{ start: 0, end: 3.013 }, { start: 3.013, end: 7.5 }, { start: 7.5, end: 12.987 }];
  const f = shotFrames(shots, 12.987);
  assert.equal(f.reduce((a, b) => a + b, 0), Math.round(12.987 * FPS));
  const long = "palabra ".repeat(60).trim();
  const pages = subtitlePages(long, 40);
  assert.equal(pages.join(" ").replace(/\n/g, " ").split(" ").length, 60);
  assert.ok(pages.every((p) => p.split("\n").length <= 2));
  assert.equal(wrap("a b c", 100), "a b c");
  // Regresión P1 real: cada línea va en su propio drawtext (el salto de línea dentro de un textfile se dibujaba como «□»).
  assert.ok(textLines(long, 40).every((l) => !l.includes("\n") && l.length <= 40));
});

test("asistente: borrador persistente tolerante, validación por paso y especificación", () => {
  const d = { ...defaultDraft(), mode: "dialogo" as const, count: 2 as const, title: "T", script: "Ana: hola que tal\nLuis: muy bien gracias" };
  const restored = loadDraft(JSON.stringify({ ...d, step: 4 }));
  assert.equal(restored.step, 4); assert.equal(restored.title, "T");
  assert.deepEqual(loadDraft("{roto"), defaultDraft());
  assert.ok(stepErrors(defaultDraft(), 0, { unavailableVoices: [] }).length);
  const p4 = stepErrors({ ...d, participants: [{ ...d.participants[0], voice_id: EL_DURO_VOICE_ID }, d.participants[1]] }, 3, { unavailableVoices: [EL_DURO_VOICE_ID] }); // paso «Voces»
  assert.ok(p4.some((e) => /no está disponible/.test(e)));
  assert.ok(stepErrors({ ...d, participants: [{ ...d.participants[0], avatar: { kind: "foto", photo_path: "x", consent: false, consent_at: null } }, d.participants[1]] }, 4, { unavailableVoices: [] }).some((e) => /consentimiento/.test(e)));
  assert.ok(stepErrors(d, 9, { unavailableVoices: [] }).some((e) => /autorizar/.test(e)));
  const s = draftToSpec({ ...d, participants: [{ ...d.participants[0], name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "existente", avatar_id: "a1" } }, { ...d.participants[1], name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }] });
  assert.ok(StudioSpec.safeParse({ version: STUDIO_VERSION, ...s, script: s.script + " suficiente texto" }).success);
  const v2 = draftToV2({ ...d, mode: "narracion", count: 2, script: "uno largo\n\ndos largo", participants: [{ ...d.participants[0], voice_id: "a" }, { ...d.participants[1], voice_id: "b" }] }, true);
  assert.equal(v2.production?.mode, "conversation"); assert.match(v2.script, /^A: uno largo\n\nB: dos largo$/);
  assert.equal(draftToV2({ ...d, mode: "narracion", count: 1 }, false).production, null, "sin v2: flujo 1.x intacto");
});

const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({ userId: "u1", viewer: OWNER, voices: async () => VOICES, enabled: true, llm: null,
  insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }), load: async () => null, authorize: async () => true, dispatch: async () => true, ...over });
const body = (s = spec()) => ({ spec: { ...s, version: undefined } });

test("API: guion por plantilla sin LLM; estimación gratis; crear con estudio apagado → 503; sobre presupuesto → 402", async () => {
  const sc = await studioAction(deps(), { action: "script", topic: "volcanes", hostName: "Ana", guestName: "Luis", minutes: 2 });
  assert.equal(sc.status, 200); assert.equal(sc.body.source, "plantilla"); assert.match(String(sc.body.script), /^Ana: /);
  const est = await studioAction(deps(), { action: "estimate", ...body() });
  assert.equal(est.status, 200); assert.ok((est.body.estimate as { totalUsd: number }).totalUsd > 0);
  assert.equal((await studioAction(deps({ enabled: false }), { action: "create", ...body() })).status, 503);
  assert.equal((await studioAction(deps(), { action: "create", ...body(spec({ budget_usd: 0.01 })) })).status, 402);
  assert.equal((await studioAction(deps({ insert: async () => "missing" }), { action: "create", ...body() })).status, 503, "migración no aplicada: 503, nada se cobra");
  assert.equal((await studioAction(deps(), { action: "create", ...body() })).status, 200);
});

test("API: El Duro concedido se guarda clonada para el dueño; otra cuenta y sin concesión se rechazan", async () => {
  const duro = spec({ mode: "avatar", participants: [{ id: "A", name: "Hans", voice_id: EL_DURO_VOICE_ID, voice_kind: "sintetica", avatar: { kind: "existente", avatar_id: "a" } }] });
  const captured: { spec: { participants: { voice_kind: string }[] } | null } = { spec: null };
  const owner = await studioAction(deps({ env: GRANT, insert: async (row) => { const specRow = row.spec; if (specRow && typeof specRow === "object" && "participants" in specRow) captured.spec = specRow as { participants: { voice_kind: string }[] }; return { id: "11111111-1111-4111-8111-111111111111" }; } }), { action: "create", ...body(duro) });
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(captured.spec, "el episodio guardado incluye la especificación");
  assert.equal(captured.spec.participants[0].voice_kind, "clonada");
  const other = await studioAction(deps({ env: GRANT, viewer: { ...OWNER, email: "otra@example.com" } }), { action: "create", ...body(duro) });
  assert.equal(other.status, 400);
  assert.match(String(other.body.error), /El Duro|no está disponible|no autorizada/);
  const off = await studioAction(deps({ env: {} }), { action: "create", ...body(duro) });
  assert.equal(off.status, 400);
  assert.match(String(off.body.error), /no está autorizada/);
});

test("API: aislamiento — foto o avatar de otra cuenta → 403", async () => {
  const foreign = spec({ participants: [{ id: "A", name: "Ana", voice_id: "voiceAnaHost1", avatar: { kind: "foto", photo_path: "otro/podcast-studio/photos/x.jpg", consent: { given: true, at: "x", text: "consentimiento explícito" } } }, { id: "B", name: "Luis", voice_id: "voiceLuisGuest", avatar: { kind: "existente", avatar_id: "a2" } }] });
  assert.equal((await studioAction(deps(), { action: "create", ...body(foreign) })).status, 403);
  assert.equal((await studioAction(deps({ ownsAvatar: async () => false }), { action: "create", ...body() })).status, 403);
});

test("API: autorizar exige confirmación explícita, monto ≥ estimación y ≤ presupuesto; sin duplicar", async () => {
  const row = { id: "e1", user_id: "u1", title: "T", mode: "dialogo", spec: spec(), status: "draft", estimate: {}, estimated_usd: 1, authorized_usd: null, authorized_at: null, run_started_at: null, progress: null, result: null, video_path: null, audio_path: null, cost_usd: null, error: null, created_at: "", updated_at: "" } as const;
  const D = (over: Partial<ApiDeps> = {}) => deps({ load: async () => ({ ...row }) as never, ...over });
  assert.equal((await authorizeAction(D(), "e1", { authorizedUsd: 2 })).status, 400, "sin confirmación");
  assert.equal((await authorizeAction(D(), "e1", { confirm: true, authorizedUsd: 0.5 })).status, 402, "menos que la estimación");
  assert.equal((await authorizeAction(D(), "e1", { confirm: true, authorizedUsd: 6 })).status, 402, "más que el presupuesto");
  assert.equal((await authorizeAction(D({ authorize: async () => false }), "e1", { confirm: true, authorizedUsd: 2 })).status, 409, "carrera: CAS perdido");
  assert.equal((await authorizeAction(D({ load: async () => ({ ...row, status: "generating" }) as never }), "e1", { confirm: true, authorizedUsd: 2 })).status, 409);
  assert.equal((await authorizeAction(D({ load: async () => ({ ...row, user_id: "otro" }) as never }), "e1", { confirm: true, authorizedUsd: 2 })).status, 404);
  const ok = await authorizeAction(D(), "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(ok.status, 200); assert.equal(ok.body.dispatched, true);
});

test("API: autorizado sin arranque se re-despacha sin volver a autorizar ni cambiar el monto", async () => {
  const row = { id: "e1", user_id: "u1", title: "T", mode: "dialogo", spec: spec(), status: "authorized", estimate: {}, estimated_usd: 1, authorized_usd: 2, authorized_at: "t", run_started_at: null, progress: null, result: null, video_path: null, audio_path: null, cost_usd: null, error: null, created_at: "", updated_at: "" };
  let authorized = 0, dispatches = 0;
  const d = deps({ load: async () => ({ ...row }) as never, authorize: async () => { authorized++; return true; }, dispatch: async () => { dispatches++; return false; } });
  const missing = await authorizeAction(d, "e1", {});
  assert.equal(missing.status, 400); assert.equal(authorized, 0); assert.equal(dispatches, 0);
  const again = await authorizeAction(d, "e1", { confirm: true, authorizedUsd: 50 });
  assert.equal(again.status, 200); assert.equal(again.body.dispatched, false); assert.equal(authorized, 0); assert.equal(dispatches, 1);
  assert.match(String(again.body.note), /no se cobra dos veces/);
  const started = await authorizeAction(deps({ load: async () => ({ ...row, run_started_at: "t" }) as never, dispatch: async () => { dispatches++; return true; } }), "e1", { confirm: true });
  assert.equal(started.status, 409); assert.equal(dispatches, 1);
});

test("una segunda generación del mismo episodio no marca el episodio como fallido", async () => {
  const { DuplicateRunError, studioRunErrorFailsEpisode } = await import("./pipeline");
  assert.equal(studioRunErrorFailsEpisode(new DuplicateRunError()), false);
  assert.equal(studioRunErrorFailsEpisode(new Error("almacenamiento")), true);
});

test("API: reintento tras un fallo (reautorizado, con la marca del intento anterior) se puede re-despachar sin otro cargo", async () => {
  const row = { id: "e1", user_id: "u1", title: "T", mode: "dialogo", spec: spec(), status: "authorized", estimate: {}, estimated_usd: 1, authorized_usd: 2, authorized_at: "2026-10-27T03:00:00Z", run_started_at: "2026-10-27T02:00:00Z", progress: null, result: null, video_path: null, audio_path: null, cost_usd: null, error: null, created_at: "", updated_at: "" };
  let authorized = 0, dispatches = 0;
  const d = deps({ load: async () => ({ ...row }) as never, authorize: async () => { authorized++; return true; }, dispatch: async () => { dispatches++; return true; } });
  const again = await authorizeAction(d, "e1", { confirm: true, authorizedUsd: 2 });
  assert.equal(again.status, 200); assert.equal(dispatches, 1); assert.equal(authorized, 0, "no se vuelve a autorizar ni cambia el monto");
  // Un worker ya tomó el episodio DESPUÉS de esta autorización: no se re-despacha.
  const taken = await authorizeAction(deps({ load: async () => ({ ...row, run_started_at: "2026-10-27T03:05:00Z" }) as never, dispatch: async () => { dispatches++; return true; } }), "e1", { confirm: true });
  assert.equal(taken.status, 409); assert.equal(dispatches, 1);
});

test("guard del worker: solo toma un episodio con autorización vigente (o runner perdido); «failed» exige reautorizar", async () => {
  const { supabaseRunGuard } = await import("./store");
  const fake = (row: { status: string; run_started_at: string | null }) => {
    const db = { ...row }; let updates = 0;
    const builder = (mode: "select" | "update", patch?: Record<string, unknown>) => {
      const where: [string, unknown][] = [];
      const match = () => where.every(([k, v]) => (db as Record<string, unknown>)[k] === v);
      const b = {
        eq(k: string, v: unknown) { if (k !== "id") where.push([k, v]); return b; },
        is(k: string, v: unknown) { where.push([k, v]); return b; },
        async maybeSingle() { return { data: { ...db }, error: null }; },
        async select() { if (mode === "update" && match()) { Object.assign(db, patch); updates++; return { data: [{ id: "e" }], error: null }; } return { data: [], error: null }; },
      };
      return b;
    };
    return { db, get updates() { return updates; }, client: { from: () => ({ select: () => builder("select"), update: (p: Record<string, unknown>) => builder("update", p) }) } };
  };
  const ok = fake({ status: "authorized", run_started_at: null });
  assert.equal(await supabaseRunGuard(ok.client as never).acquire("e", "a".repeat(40)), true); assert.equal(ok.db.status, "generating");
  const second = await supabaseRunGuard(ok.client as never).acquire("e", "b".repeat(40));
  assert.equal(second, false, "un segundo worker no gana la carrera");
  const failed = fake({ status: "failed", run_started_at: "2026-10-27T02:00:00Z" });
  assert.equal(await supabaseRunGuard(failed.client as never).acquire("e", "c".repeat(40)), false); assert.equal(failed.updates, 0); assert.equal(failed.db.status, "failed");
  const lost = fake({ status: "generating", run_started_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
  assert.equal(await supabaseRunGuard(lost.client as never).acquire("e", "d".repeat(40)), true, "runner perdido (marca vieja) se puede retomar");
  const live = fake({ status: "generating", run_started_at: new Date().toISOString() });
  assert.equal(await supabaseRunGuard(live.client as never).acquire("e", "e".repeat(40)), false);
});

// Contención de la descarga (PR #231, revisión delta de Grok): portado tal cual.
const EP = "11111111-1111-4111-8111-111111111111";
const episodeRow = (over: Record<string, unknown> = {}) => ({ id: EP, user_id: "u1", title: "Señal", mode: "narracion", spec: spec({ mode: "narracion", output: "video" }), status: "ready", estimate: {}, estimated_usd: 1, authorized_usd: 2, authorized_at: "2026-10-27T03:00:00Z", run_started_at: "2026-10-27T03:01:00Z", progress: null, result: null, video_path: `u1/podcast-studio/${EP}/episodio.mp4`, audio_path: `u1/podcast-studio/${EP}/episodio.mp3`, cost_usd: 1.2, error: null, created_at: "", updated_at: "", ...over }) as never;

test("descarga: solo el dueño, solo «ready», solo su carpeta; otra cuenta, otro episodio o una ruta ajena no firman", async () => {
  const signed: string[] = [];
  const sign = async (p: string) => { signed.push(p); return `signed:${p}`; };
  const own = await episodeAction("u1", episodeRow(), sign);
  assert.equal(own.status, 200);
  assert.equal(own.body.video_url, `signed:u1/podcast-studio/${EP}/episodio.mp4`);
  assert.equal(own.body.audio_url, `signed:u1/podcast-studio/${EP}/episodio.mp3`);
  assert.equal("spec" in (own.body.episode as object), false);
  const nested = await episodeAction("u1", episodeRow({ audio_path: `u1/podcast-studio/${EP}/paid/voz.mp3`, video_path: null }), sign);
  assert.equal(nested.body.audio_url, `signed:u1/podcast-studio/${EP}/paid/voz.mp3`);
  assert.equal(nested.body.video_url, null);
  const before = signed.length;
  const other = await episodeAction("u2", episodeRow(), sign);
  assert.equal(other.status, 404); assert.equal(signed.length, before); assert.equal(JSON.stringify(other.body).includes("episodio.mp4"), false);
  const foreign = [
    `u2/podcast-studio/${EP}/episodio.mp4`,
    `u1/podcast-studio/22222222-2222-4222-8222-222222222222/episodio.mp4`,
    `u1/podcast-studio/${EP}/../../u2/secreto.mp4`,
    `u1/podcast-studio/${EP}/%2e%2e/%2e%2e/u2/secreto.mp4`,
    `u1/podcast-studio/${EP}/../episodio.mp4`,
    `u1\\podcast-studio\\${EP}\\episodio.mp4`,
    `u1/podcast-studio/${EP}`,
  ];
  for (const video_path of foreign) {
    const n = signed.length;
    const out = await episodeAction("u1", episodeRow({ video_path, audio_path: video_path }), sign);
    assert.equal(out.status, 200, video_path);
    assert.equal(out.body.video_url, null, video_path);
    assert.equal(out.body.audio_url, null, video_path);
    assert.equal(signed.length, n, video_path);
  }
  for (const status of ["draft", "authorized", "generating", "failed"]) {
    const n = signed.length;
    const out = await episodeAction("u1", episodeRow({ status }), sign);
    assert.equal(out.body.video_url, null, status);
    assert.equal(out.body.audio_url, null, status);
    assert.equal(signed.length, n, status);
  }
});

test("descarga: solo audio no firma MP4 aunque la fila tenga video_path", async () => {
  const signed: string[] = [];
  const sign = async (p: string) => { signed.push(p); return `signed:${p}`; };
  const audio = spec({ mode: "narracion", output: "audio", visual: { provider: "solo_set", recreations: false } });
  const out = await episodeAction("u1", episodeRow({ spec: audio, video_path: `u1/podcast-studio/${EP}/episodio.mp4`, audio_path: `u1/podcast-studio/${EP}/episodio.mp3` }), sign);
  assert.equal(out.body.video_url, null);
  assert.equal(out.body.audio_url, `signed:u1/podcast-studio/${EP}/episodio.mp3`);
  assert.deepEqual(signed, [`u1/podcast-studio/${EP}/episodio.mp3`]);
});
