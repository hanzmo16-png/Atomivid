/** Simulated Anthropic Messages API for the LOCAL documentary rehearsal (USD 0, loopback only, never a real key).
 * Speaks the provider formats the production code parses: cited web-search research, fragments-v1 writer,
 * catalog-v1 reviewer and per-block visual planning. Each topic's FIRST draft carries one realistic editorial defect;
 * the simulated writer repairs it ONLY when the correction prompt carries the located instruction for it, and the
 * simulated reviewer judges the narration it actually receives. It tests the orchestration, not model quality.
 * Uso: PORT=54520 LOG=/ruta/mock-doc.jsonl npx tsx scripts/harness/e2e/longform-rehearsal/mock-documentary-anthropic.ts */
import http from "node:http";
import fs from "node:fs";
import { creativeFixture } from "@/lib/video/long-form/editorial.test-fixtures";

const PORT = Number(process.env.PORT ?? 54520), LOG = process.env.LOG;
const log = (o: object) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); };

type Topic = { key: string; match: RegExp; sources: { url: string; title: string; text: string }[]; facts: string[]; scenes: string[]; era?: string;
  defect: "closing-coda" | "middle-repeat" | "unsupported" | "late-answer" | "none" };
const TOPICS: Topic[] = [
  { key: "voyager", match: /voyager/i, defect: "closing-coda",
    sources: [{ url: "https://www.nasa.gov/voyager-1-fds", title: "NASA: Voyager 1 flight data subsystem", text: "Engineers moved code away from a failed memory chip in the flight data subsystem." },
      { url: "https://www.jpl.nasa.gov/voyager-signal", title: "JPL: Voyager 1 resumes sending science data", text: "On April 20, 2024 the spacecraft returned usable engineering data for the first time since November 2023." }],
    facts: ["El 14 de noviembre de 2023 Voyager 1 empezó a enviar un patrón repetitivo sin sentido desde más allá del sistema solar.",
      "La señal tarda casi un día completo en llegar a la Tierra y llega con una potencia diminuta.",
      "Los ingenieros localizaron la falla en un chip de memoria del subsistema de datos de vuelo.",
      "No había forma de reparar el hardware, así que reescribieron el código para esquivar el chip dañado.",
      "El 20 de abril de 2024 la nave volvió a enviar datos de ingeniería legibles.",
      "La misión sigue viva con energía cada vez más escasa y apagando instrumentos uno a uno.",
      "Cada arreglo a distancia enseña cómo mantener viva una máquina que nadie puede tocar."],
    scenes: ["Voyager spacecraft drifting in deep space", "Deep Space Network radio dish at night", "engineers reviewing telemetry on monitors", "old computer memory chip close up", "control room celebrating restored signal", "golden record on a spacecraft"] },
  { key: "oceano", match: /oc[eé]ano/i, defect: "middle-repeat",
    sources: [{ url: "https://oceanexplorer.noaa.gov/deep", title: "NOAA Ocean Explorer: the deep sea", text: "Pressure at the bottom of the Mariana Trench exceeds 1,000 times the pressure at sea level." },
      { url: "https://www.whoi.edu/trieste", title: "WHOI: the Trieste dive", text: "In 1960 the bathyscaphe Trieste reached the Challenger Deep with two men aboard." }],
    facts: ["A once kilómetros de profundidad la presión aplasta cualquier submarino común.",
      "En 1960 el batiscafo Trieste llegó al fondo de la fosa de las Marianas con una ventana agrietada.",
      "Los peces caracol viven a ocho mil metros con huesos casi sin calcio.",
      "Las fuentes hidrotermales alimentan ecosistemas enteros sin luz solar.",
      "El fondo marino está menos cartografiado que la superficie de Marte.",
      "Cada expedición nueva describe especies que nadie había visto antes.",
      "Explorar el fondo es todavía más difícil que llegar a la órbita."],
    scenes: ["deep sea submersible lights in darkness", "bathyscaphe on a ship deck", "translucent deep sea fish", "hydrothermal vent chimney underwater", "sonar map of the seafloor", "research vessel at sea"] },
  { key: "roma", match: /roman|roma\b/i, defect: "unsupported", era: "5th century",
    sources: [{ url: "https://www.britannica.com/fall-of-rome", title: "Britannica: Fall of the Western Roman Empire", text: "In 476 Odoacer deposed Romulus Augustulus, the last emperor in the West." },
      { url: "https://www.metmuseum.org/late-rome", title: "The Met: Late Roman economy", text: "Silver content of Roman coinage collapsed during the third-century crisis." }],
    facts: ["En el año 476 un general depuso al último emperador de Occidente sin una sola batalla.",
      "Roma llevaba más de un siglo dividida en dos mitades con capitales distintas.",
      "La crisis del siglo tercero vació la moneda de plata casi por completo.",
      "Los ejércitos fronterizos dependían cada vez más de pactos con pueblos germánicos.",
      "La mitad oriental sobrevivió casi mil años más con capital en Constantinopla.",
      "La caída fue de una mitad del imperio, no de todo el mundo romano.",
      "Las ciudades de Occidente se fueron vaciando durante generaciones."],
    scenes: ["roman forum ruins at dawn", "ancient roman silver coins", "roman legion marching on a stone road", "constantinople walls", "abandoned roman villa", "roman marble bust"] },
  { key: "agujero", match: /agujero negro/i, defect: "late-answer",
    sources: [{ url: "https://science.nasa.gov/black-holes", title: "NASA: Black holes", text: "A black hole is a region where gravity is so strong that not even light can escape." },
      { url: "https://eventhorizontelescope.org/m87", title: "EHT: First image of a black hole", text: "In 2019 the Event Horizon Telescope released the image of the shadow of M87*." }],
    facts: ["Un agujero negro es masa tan concentrada que ni la luz escapa de su horizonte.",
      "El horizonte de sucesos no es una superficie sólida sino un límite sin retorno.",
      "Cerca del horizonte el tiempo transcurre más despacio para un observador lejano.",
      "En 2019 se publicó la imagen de la sombra del agujero negro de la galaxia M87.",
      "El tamaño del horizonte crece con la masa del objeto que lo forma.",
      "Al fundirse, dos agujeros negros sacuden el espacio con ondas gravitacionales.",
      "Lo que ocurre dentro del horizonte sigue fuera del alcance de cualquier observación."],
    scenes: ["artist impression of a black hole accretion disk", "radio telescope array under stars", "spiral galaxy in space", "gravitational lensing of starlight", "observatory dome at night", "astronomer studying data"] },
  { key: "ia", match: /inteligencia artificial/i, defect: "none",
    sources: [{ url: "https://www.computerhistory.org/ai", title: "Computer History Museum: AI", text: "The 1956 Dartmouth workshop is widely considered the founding event of artificial intelligence." },
      { url: "https://www.nature.com/deep-learning", title: "Nature: Deep learning", text: "Deep learning methods improved dramatically with larger datasets and graphics processors." }],
    facts: ["En 1956 un grupo de investigadores prometió avanzar mucho en un solo verano de trabajo.",
      "Los primeros programas jugaban a las damas pero fallaban fuera del tablero.",
      "Dos inviernos de financiación casi acabaron con el campo en los setenta y ochenta.",
      "Las redes neuronales volvieron con más datos y procesadores gráficos baratos.",
      "Los modelos de lenguaje actuales aprenden patrones a partir de enormes cantidades de texto.",
      "Las promesas rápidas fallaron una y otra vez mientras el trabajo paciente avanzaba.",
      "La pregunta abierta ya no es si funciona sino cómo usarla con criterio."],
    scenes: ["vintage computer room with mainframes", "checkers board game", "old research lab with punch cards", "graphics processor chip close up", "data center server racks", "person typing on a laptop"] },
];
const DEFECT_TEXT = {
  "middle-repeat": "Como ya dijimos antes, la presión allí abajo es enorme y el fondo es muy, muy profundo, como ya sabemos.",
  unsupported: "Murieron exactamente tres millones de soldados romanos en esa última década, una cifra que lo explica todo.",
  "late-answer": "Antes de hablar de agujeros negros conviene repasar con calma mucha historia de la astronomía antigua y moderna.",
};
const topicOf = (text: string) => TOPICS.find(t => t.match.test(text)) ?? TOPICS[0];

