// Supabase Storage DESECHABLE en memoria (solo 127.0.0.1) con las rutas HTTP que usa @supabase/storage-js 2.x:
//   POST /storage/v1/object/list/<bucket>    · GET /storage/v1/object/<bucket>/<path>
//   POST /storage/v1/object/<bucket>/<path>  (x-upsert) · POST /storage/v1/object/sign/<bucket>/<path>
// Registra cada petición; DELETE se registra y se rechaza (el estudio nunca borra). Sin datos reales.
import { createServer } from "node:http";

export async function startFakeStorage({ bucket = "videos", key = "service-preflight" } = {}) {
  const objects = new Map(); // ruta → { body: Buffer, contentType }
  const log = [];
  const send = (res, status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const body = Buffer.concat(chunks);
      log.push({ method: req.method, path: decodeURIComponent(url.pathname) });
      if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { statusCode: "401", error: "Unauthorized", message: "bad key" });
      const p = decodeURIComponent(url.pathname);
      const listPfx = `/storage/v1/object/list/${bucket}`, signPfx = `/storage/v1/object/sign/${bucket}/`, objPfx = `/storage/v1/object/${bucket}/`;
      if (req.method === "DELETE") return send(res, 403, { statusCode: "403", error: "Forbidden", message: "delete disabled in preflight" });
      if (req.method === "POST" && p === listPfx) {
        const { prefix = "", limit = 100 } = JSON.parse(body.toString() || "{}");
        const base = prefix.replace(/\/+$/, "") + "/";
        const names = new Set();
        for (const k of objects.keys()) if (k.startsWith(base)) names.add(k.slice(base.length).split("/")[0]);
        return send(res, 200, [...names].sort().slice(0, limit).map((name) => ({ name, id: objects.has(base + name) ? name : null })));
      }
      if (req.method === "POST" && p.startsWith(signPfx)) return send(res, 200, { signedURL: `/object/sign/${bucket}/${p.slice(signPfx.length)}?token=preflight` });
      if (p.startsWith(objPfx)) {
        const k = p.slice(objPfx.length);
        if (req.method === "GET" || req.method === "HEAD") {
          const o = objects.get(k);
          return o ? send(res, 200, o.body, o.contentType) : send(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
        }
        if (req.method === "POST" || req.method === "PUT") {
          const upsert = req.method === "PUT" || req.headers["x-upsert"] === "true";
          if (objects.has(k) && !upsert) return send(res, 409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
          objects.set(k, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream") });
          return send(res, 200, { Key: `${bucket}/${k}`, Id: k });
        }
      }
      return send(res, 404, { statusCode: "404", error: "not_found", message: `ruta no simulada: ${req.method} ${p}` });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, key, objects, log, close: () => new Promise((ok) => server.close(() => ok())) };
}
