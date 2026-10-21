// @ts-nocheck -- harness local de ensayo (depende de pg del banco .e2e-local); excluido del typecheck de la app
// Ensayo LF (Grok): guion SINTÉTICO (sin LLM) persistido por las RPC productivas claim/finish_documentary_script_job.
import fs from "node:fs"; import { randomUUID } from "node:crypto";
import { editorialScriptHash, editorialApprovalError } from "@/lib/video/long-form/editorial";
import pg from "/workspace/atomivid-recraft/.e2e-local/deps/node_modules/pg/lib/index.js";
const map: Record<string,string> = { context: "setup", tension: "escalation", reflection: "insight" };
const raw = JSON.parse(fs.readFileSync(process.env.SCRIPT_FILE ?? "/workspace/atomivid-mission/lf/script-beats.json","utf8"));
const meta = process.env.SCRIPT_META ? JSON.parse(fs.readFileSync(process.env.SCRIPT_META, "utf8")) : null;
const beats = raw.map((b: any) => ({ type: map[b.type] ?? b.type, purpose: b.purpose, narration: b.narration, claims: [], emotionalTone: "curious", visuals: [{ description: b.visual, motion: false }] }));
const storyPlan = meta?.storyPlan ? { ...meta.storyPlan, sections: beats.map((b: any, i: number) => ({ beatIndex: i, newInformation: b.purpose, consequence: "Avanza el argumento.", tension: i % 3 === 2 ? "reflection" : "rise" })) } : { centralQuestion: "¿Por qué flotan las nubes y cuándo llueve?", openingPromise: "Seguir el viaje de una gota de agua.", firstAnswer: "El vapor invisible sube con el aire caliente.",
  endingAnswer: "Flota repartida en gotitas; llueve cuando se unen o crecen como hielo.", sections: beats.map((b: any, i: number) => ({ beatIndex: i, newInformation: b.purpose, consequence: "Avanza el viaje de la gota.", tension: i % 3 === 2 ? "reflection" : "rise" })) };
const ev = (i: number) => ({ beatIndex: i, quote: beats[i].narration.split(" ").slice(0, 7).join(" ") });
const review = { sections: beats.map((_: any, i: number) => ({ ...ev(i), contribution: `Aportación ${i + 1}`, function: i === beats.length - 1 ? "resolution" : "new_information" })),
  firstAnswer: { delivered: true, evidence: ev(1), explanation: "Primera respuesta concreta (crítico sintético del ensayo)." },
  ending: { resolvesPromise: true, evidence: ev(beats.length - 1), explanation: "Resolución fundamentada (crítico sintético del ensayo)." }, findings: [] };
const editorial = { version: "editorial-v1", status: "approved", scriptHash: editorialScriptHash(beats), model: "ensayo-sintetico-sin-llm", corrected: false, storyPlan, reviews: [review], publicationTitle: meta?.title ?? "Cómo se forman las nubes y por qué llueve" };
const ids = JSON.parse(fs.readFileSync("/workspace/atomivid-mission/lf/out/ids.json","utf8"));
const script = { topic: process.env.TOPIC ?? "Cómo se forman las nubes y por qué llueve — ensayo 1080p", beats: beats.map((b: any, i: number) => ({ id: `beat-${i + 1}`, ...b })), editorial, sources: [] };
const gate = editorialApprovalError({ beats, editorial } as any); console.log("editorialApprovalError:", gate); if (gate || process.argv[2] === "check") process.exit(gate ? 1 : 0);
(async () => { const c = new pg.Client({ connectionString: "postgres://postgres@localhost:55432/atomivid?host=/workspace/atomivid-recraft/.e2e-local/run" }); await c.connect();
  const tok = randomUUID();
  const claim = await c.query("select public.claim_documentary_script_job($1,$2) as r", [ids.jobId, tok]); console.log("claim", JSON.stringify(claim.rows[0].r));
  await c.query("select public.finish_documentary_script_job($1,$2,$3)", [ids.jobId, tok, JSON.stringify(script)]);
  const r = (await c.query("select status,duration_seconds,mode,aspect_ratio,jsonb_array_length(script_json->'beats') n from video_requests where id=$1", [ids.requestId])).rows[0];
  console.log("video_request", JSON.stringify(r)); fs.writeFileSync("/workspace/atomivid-mission/lf/out/script-injected.json", JSON.stringify(script, null, 1)); await c.end(); })();