function draft(t: Topic, prompt: string) {
  const beats = Number(/~(\d+) beats/.exec(prompt)?.[1] ?? 7), total = Number(/Presupuesto de narración: (\d+) palabras/.exec(prompt)?.[1] ?? 1000);
  const per = Math.round(total / beats);
  const history = (() => { try { return JSON.parse(/HISTORIAL CREATIVO RECIENTE[^\n]*\n(.*)\n/.exec(prompt)?.[1] ?? "[]"); } catch { return []; } })();
  const correction = prompt.includes("CORRECCIÓN OBLIGATORIA");
  // The writer fixes its defect only when the correction names it (block + problem); Rome needs the escalated instruction.
  // Fair to old and new feedback: any wording that names the block / the problem is understood.
  const fixed = correction && (t.defect === "middle-repeat" ? /bloque 3[\s\S]{0,120}repite sin avanzar/i.test(prompt)
    : t.defect === "unsupported" ? /LA CORRECCIÓN ANTERIOR NO LO RESOLVIÓ/.test(prompt)
    : t.defect === "late-answer" ? /primera respuesta/i.test(prompt) : true);
  // Like a real writer reading the account history: never reuse an opening already used by a recent script.
  const used = JSON.stringify(history);
  const shift = [...t.facts.keys()].find(s => !used.includes(t.facts[s].split(" ").slice(0, 8).join(" "))) ?? 0;
  const narr: string[] = [];
  for (let i = 0; i < beats; i++) {
    const lead = t.facts[(i + shift) % t.facts.length];
    const words: string[] = lead.split(" ");
    let k = 0; while (words.length < per) { words.push(...`Detalle ${i + 1}.${++k}: ${t.facts[(i + k) % t.facts.length].toLowerCase()}`.split(" ")); }
    narr.push(words.slice(0, per).join(" ").replace(/[^.]$/, m => m + "."));
  }
  if (!fixed && t.defect === "middle-repeat") narr[2] = DEFECT_TEXT["middle-repeat"] + " " + narr[2];
  if (!fixed && t.defect === "unsupported") narr[3] = DEFECT_TEXT.unsupported + " " + narr[3];
  if (!fixed && t.defect === "late-answer") narr[0] = DEFECT_TEXT["late-answer"] + " " + narr[0];
  if (t.defect === "closing-coda") narr[beats - 1] = "Lo que queda es una lección sobre máquinas que nadie puede tocar. " + narr[beats - 1];
  const cd = creativeFixture(narr);
  const q = (i: number) => ({ beatIndex: i, quote: narr[i].split(" ").slice(0, 7).join(" ") });
  Object.assign(cd, { signatureDetail: q(1), shareableLine: q(beats - 1), protectInEdit: [q(0), q(2), q(beats - 1)],
    avoidedPatterns: history.length ? ["Apertura con saludo", "Misterio aplazado", "Cierre con pregunta genérica"] : [] });
  const plan = { fragment: "plan", creativeDirection: cd, title: t.sources[0].title.split(":")[1]?.trim() || t.key, workingTitleOptions: [t.key], hook: narr[0].split(". ")[0] + ".",
    storyPlan: { centralQuestion: `¿Qué explica ${t.key}?`, openingPromise: "Seguir la evidencia.", firstAnswer: t.facts[0], endingAnswer: t.facts[4],
      sections: narr.map((_, i) => ({ beatIndex: i, newInformation: t.facts[i % t.facts.length], consequence: "Cambia lo que entendemos.", tension: i % 2 ? "reflection" : "rise" })) } };
  const out = [JSON.stringify(plan), ...narr.map((narration, index) => JSON.stringify({ fragment: "beat", index, type: index === 0 ? "hook" : index === beats - 1 ? "payoff" : "discovery",
    purpose: t.facts[index % t.facts.length], narration, claims: [], emotionalTone: "curious" }))];
  return { text: out.join("\n"), fixed, beats };
}

