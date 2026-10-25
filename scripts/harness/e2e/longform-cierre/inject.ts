// Ensayo Long Form (cierre, USD 0): guion SINTÉTICO del fixture (sin LLM), persistido por las RPC productivas
// claim/finish_documentary_script_job. La revisión editorial es la del fixture (crítico sintético) y debe pasar la MISMA
// puerta productiva (editorialApprovalError) que usa la pantalla de configuración; si no, falla sin escribir nada.
import fs from "node:fs"; import { randomUUID } from "node:crypto"; import pg from "pg";
import { editorialScriptHash, editorialApprovalError } from "@/lib/video/long-form/editorial";
import { datedEventEvidenceBlockers } from "@/lib/video/long-form/dated-event-preflight";

type Fx = { topic: string; title: string; storyPlan: Record<string, string>; sources: { id: string }[];
  facts: { id: string; beat: number; statement: string; sourceIds: string[] }[]; beats: { type: string; purpose: string; visual: string; quote: string; narration: string }[] };
const fx: Fx = JSON.parse(fs.readFileSync(process.env.FIXTURE!, "utf8"));
const ids = JSON.parse(fs.readFileSync(process.env.IDS_FILE!, "utf8"));
const beats = fx.beats.map((b, i) => ({ type: b.type, purpose: b.purpose, narration: b.narration, emotionalTone: "curious",
  claims: fx.facts.filter((f) => f.beat === i).map((f) => ({ id: f.id, text: f.statement, support: "sourced", sourceIds: f.sourceIds })),
  visuals: [{ description: b.visual, quote: b.quote, motion: false }] }));
const storyPlan = { ...fx.storyPlan, sections: beats.map((b, i) => ({ beatIndex: i, newInformation: b.purpose, consequence: "Avanza la historia de la obra.", tension: i % 3 === 2 ? "reflection" : "rise" })) };
const ev = (i: number) => ({ beatIndex: i, quote: beats[i].narration.split(" ").slice(0, 7).join(" ") });
const review = { sections: beats.map((_, i) => ({ ...ev(i), contribution: `Aportación ${i + 1}`, function: i === beats.length - 1 ? "resolution" : "new_information" })),
  firstAnswer: { delivered: true, evidence: ev(2), explanation: "Primera respuesta concreta: esclusas en lugar de nivel del mar (crítico sintético)." },
  ending: { resolvesPromise: true, evidence: ev(beats.length - 1), explanation: "Resolución fundamentada (crítico sintético)." }, findings: [] };
const editorial = { version: "editorial-v1", status: "approved", scriptHash: editorialScriptHash(beats as never), model: "ensayo-sintetico-sin-llm", corrected: false, storyPlan, reviews: [review], publicationTitle: fx.title };
const script = { topic: process.env.TOPIC ?? fx.topic, beats: beats.map((b, i) => ({ id: `beat-${i + 1}`, ...b })), editorial, sources: fx.sources };
// Puerta de fechas (la misma del preflight y del worker): sin anclar, los visuales de los pasajes fechados se tomarían por
// imagen del hecho y deben bloquearse; con la cita anclada a una frase sin fecha, el guion no presenta el hecho como imagen.
const unanchored = datedEventEvidenceBlockers(beats.map((b) => ({ ...b, visuals: b.visuals.map(({ quote: _q, ...v }) => v) })) as never);
const anchored = datedEventEvidenceBlockers(beats as never);
console.log("DATED_GATE", JSON.stringify({ unanchored: unanchored.length, anchored: anchored.length }));
if (unanchored.length === 0 || anchored.length !== 0) { console.error("la puerta de fechas no se comporta como se espera", unanchored, anchored); process.exit(1); }
const gate = editorialApprovalError({ beats, editorial } as never);
console.log("editorialApprovalError:", gate); if (gate) process.exit(1);
(async () => {
  const c = new pg.Client({ connectionString: process.env.HARNESS_PG_URL }); await c.connect();
  const tok = randomUUID();
  const claim = await c.query("select public.claim_documentary_script_job($1,$2) as r", [ids.jobId, tok]); console.log("claim", JSON.stringify(claim.rows[0].r));
  await c.query("select public.finish_documentary_script_job($1,$2,$3)", [ids.jobId, tok, JSON.stringify(script)]);
  const r = (await c.query("select status,duration_seconds,mode,aspect_ratio,jsonb_array_length(script_json->'beats') n from video_requests where id=$1", [ids.requestId])).rows[0];
  console.log("video_request", JSON.stringify(r)); fs.writeFileSync(process.env.OUT_SCRIPT!, JSON.stringify(script, null, 1)); await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
