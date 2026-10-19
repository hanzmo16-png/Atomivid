// Mock local de OpenAI Images (USD 0): devuelve, en orden, imágenes sintéticas texturizadas (testsrc2 + rejilla + ruido)
// como b64_json con `usage`. Registra cada llamada (prompt, índice, sha256 del PNG servido).
import http from "node:http"; import fs from "node:fs"; import crypto from "node:crypto"; import path from "node:path";
const DIR = process.env.SYNTH_DIR, LOG = process.env.MOCK_LOG; let n = 0;
http.createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
  const b = JSON.parse(Buffer.concat(c).toString() || "{}"); const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
  const f = path.join(DIR, files[n % files.length]); const buf = fs.readFileSync(f); const idx = n++;
  LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), path: req.url, idx, file: path.basename(f), sha256: crypto.createHash("sha256").update(buf).digest("hex"), model: b.model, size: b.size, quality: b.quality, prompt: String(b.prompt ?? "").slice(0, 300) }) + "\n");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString("base64") }], usage: { input_tokens: 50, output_tokens: 1056, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } }));
}); }).listen(54600, "127.0.0.1", () => console.log("mock openai 54600"));
