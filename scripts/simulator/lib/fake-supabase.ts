/**
 * Supabase en memoria para el simulador — solo las formas de consulta que el
 * pipeline real usa (select/update/insert/upsert + eq/is/in/gte/or/order/limit
 * + maybeSingle/single/await). Cada consulta se ejecuta entera dentro de un
 * mismo tick, igual que Postgres serializa un UPDATE condicional por fila: el
 * compare-and-set de `avatar_generation_started_at` se comporta igual que en
 * producción ante dos trabajadores concurrentes.
 *
 * `.or(...)` (solo lo usa el conteo mensual de assertCanGenerate) se trata
 * como "coincide": el simulador siembra filas del mes en curso.
 */
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

export function createFakeSupabase(opts: { signedUrlBase: string }) {
  const tables = new Map<string, Row[]>();
  const objects = new Map<string, Buffer>();
  const log: { table: string; op: string; patch?: Row }[] = [];
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function builder(name: string) {
    let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let patch: Row | Row[] | null = null;
    let returning = false;
    let head = false;
    let count = false;
    let limitN: number | null = null;
    const filters: Filter[] = [];

    const run = () => {
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(patch) ? patch : [patch!];
        const out: Row[] = [];
        for (const item of list) {
          const key = item.id ?? item.request_id ?? item.idempotency_key;
          const existing = key !== undefined ? rows.find((r) => (r.id ?? r.request_id ?? r.idempotency_key) === key) : undefined;
          if (existing && op === "insert") return { data: null, error: { message: "duplicate key", code: "23505" } };
          if (existing) Object.assign(existing, item);
          else rows.push({ ...item });
          out.push(existing ?? item);
        }
        log.push({ table: name, op, patch: list[0] });
        return { data: returning ? out : null, error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of matched) Object.assign(r, patch);
        log.push({ table: name, op, patch: patch as Row });
        return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null, count: matched.length };
      }
      if (op === "delete") {
        tables.set(name, rows.filter((r) => !matched.includes(r)));
        return { data: null, error: null };
      }
      const limited = limitN === null ? matched : matched.slice(0, limitN);
      return { data: head ? null : limited.map((r) => ({ ...r })), error: null, count: count ? matched.length : null };
    };

    const q = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        if (op !== "select") returning = true;
        if (o?.head) head = true;
        if (o?.count) count = true;
        return q;
      },
      update(p: Row) { op = "update"; patch = p; return q; },
      insert(p: Row | Row[]) { op = "insert"; patch = p; return q; },
      upsert(p: Row | Row[]) { op = "upsert"; patch = p; return q; },
      delete() { op = "delete"; return q; },
      // jsonb columns: PostgREST compares a JSON-text filter with the stored value (e.g. .eq("script_json", JSON.stringify(x))).
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v || (typeof v === "string" && r[c] !== null && typeof r[c] === "object" && JSON.stringify(r[c]) === v)); return q; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return q; },
      is(c: string, v: unknown) { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return q; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return q; },
      gte(c: string, v: string | number) { filters.push((r) => (r[c] as string | number) >= v); return q; },
      lte(c: string, v: string | number) { filters.push((r) => (r[c] as string | number) <= v); return q; },
      or() { return q; },
      order() { return q; },
      limit(n: number) { limitN = n; return q; },
      async maybeSingle() {
        const r = run();
        if (r.error) return r;
        const list = (r.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: null };
      },
      async single() {
        const r = run();
        const list = (r.data as Row[] | null) ?? [];
        return list[0] ? { data: list[0], error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } };
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        try { return Promise.resolve(resolve(run())); } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
      },
    };
    return q;
  }

  const client = {
    from: (name: string) => builder(name),
    storage: {
      from(bucket: string) {
        const key = (p: string) => `${bucket}/${p}`;
        return {
          async upload(p: string, buf: Buffer | Uint8Array) {
            objects.set(key(p), Buffer.from(buf));
            return { data: { path: p }, error: null };
          },
          async download(p: string) {
            const b = objects.get(key(p));
            return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "not found" } };
          },
          async createSignedUrl(p: string) {
            return { data: { signedUrl: `${opts.signedUrlBase}/${bucket}/${p}?token=sim` }, error: null };
          },
          getPublicUrl(p: string) { return { data: { publicUrl: `${opts.signedUrlBase}/${bucket}/${p}` } }; },
          async remove(paths: string[]) { for (const p of paths) objects.delete(key(p)); return { data: null, error: null }; },
        };
      },
    },
  };

  return { client, tables, objects, log, table };
}
