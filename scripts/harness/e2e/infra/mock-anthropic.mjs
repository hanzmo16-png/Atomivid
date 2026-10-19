// Mock local de la API de mensajes de Anthropic (USD 0). Responde un guion determinista con el nº de palabras pedido.
import http from "node:http"; import fs from "node:fs";
const LOG = process.env.MOCK_LOG;
const WORDS = "el pulpo común guarda tres corazones que bombean sangre azul por su cuerpo blando mientras explora el fondo marino con ocho brazos curiosos y una mente sorprendente".split(" ");
const IMGX = [null, { text: "volcán", q: "abstract brick texture", alt: "un volcán lejano ruge bajo cielos grises cubiertos de ceniza y piedra fría que nadie ha pisado" }, null, { text: "glaciar", q: "plain concrete wall", alt: "aquel glaciar antiguo cruje despacio mientras témpanos azules caen hacia lagos helados del norte remoto" }];
function script(prompt) {
  const imgx = /\[imgx\]/i.test(prompt);
  const target = Number((prompt.match(/~(\d+) palabras/) ?? [])[1] ?? 70), scenes = Number((prompt.match(/escenas sugerido: (\d+)/) ?? [])[1] ?? 6);
  const per = Math.floor(target / scenes); let extra = target - per * scenes; const out = []; let k = 0;
  for (let i = 0; i < scenes; i++) { const n = per + (extra-- > 0 ? 1 : 0); const w = []; for (let j = 0; j < n; j++) w.push(WORDS[k++ % WORDS.length]);
    const text = w.join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
    const x = imgx ? IMGX[i] : null;
    if (x) { const alt = x.alt.split(" ");
      const ws = Array.from({ length: n }, (_, j) => alt[j % alt.length]); const h = Math.ceil(n / 2);
      const cap = (a) => a.join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
      const t2 = `${cap(ws.slice(0, h))} ${cap(ws.slice(h))}`; // dos oraciones ⇒ dos planos; el 2.º no tiene recurso propio
      out.push({ text: t2, visualQuery: x.q, visualConcepts: [x.q, "plain wall surface"], excludedTerms: [], energy: "medium", emphasisWords: [x.text] }); continue; }
    out.push({ text, visualQuery: `octopus scene ${i + 1}`, visualConcepts: [`octopus scene ${i + 1}`, `ocean floor ${i + 1}`], excludedTerms: [], energy: "medium", emphasisWords: [w[1]] }); }
  return { title: "Los tres corazones del pulpo", segments: out };
}
http.createServer((req, res) => {
  const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
    const b = JSON.parse(Buffer.concat(c).toString() || "{}"); const prompt = (b.messages ?? []).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const kind = /guion de un reel faceless/.test(prompt) ? "script" : "unknown";
    LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), path: req.url, kind, model: b.model, system: String(b.system ?? "").slice(0, 160), promptHead: prompt.slice(0, 200) }) + "\n");
    if (kind !== "script") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "mock: unsupported prompt" } })); return; }
    const text = JSON.stringify(script(prompt));
    res.writeHead(200, { "content-type": "application/json", "request-id": "mock-req" });
    res.end(JSON.stringify({ id: "msg_mock_" + Date.now(), type: "message", role: "assistant", model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 600 } }));
  });
}).listen(54500, "127.0.0.1", () => console.log("mock anthropic 54500"));
