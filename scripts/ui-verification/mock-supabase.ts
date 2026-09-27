/**
 * Supabase SIMULADO en memoria para verificar la interfaz real de la app
 * (next dev) sin tocar el proyecto compartido: auth (contraseña y usuario),
 * tablas al estilo PostgREST (filtros eq/neq/gte/lt/is/in, orden, límite,
 * objeto único, conteo, «RLS» de solo lectura propia) y Storage (subir,
 * descargar, URL firmadas con descarga y rangos para <audio>).
 *
 * Solo para verificación local. No implementa todo PostgREST: lo que usa la
 * sección «Texto a voz» y el dashboard.
 *
 * Uso (lo lanza scripts/ui-verification/podcast-ui.ts):
 *   npx tsx scripts/ui-verification/mock-supabase.ts --port 54321
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
export function fakeJwt(payload: Row): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("firma-simulada")}`;
}
const decodeJwt = (token: string): Row | null => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
};

export const ANON_KEY = fakeJwt({ role: "anon", iss: "mock" });
export const SERVICE_KEY = fakeJwt({ role: "service_role", iss: "mock" });

export type MockUser = { id: string; email: string; password: string };

export function createMockSupabase(users: MockUser[]) {
  const tables = new Map<string, Row[]>();
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const rows = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  const authUser = (u: MockUser) => ({
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-09-01T00:00:00Z",
  });

  const DEFAULTS: Record<string, () => Row> = {
    tts_jobs: () => ({ status: "queued", segments_done: 0, attempts: 0, mix_attempts: 0, music_choice: "none", long_pilot: false }),
    user_voices: () => ({ status: "uploaded", attempts: 0, needs_review: false, keep_sample: false }),
  };
  const UNIQUE: Record<string, string[][]> = { tts_jobs: [["user_id", "client_request_id"]], user_voices: [["user_id", "client_request_id"]] };
  const PARTIAL_UNIQUE: Record<string, ((r: Row) => boolean)[]> = {
    tts_jobs: [(r) => r.long_pilot === true && (r.status === "queued" || r.status === "processing")],
  };

  function parseFilter(raw: string): (v: unknown) => boolean {
    const neg = raw.startsWith("not.");
    const expr = neg ? raw.slice(4) : raw;
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const val = expr.slice(dot + 1);
    const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : String(v));
    let fn: (v: unknown) => boolean;
    switch (op) {
      case "eq":
        fn = (v) => str(v) === val;
        break;
      case "neq":
        fn = (v) => str(v) !== val;
        break;
      case "gte":
        fn = (v) => (typeof v === "number" ? v >= Number(val) : (str(v) ?? "") >= val);
        break;
      case "lt":
        fn = (v) => (typeof v === "number" ? v < Number(val) : (str(v) ?? "") < val);
        break;
      case "is":
        fn = (v) => (val === "null" ? v === null || v === undefined : str(v) === val);
        break;
      case "in": {
        const set = new Set(val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")));
        fn = (v) => set.has(str(v) ?? "");
        break;
      }
      default:
        fn = () => true;
    }
    return neg ? (v) => !fn(v) : fn;
  }

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const payload = body === undefined ? "" : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(payload);
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL) {
    const table = decodeURIComponent(url.pathname.replace("/rest/v1/", ""));
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const claims = decodeJwt(token) ?? {};
    const isUser = claims.role === "authenticated";
    const filters: [string, (v: unknown) => boolean][] = [];
    let limit: number | null = null;
    let order: { col: string; desc: boolean } | null = null;
    for (const [k, v] of url.searchParams) {
      if (k === "select" || k === "columns" || k === "on_conflict") continue;
      if (k === "limit") limit = Number(v);
      else if (k === "order") order = { col: v.split(".")[0], desc: v.includes(".desc") };
      else if (k !== "offset") filters.push([k, parseFilter(v)]);
    }
    const prefer = String(req.headers.prefer ?? "");
    const wantsObject = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const all = rows(table);
    const matches = (r: Row) => filters.every(([c, f]) => f(r[c])) && (!isUser || !("user_id" in r) || r.user_id === claims.sub);
    let result: Row[] = [];
    const method = req.method ?? "GET";

    if (method === "POST") {
      const parsed = JSON.parse((await readBody(req)).toString() || "{}");
      const inputs: Row[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const input of inputs) {
        const now = new Date().toISOString();
        const row: Row = { id: randomUUID(), created_at: now, updated_at: now, ...(DEFAULTS[table]?.() ?? {}), ...input };
        if (prefer.includes("merge-duplicates")) {
          const existing = all.find((r) => r.id === row.id);
          if (existing) {
            Object.assign(existing, input);
            result.push(existing);
            continue;
          }
        }
        for (const cols of UNIQUE[table] ?? []) {
          if (cols.every((c) => row[c] != null) && all.some((r) => cols.every((c) => r[c] === row[c]))) {
            return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint", details: null, hint: null });
          }
        }
        all.push(row);
        if ((PARTIAL_UNIQUE[table] ?? []).some((p) => all.filter(p).length > 1)) {
          all.pop();
          return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint (partial)", details: null, hint: null });
        }
        result.push(row);
      }
    } else if (method === "PATCH") {
      const values = JSON.parse((await readBody(req)).toString() || "{}");
      const matched = all.filter(matches);
      const before = matched.map((r) => ({ ...r }));
      for (const r of matched) Object.assign(r, values);
      if ((PARTIAL_UNIQUE[table] ?? []).some((p) => all.filter(p).length > 1)) {
        matched.forEach((r, i) => {
          for (const k of Object.keys(r)) delete r[k];
          Object.assign(r, before[i]);
        });
        return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint (partial)", details: null, hint: null });
      }
      result = matched;
    } else if (method === "DELETE") {
      const matched = all.filter(matches);
      tables.set(table, all.filter((r) => !matched.includes(r)));
      result = matched;
    } else {
      result = all.filter(matches);
    }

    if (order) {
      const { col, desc } = order;
      result = [...result].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (desc ? -1 : 1));
    }
    const total = result.length;
    if (limit !== null) result = result.slice(0, limit);
    const headers: Record<string, string> = {};
    if (prefer.includes("count=")) headers["content-range"] = `0-${Math.max(0, total - 1)}/${total}`;
    const returnsRows = method === "GET" || method === "HEAD" || prefer.includes("return=representation");
    if (method === "HEAD") return send(res, 200, undefined, headers);
    if (!returnsRows) return send(res, method === "POST" ? 201 : 204, undefined, headers);
    if (wantsObject) {
      if (result.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${result.length} rows`, hint: null });
      return send(res, method === "POST" ? 201 : 200, result[0], headers);
    }
    return send(res, method === "POST" ? 201 : 200, result, headers);
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, key: string, download: string | null) {
    const file = files.get(key);
    if (!file) return send(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
    const headers: Record<string, string> = { "content-type": file.contentType, "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    if (download !== null) headers["content-disposition"] = `attachment; filename="${download}"`;
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), file.body.length - 1) : file.body.length - 1;
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${file.body.length}`, "content-length": String(end - start + 1) });
      return res.end(file.body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, "content-length": String(file.body.length) });
    res.end(file.body);
  }

  async function handleStorage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const p = decodeURIComponent(url.pathname.replace("/storage/v1/", ""));
    const method = req.method ?? "GET";
    let m: RegExpExecArray | null;
    if ((m = /^object\/sign\/([^/]+)\/(.+)$/.exec(p))) {
      const key = `${m[1]}/${m[2]}`;
      if (method === "POST") {
        if (!files.has(key)) return send(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
        return send(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${randomUUID()}` });
      }
      return serveFile(req, res, key, url.searchParams.has("download") ? url.searchParams.get("download") || m[2].split("/").pop()! : null);
    }
    if ((m = /^object\/list\/([^/]+)$/.exec(p))) {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const prefix = `${m[1]}/${body.prefix ? `${body.prefix}/` : ""}`;
      const names = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => ({ name: k.slice(prefix.length) }));
      return send(res, 200, names);
    }
    if ((m = /^object\/(?:authenticated\/|public\/)?([^/]+)$/.exec(p)) && method === "DELETE") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      for (const k of body.prefixes ?? []) files.delete(`${m[1]}/${k}`);
      return send(res, 200, []);
    }
    if ((m = /^object\/(?:authenticated\/|public\/)?([^/]+)\/(.+)$/.exec(p))) {
      const key = `${m[1]}/${m[2]}`;
      if (method === "POST" || method === "PUT") {
        const upsert = String(req.headers["x-upsert"] ?? "false") === "true";
        if (method === "POST" && !upsert && files.has(key)) return send(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        files.set(key, { body: await readBody(req), contentType: String(req.headers["content-type"] ?? "application/octet-stream") });
        return send(res, 200, { Key: key, Id: randomUUID() });
      }
      return serveFile(req, res, key, null);
    }
    return send(res, 404, { message: `ruta de Storage no simulada: ${p}` });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mock");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        return res.end();
      }
      if (url.pathname === "/auth/v1/token") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const user = users.find((u) => u.email === body.email && u.password === body.password);
        if (!user) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials", msg: "Invalid login credentials" });
        const exp = Math.floor(Date.now() / 1000) + 3600 * 8;
        const access = fakeJwt({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp, session_id: randomUUID() });
        return send(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600 * 8, expires_at: exp, refresh_token: randomUUID(), user: authUser(user) });
      }
      if (url.pathname === "/auth/v1/user") {
        const claims = decodeJwt((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        const user = users.find((u) => u.id === claims?.sub);
        if (!user) return send(res, 401, { code: 401, msg: "invalid JWT" });
        return send(res, 200, authUser(user));
      }
      if (url.pathname === "/auth/v1/logout") return send(res, 204, undefined);
      if (url.pathname.startsWith("/rest/v1/")) return await handleRest(req, res, url);
      if (url.pathname.startsWith("/storage/v1/")) return await handleStorage(req, res, url);
      return send(res, 404, { message: `ruta no simulada: ${url.pathname}` });
    } catch (err) {
      send(res, 500, { message: err instanceof Error ? err.message : String(err) });
    }
  });

  return { server, tables, rows, files };
}
