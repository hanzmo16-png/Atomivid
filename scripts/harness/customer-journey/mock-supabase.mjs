// Supabase SIMULADO (Auth + REST) para el recorrido local de cliente nuevo. Sin red externa, sin datos reales.
// Alta: un correo con «+cuota» responde 429 over_email_send_rate_limit, igual que producción el 2026-10-09.
// GET /__stats devuelve cuántas altas llegaron por correo y el redirect_to recibido (para el doble toque).
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.MOCK_PORT || 54329);
const signups = {}; const redirects = {}; const users = {};
const tables = { subscriptions: [], video_requests: [] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (u) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, email: u.email, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })}.sim`;
const userFor = (email) => (users[email] ??= { id: randomUUID(), aud: "authenticated", role: "authenticated", email, email_confirmed_at: new Date().toISOString(),
  identities: [{ id: randomUUID(), provider: "email" }], app_metadata: { provider: "email" }, user_metadata: {}, created_at: new Date().toISOString() });
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    if (url.pathname === "/__stats") return send(res, 200, { signups, redirects, subscriptions: tables.subscriptions, video_requests: tables.video_requests.map(({ id, user_id, mode, reel_image_source, status }) => ({ id, user_id, mode, reel_image_source, status })) });
    if (url.pathname === "/auth/v1/signup") {
      signups[body.email] = (signups[body.email] || 0) + 1; redirects[body.email] = url.searchParams.get("redirect_to");
      await new Promise((r) => setTimeout(r, 1500)); // red móvil lenta: deja ver el estado «enviando»
      if (String(body.email).includes("+cuota")) return send(res, 429, { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" });
      const u = userFor(body.email); return send(res, 200, { ...u, email_confirmed_at: null });
    }
    if (url.pathname === "/auth/v1/token") {
      const u = userFor(body.email);
      return send(res, 200, { access_token: jwt(u), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: randomUUID(), user: u });
    }
    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      try { const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); const u = Object.values(users).find((x) => x.id === p.sub); if (u) return send(res, 200, u); } catch {}
      return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    }
    if (url.pathname === "/auth/v1/logout") { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith("/rest/v1/")) {
      // PostgREST mínimo: «subscriptions» y «video_requests» se GUARDAN (filtros eq./in.); el resto responde vacío.
      const table = url.pathname.slice("/rest/v1/".length);
      const store = tables[table];
      const filters = [...url.searchParams].filter(([k, v]) => !["select", "on_conflict", "limit", "order", "offset"].includes(k) && /^(eq|in)\./.test(v));
      const match = (r) => filters.every(([k, v]) => v.startsWith("eq.") ? String(r[k]) === v.slice(3) : v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(r[k])));
      if (!store) {
        if (req.method === "GET" || req.method === "HEAD") { res.writeHead(200, { "content-type": "application/json", "content-range": "*/0" }); return res.end("[]"); }
        res.writeHead(201, { "content-type": "application/json" }); return res.end("[]");
      }
      if (req.method === "GET" || req.method === "HEAD") { const rows = store.filter(match); res.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` }); return res.end(req.method === "HEAD" ? "" : JSON.stringify(rows)); }
      if (req.method === "POST") {
        const key = url.searchParams.get("on_conflict");
        for (const row of [].concat(body)) {
          const i = key ? store.findIndex((r) => r[key] === row[key]) : -1;
          if (i >= 0) store[i] = { ...store[i], ...row };
          else if (!key && row.id && store.some((r) => r.id === row.id)) return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
          else store.push({ ...row });
        }
        res.writeHead(201, { "content-type": "application/json" }); return res.end("[]");
      }
      if (req.method === "PATCH") { for (const r of store.filter(match)) Object.assign(r, body); res.writeHead(204); return res.end(); }
      res.writeHead(204); return res.end();
    }
    if (url.pathname.startsWith("/storage/v1/")) return send(res, 200, []);
    send(res, 404, { msg: "no simulado: " + url.pathname });
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-supabase en ${port}`));
