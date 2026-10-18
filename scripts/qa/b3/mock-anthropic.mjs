/**
 * T-34 B3 (copia de S6) — Anthropic SIMULADO para el recorrido de navegador (solo 127.0.0.1; nada sale de la máquina).
 *   node scripts/qa/s6-mock-anthropic.mjs <log> [puerto=4011]
 * Devuelve un guion fijo de Reel de 30 s (85 palabras: dentro de ±10 % de 30 s × 2,8 palabras/s) con la forma de ScriptSchema. Si el tema pedido contiene «FORZAR-401»
 * responde 401 authentication_error, igual que Anthropic con una clave revocada (caso AUTH-A de la orden).
 */
import http from "node:http";
import fs from "node:fs";

const [LOG, PORT = "4011"] = process.argv.slice(2);
const segments = [
  ["¿Por qué el cielo es azul? La luz del Sol trae todos los colores mezclados.", "blue sky clouds", "high", "azul"],
  ["Al cruzar el aire, la luz choca con moléculas mucho más pequeñas que su onda.", "sunlight through atmosphere", "medium", "moléculas"],
  ["Esas moléculas desvían mucho más el azul que el rojo: se llama dispersión de Rayleigh.", "light scattering prism", "medium", "Rayleigh"],
  ["Por eso al atardecer, con más aire en el camino, solo llegan naranjas y rojos.", "sunset orange sky", "high", "atardecer"],
  ["Sin aire, como en la Luna, el cielo se vería siempre negro.", "moon surface black sky", "medium", "Luna"],
  ["Mira el cielo mañana y recuerda: estás viendo luz desviada por el aire.", "person looking at sky", "low", "cielo"],
].map(([text, q, energy, w]) => ({ text, visualQuery: q, visualConcepts: [q, `${q} wide`, `${q} close up`], energy, emphasisWords: [w] }));
const script = { title: "Por qué el cielo es azul", segments };
const log = (line) => LOG && fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const forced401 = body.includes("FORZAR-401");
      log(`${req.method} ${req.url} → ${forced401 ? 401 : 200}`);
      if (forced401) {
        res.writeHead(401, { "content-type": "application/json", "request-id": "req_local_mock_401" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_local_mock" });
      res.end(JSON.stringify({ id: "msg_local_mock", type: "message", role: "assistant", model: "local-mock", content: [{ type: "text", text: JSON.stringify(script) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  })
  .listen(Number(PORT), "127.0.0.1", () => log(`mock-anthropic SIMULADO en 127.0.0.1:${PORT}`));