function review(t: Topic, body: { script: { beats: { narration: string }[] }; narrationExcerpts: { id: string; beatIndex: number }[] }) {
  const n = body.script.beats.length, ex = (b: number) => body.narrationExcerpts.find(e => e.beatIndex === b)!.id;
  const sections = body.script.beats.map((b, i) => ({ excerptId: ex(i), contribution: `Aporta el hecho del bloque ${i + 1}.`,
    function: i === 0 ? "setup" : i === n - 1 ? "resolution" : "new_information" }));
  let ending = { resolvesPromise: true, evidence: { excerptId: ex(n - 1) }, explanation: "El cierre responde la pregunta central con lo que muestran las fuentes." };
  const firstLate = body.script.beats[0].narration.startsWith("Antes de hablar");
  const findings: object[] = [{ kind: "spoken_clarity", severity: "suggestion", evidence: [{ excerptId: ex(1) }], explanation: "Una frase es larga para leer en voz alta.", repair: "Divídela." }];
  body.script.beats.forEach((b, i) => {
    if (b.narration.startsWith("Como ya dijimos antes")) sections[i] = { ...sections[i], function: "restatement", contribution: "Repite la presión y la profundidad ya explicadas." };
    if (b.narration.includes("exactamente tres millones")) findings.push({ kind: "unsupported_claim", severity: "blocking", evidence: [{ excerptId: ex(i) }],
      explanation: "La cifra de tres millones de soldados no aparece en el material.", repair: "Elimina la cifra o atribúyela a una fuente concreta del material." });
  });
  if (t.defect === "closing-coda") { // Voyager pattern: resolution in the penultimate block, closing reflection + CTA labelled restatement.
    sections[n - 1] = { ...sections[n - 1], function: "restatement", contribution: "Reflexión final, frase memorable y CTA breve." };
    sections[n - 2] = { ...sections[n - 2], function: "resolution" };
    ending = { ...ending, evidence: { excerptId: ex(n - 2) } };
  }
  return { sections, firstAnswer: firstLate ? { delivered: false, evidence: { excerptId: ex(0) }, explanation: "La apertura aplaza el dato central con un preámbulo." }
    : { delivered: true, evidence: { excerptId: ex(0) }, explanation: "El primer dato llega en la apertura." }, ending, findings };
}

