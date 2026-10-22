/** Ensayo editorial LOCAL (USD 0, sin red, sin clave de proveedor): el borrador REAL del caso 290de42b («Marco Aurelio y
 * los secretos del estoicismo», 5 min) recorre generateDocumentaryScript por el MISMO camino que producción (puerto
 * `send` con los formatos del proveedor): escritor por fragmentos, revisor con referencias del catálogo de narración y
 * planificación visual por bloque. Las respuestas las da un simulador determinista que reproduce lo que hizo el revisor
 * real en las pasadas 1–2 (sin objeciones bloqueantes, sugerencias de estilo). Escribe el guion APROBADO tal como lo
 * persistiría runScriptJobStep ({topic, beats con id, editorial, sources}) para inyectarlo después por las RPC productivas.
 * Uso: OUT=/ruta/approved.json npx tsx scripts/harness/e2e/longform-rehearsal/editorial-chain.ts */
import fs from "node:fs";
import { generateDocumentaryScript } from "@/lib/video/long-form/documentary-script";
import { editorialApprovalError, EDITORIAL_FEEDBACK_CONTRACT, type EditorialReport } from "@/lib/video/long-form/editorial";
import { CASE_290DE42B_DRAFT, CASE_290DE42B_HISTORY, CASE_290DE42B_SOURCES } from "@/lib/video/long-form/editorial-case-290de42b.test-fixtures";

for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "FAL_KEY"]) if (process.env[k]) throw Error(`${k} presente: el ensayo no usa proveedores reales`);
const OUT = process.env.OUT ?? "approved-script.json";
const TOPIC = process.env.TOPIC ?? "Marco Aurelio y los secretos del estoicismo";
// Escenas en inglés por bloque (como pide el contrato), concretas del tema; nunca personas reales identificables.
const SCENES = [
  ["Roman military camp tents by the Danube river at night, torches", "oil lamp lighting wax writing tablets inside a Roman tent", "empty Roman campaign tent interior with a writing desk"],
  ["Roman villa library with scrolls on marble shelves", "ancient Greek scroll unrolled on a wooden table", "marble bust of a Greek philosopher in a quiet courtyard"],
  ["Roman legion marching along a frontier road, 2nd century", "fortified Roman camp walls above a misty river valley", "deserted ancient city street during a plague, closed doors"],
  ["wax tablet with fresh stylus marks beside a dim oil lamp", "storm clouds over a Roman frontier fort at dusk", "worn leather satchel with scrolls resting on campaign chest"],
  ["dawn light over Roman tents on the Danube frontier", "hand-copied manuscript pages stacked on a monastery desk", "modern reader holding an old book under a window"],
];
const calls: Record<string, number> = { writer: 0, review: 0, visual: 0 };
const text = (t: string) => ({ id: "msg_sim", type: "message", role: "assistant", model: "simulado", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: t }] });
const send = async (params: { model: string; max_tokens: number } & Record<string, unknown>) => {
  const system = typeof params.system === "string" ? params.system : JSON.stringify(params.system);
  const content = String((params.messages as { content: string }[])[0].content);
  if (/guionista documental/.test(system)) {          // escritor (contrato por fragmentos): plan + un fragmento por bloque
    calls.writer++;
    const { beats, ...plan } = CASE_290DE42B_DRAFT;
    return text([JSON.stringify({ fragment: "plan", ...plan }), ...beats.map((b, index) => JSON.stringify({ fragment: "beat", index, ...b }))].join("\n"));
  }
  if (/editor crítico/.test(system)) {               // revisor (catálogo de referencias): sin objeciones, como el real
    calls.review++;
    const p = JSON.parse(content) as { narrationExcerpts: { id: string; beatIndex: number }[] };
    const first = (b: number) => p.narrationExcerpts.find(e => e.beatIndex === b)!.id, n = Math.max(...p.narrationExcerpts.map(e => e.beatIndex)) + 1;
    const fn = ["setup", "new_information", "new_information", "consequence", "resolution"];
    return text(JSON.stringify({
      sections: Array.from({ length: n }, (_, b) => ({ excerptId: first(b), contribution: `Aporte del bloque ${b + 1} (revisor simulado).`, function: fn[b] ?? "new_information" })),
      firstAnswer: { delivered: true, evidence: { excerptId: p.narrationExcerpts.find(e => e.beatIndex === 0 && /:w36$|:w48$/.test(e.id))?.id ?? first(0) }, explanation: "El dato del cuaderno sin título llega antes de las 150 palabras (simulado)." },
      ending: { resolvesPromise: true, evidence: { excerptId: first(n - 1) }, explanation: "El cierre responde la pregunta central y marca la interpretación (simulado)." },
      findings: [{ kind: "spoken_clarity", severity: "suggestion", evidence: [{ excerptId: first(3) }], explanation: "Una frase del bloque 4 es larga para leer en voz alta (simulado).", repair: "Acortarla." }],
    }));
  }
  if (/Planifica escenas/.test(system)) {            // planificación visual por bloque, anclada al catálogo
    const p = JSON.parse(content) as { narrationExcerpts: { id: string; beatIndex: number }[] };
    const beat = p.narrationExcerpts[0].beatIndex; calls.visual++;
    const ex = p.narrationExcerpts.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 3)) === 0).slice(0, 3);
    return text(JSON.stringify({ visuals: ex.map((e, i) => ({ excerptId: e.id, description: SCENES[beat][i % 3], motion: false, subject: SCENES[beat][i % 3].split(" ").slice(0, 2).join(" "), era: "2nd century" })) }));
  }
  throw Error("simulador: petición no reconocida");
};

(async () => {
  let report: EditorialReport | undefined;
  const beats = await generateDocumentaryScript({ researchPack: { topic: TOPIC, sources: CASE_290DE42B_SOURCES, openQuestions: [] }, mode: "curiosity_documentary", language: "es",
    targetDurationSeconds: 300, creativeHistory: CASE_290DE42B_HISTORY, referenceContract: "catalog-v1", writerContract: "fragments-v1", editorialFeedback: EDITORIAL_FEEDBACK_CONTRACT,
    send, onEditorialApproved: r => { report = r; } });
  if (!report) throw Error("sin aprobación editorial");
  const gate = editorialApprovalError({ beats, editorial: report });
  const script = { topic: TOPIC, beats: beats.map((b, i) => ({ id: `beat-${i + 1}`, ...b })), editorial: report, sources: CASE_290DE42B_SOURCES };
  fs.writeFileSync(OUT, JSON.stringify(script));
  console.log("EDITORIAL_CHAIN", JSON.stringify({ calls, corrected: report.corrected, reviews: report.reviews.length, approvalGate: gate ?? "ok",
    protectInEdit0: report.creativeDirection?.protectInEdit[0].quote.slice(0, 40), shareableLine: report.creativeDirection?.shareableLine.quote.slice(0, 40), out: OUT }));
  if (gate) process.exit(1);
})().catch(e => { console.error("EDITORIAL_CHAIN_FAILED", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
