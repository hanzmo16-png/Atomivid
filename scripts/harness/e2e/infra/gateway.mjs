// Gateway local compatible con Supabase (USD 0, sólo 127.0.0.1): /rest/v1 → PostgREST real sobre PG local;
// /auth/v1 y /storage/v1 → stubs mínimos. El secreto JWT es aleatorio por ejecución y nunca sale de la máquina.
import http from "node:http"; import crypto from "node:crypto"; import fs from "node:fs"; import path from "node:path";
const PORT = Number(process.env.GW_PORT ?? 54321), PGRST = Number(process.env.PGRST_PORT ?? 3001);
const SECRET = process.env.GW_JWT_SECRET; if (!SECRET || SECRET.length < 32) throw new Error("GW_JWT_SECRET");
const STORE = process.env.GW_STORAGE_DIR; const LOG = process.env.GW_LOG;
const USERS = JSON.parse(fs.readFileSync(process.env.GW_USERS, "utf8")); // [{id,email,password}]
const b64u = (b) => Buffer.from(b).toString("base64url");
export function sign(payload) { const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b64u(JSON.stringify(payload)); return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; }
function verify(t) { try { const [h, p, s] = t.split("."); if (crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null; const c = JSON.parse(Buffer.from(p, "base64url")); if (c.exp && c.exp < Date.now() / 1000) return null; return c; } catch { return null; } }
const userObj = (u) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: "2026-10-01T00:00:00Z", app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" });
function session(u) { const now = Math.floor(Date.now() / 1000); return { access_token: sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, iat: now, exp: now + 3600 }), token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `rt-${u.id}-${crypto.randomUUID()}`, user: userObj(u) }; }
const refresh = new Map();
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const claims = (req) => { const a = req.headers.authorization ?? ""; return a.startsWith("Bearer ") ? verify(a.slice(7)) : null; };
const mime = (k) => k.endsWith(".mp4") ? "video/mp4" : k.endsWith(".json") ? "application/json" : k.endsWith(".mp3") ? "audio/mpeg" : k.endsWith(".png") ? "image/png" : k.endsWith(".jpg") ? "image/jpeg" : k.endsWith(".svg") ? "image/svg+xml" : k.endsWith(".srt") || k.endsWith(".vtt") ? "text/plain" : "application/octet-stream";
function serveFile(req, res, key, download) {
  const extra = download ? { "content-disposition": `attachment; filename="${download}"` } : {};
  const f = path.join(STORE, key); if (!f.startsWith(STORE) || !fs.existsSync(f)) return json(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
  const size = fs.statSync(f).size, range = req.headers.range;
  if (range) { const [s, e] = range.replace("bytes=", "").split("-"); const start = Number(s), end = e ? Number(e) : size - 1;
    res.writeHead(206, { ...extra, "content-type": mime(key), "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 }); fs.createReadStream(f, { start, end }).pipe(res); return; }
  res.writeHead(200, { ...extra, "content-type": mime(key), "content-length": size, "accept-ranges": "bytes" }); fs.createReadStream(f).pipe(res);
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  // CORS como Supabase real (el navegador sube con uploadToSignedUrl desde el origen de la app).
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*"); res.setHeader("access-control-allow-headers", "authorization,apikey,content-type,x-upsert,x-client-info,cache-control"); res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS,HEAD");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try {
    if (p.startsWith("/rest/v1")) {
      const b = await body(req); log({ kind: "rest", method: req.method, path: p.slice(8) + u.search, role: claims(req)?.role ?? "none" });
      const headers = { ...req.headers }; delete headers.host;
      const up = http.request({ host: "127.0.0.1", port: PGRST, method: req.method, path: p.slice(8) + u.search, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on("error", (e) => json(res, 502, { message: e.message })); up.end(b); return;
    }
    if (p === "/auth/v1/token") {
      const b = JSON.parse((await body(req)).toString() || "{}"); const g = u.searchParams.get("grant_type");
      let usr = null;
      if (g === "password") usr = USERS.find((x) => x.email === b.email && x.password === b.password);
      if (g === "refresh_token") usr = USERS.find((x) => x.id === refresh.get(b.refresh_token));
      log({ kind: "auth", grant: g, ok: !!usr, email: usr?.email });
      if (!usr) return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials", msg: "Invalid login credentials" });
      const s = session(usr); refresh.set(s.refresh_token, usr.id); return json(res, 200, s);
    }
    if (p === "/auth/v1/user") { const c = claims(req); const usr = c && USERS.find((x) => x.id === c.sub); return usr ? json(res, 200, userObj(usr)) : json(res, 401, { code: 401, msg: "invalid JWT", error_code: "bad_jwt" }); }
    if (p === "/auth/v1/logout") { res.writeHead(204); res.end(); return; }
    let m;
    if ((m = p.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/))) { if (claims(req)?.role !== "service_role") return json(res, 403, {}); const usr = USERS.find((x) => x.id === m[1]); return usr ? json(res, 200, userObj(usr)) : json(res, 404, { msg: "User not found" }); }
    if ((m = p.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/))) { // createSignedUploadUrl / uploadToSignedUrl
      const key = decodeURIComponent(m[1]);
      if (req.method === "POST") { if (claims(req)?.role !== "service_role") return json(res, 403, {}); const t = sign({ upload: key, exp: Math.floor(Date.now() / 1000) + 7200 }); log({ kind: "sign-upload", key }); return json(res, 200, { url: `/object/upload/sign/${m[1]}?token=${t}`, token: t }); }
      const c = verify(u.searchParams.get("token") ?? ""); if (!c || c.upload !== key) return json(res, 400, { message: "invalid signature" });
      const f = path.join(STORE, key); if (fs.existsSync(f) && req.headers["x-upsert"] !== "true") return json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      let b = await body(req); const ct = req.headers["content-type"] ?? "";
      if (ct.startsWith("multipart/form-data")) { const bd = "--" + ct.split("boundary=")[1]; const hdrEnd = b.indexOf("\r\n\r\n", b.indexOf(Buffer.from('name=""')) >= 0 ? b.indexOf(Buffer.from('name=""')) : 0) + 4; const e = b.lastIndexOf(Buffer.from("\r\n" + bd)); b = b.subarray(hdrEnd, e); }
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); log({ kind: "signed-upload", key, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") }); return json(res, 200, { Key: key });
    }
    if ((m = p.match(/^\/storage\/v1\/object\/sign\/(.+)$/))) {
      if (req.method === "POST") { if (claims(req)?.role !== "service_role") return json(res, 403, {}); const key = decodeURIComponent(m[1]); const t = sign({ url: key, exp: Math.floor(Date.now() / 1000) + 3600 }); log({ kind: "sign", key }); return json(res, 200, { signedURL: `/object/sign/${m[1]}?token=${t}` }); }
      const c = verify(u.searchParams.get("token") ?? ""); const key = decodeURIComponent(m[1]); if (!c || c.url !== key) return json(res, 400, { message: "invalid signature" });
      log({ kind: "signed-get", key, range: req.headers.range ?? null, download: u.searchParams.get("download") }); return serveFile(req, res, key, u.searchParams.get("download"));
    }
    if ((m = p.match(/^\/storage\/v1\/object\/list\/([^/]+)$/))) { const b = JSON.parse((await body(req)).toString() || "{}"); const d = path.join(STORE, m[1], b.prefix ?? ""); const names = fs.existsSync(d) ? fs.readdirSync(d) : []; return json(res, 200, names.map((n) => ({ name: n, id: n, metadata: {} }))); }
    if ((m = p.match(/^\/storage\/v1\/object\/(?:authenticated\/|public\/)?([^/]+)\/(.+)$/)) && (req.method === "GET" || req.method === "HEAD")) { if (claims(req)?.role !== "service_role") return json(res, 403, {}); return serveFile(req, res, `${m[1]}/${decodeURIComponent(m[2])}`); }
    if ((m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/)) && (req.method === "POST" || req.method === "PUT") && storageFault(decodeURIComponent(m[2]))) return json(res, 500, { statusCode: "500", error: "InternalError", message: "mock storage fault" });
    if ((m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/)) && (req.method === "POST" || req.method === "PUT")) {
      if (claims(req)?.role !== "service_role") return json(res, 403, {}); const key = `${m[1]}/${decodeURIComponent(m[2])}`; const f = path.join(STORE, key);
      if (fs.existsSync(f) && req.method === "POST" && req.headers["x-upsert"] !== "true") return json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      let b = await body(req); const ct = req.headers["content-type"] ?? "";
      if (ct.startsWith("multipart/form-data")) { const bd = "--" + ct.split("boundary=")[1]; const s = b.indexOf("\r\n\r\n") + 4; const e = b.lastIndexOf(Buffer.from("\r\n" + bd)); b = b.subarray(s, e); }
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); log({ kind: "upload", key, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") });
      return json(res, 200, { Key: key, Id: key });
    }
    if ((m = p.match(/^\/storage\/v1\/object\/([^/]+)$/)) && req.method === "DELETE") { if (claims(req)?.role !== "service_role") return json(res, 403, {}); const b = JSON.parse((await body(req)).toString() || "{}"); for (const x of b.prefixes ?? []) fs.rmSync(path.join(STORE, m[1], x), { force: true }); log({ kind: "delete", bucket: m[1], n: (b.prefixes ?? []).length }); return json(res, 200, []); }
    log({ kind: "unhandled", method: req.method, path: p }); json(res, 404, { message: `gateway: unhandled ${req.method} ${p}` });
  } catch (e) { log({ kind: "error", path: p, message: String(e) }); json(res, 500, { message: String(e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`gateway listening ${PORT}`));
// Caos (T-20261019-1602): <E2E_HOME>/logs/faults.json {"storage":{"match":"director-fill","remaining":n}} ⇒ subida 500.
function storageFault(key) { const FF = path.join(STORE, "..", "logs", "faults.json"); try { const all = JSON.parse(fs.readFileSync(FF, "utf8")); const f = all.storage;
  if (f?.remaining > 0 && key.includes(f.match)) { f.remaining--; fs.writeFileSync(FF, JSON.stringify(all)); fs.appendFileSync(path.join(STORE, "..", "logs", "storage-faults.jsonl"), JSON.stringify({ at: new Date().toISOString(), key }) + "\n"); return true; } } catch {} return false; }