http.createServer((req, res) => {
  const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    const send = (status: number, payload: object) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) return send(404, { type: "error", error: { type: "not_found_error", message: req.url } });
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
    const prompt = String(body.messages?.[0]?.content ?? "");
    const message = (content: object[], kind: string, extra: object = {}) => { const out = JSON.stringify(content).length;
      log({ kind, ...extra, inChars: prompt.length });
      return send(200, { id: `msg_sim_${Date.now()}`, type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
        content, usage: { input_tokens: Math.ceil((system.length + prompt.length) / 4), output_tokens: Math.ceil(out / 4), server_tool_use: { web_search_requests: kind === "research" ? 1 : 0 } } }); };
    if ((body.tools ?? []).some((x: { name?: string }) => x.name === "web_search")) {
      const t = topicOf(prompt);
      return message([{ type: "server_tool_use", id: "srvtoolu_sim", name: "web_search", input: { query: t.key } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_sim", content: t.sources.map(s => ({ type: "web_search_result", url: s.url, title: s.title, encrypted_content: "sim", page_age: null })) },
        ...t.sources.map(s => ({ type: "text", text: s.text, citations: [{ type: "web_search_result_location", url: s.url, title: s.title, cited_text: s.text, encrypted_index: "sim" }] }))], "research", { topic: t.key });
    }
    if (/guionista documental/.test(system)) {
      const t = topicOf(/Tema: ([^\n]*)/.exec(prompt)?.[1] ?? prompt); const d = draft(t, prompt);
      return message([{ type: "text", text: d.text }], "writer", { topic: t.key, correction: prompt.includes("CORRECCIÓN OBLIGATORIA"), fixed: d.fixed, beats: d.beats,
        instructions: (prompt.match(/^\d+\. (?:Bloque \d+|Guion completo)/gm) ?? []).length, escalated: prompt.includes("LA CORRECCIÓN ANTERIOR NO LO RESOLVIÓ") });
    }
    if (/editor crítico/.test(system)) {
      const p = JSON.parse(prompt); const t = topicOf(JSON.stringify(p.researchPack?.topic ?? ""));
      const r = review(t, p);
      return message([{ type: "text", text: JSON.stringify(r) }], "review", { topic: t.key, rubric: system.includes("CRITERIOS QUE BLOQUEAN"),
        blocking: (r.findings as { severity: string }[]).filter(f => f.severity === "blocking").length + (r.firstAnswer.delivered ? 0 : 1), restatement: r.sections.filter(s => s.function === "restatement").map(s => s.excerptId.split(":")[1]) });
    }
    if (/Planifica escenas/.test(system)) {
      const p = JSON.parse(prompt); const t = topicOf(p.topic ?? "");
      const ex = (p.narrationExcerpts as { id: string; beatIndex: number }[]); const beat = ex[0].beatIndex;
      const visuals = ex.slice(0, 3).map((e, i) => { const d = t.scenes[(beat + i) % t.scenes.length];
        return { excerptId: e.id, description: d, motion: false, subject: d.split(" ").slice(0, 3).join(" "), ...(t.era ? { era: t.era } : {}) }; });
      return message([{ type: "text", text: JSON.stringify({ visuals }) }], "visual", { topic: t.key, beat });
    }
    log({ kind: "unrecognized", system: system.slice(0, 160) });
    return send(400, { type: "error", error: { type: "invalid_request_error", message: "simulador: petición no reconocida" } });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock documentary anthropic ${PORT}`));
