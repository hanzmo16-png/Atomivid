/**
 * Auditoría del delta 67fcd7e..0acef98 contra el esquema REAL (Postgres desechable).
 * USD 0. No llama a proveedores. Usa supabaseRunGuard (no el guard simplificado del E2E).
 *
 *   PGHOST=<socket> PGPORT=<puerto> DB=atomivid_cierre npx tsx scripts/qa/revision-delta-guard.ts
 * El esquema es el de scripts/qa/podcast-cierre-db.sh (migraciones + propuestas), sin tocar una base remota.
 */
import { randomUUID } from "node:crypto";
import { Client, type Client as Pg } from "pg";
import { supabaseRunGuard } from "../../src/lib/podcast/v3/store";
import { authorizeAction, type ApiDeps } from "../../src/lib/podcast/v3/api";
import { paidOnce, UncertainChargeError, BudgetExceededError, type StudioLedger, type LedgerRow } from "../../src/lib/podcast/v3/cost";
import { StudioSpec, STUDIO_VERSION } from "../../src/lib/podcast/v3/spec";

const host = process.env.PGHOST ?? "";
if (!host.startsWith("/")) throw new Error("solo socket local");
const db = new Client({ host, port: Number(process.env.PGPORT), user: "postgres", database: process.env.DB ?? "atomivid_cierre" });
const U = "cccccccc-0000-4000-8000-00000000c0c1";
let pass = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fails.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const COL = /^[a-z_, ]+$/;
function service(client: Pg, race?: { wait: () => Promise<void> }) {
  return {
    from(table: string) {
      if (table !== "podcast_studio_episodes") throw new Error(`tabla inesperada ${table}`);
      return {
        select(cols: string) {
          if (!COL.test(cols)) throw new Error(`columnas ${cols}`);
          const where: string[] = []; const vals: unknown[] = [];
          const b = {
            eq(k: string, v: unknown) { if (!/^[a-z_]+$/.test(k)) throw new Error(k); vals.push(v); where.push(`${k} = $${vals.length}`); return b; },
            is(k: string, v: unknown) { if (!/^[a-z_]+$/.test(k)) throw new Error(k); if (v !== null) throw new Error("solo is null"); where.push(`${k} is null`); return b; },
            async maybeSingle() {
              const r = await client.query(`select ${cols} from public.${table} where ${where.join(" and ")}`, vals);
              if (race) await race.wait();
              return { data: r.rows[0] ?? null, error: null };
            },
          };
          return b;
        },
        update(patch: Record<string, unknown>) {
          const keys = Object.keys(patch);
          if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error(keys.join(","));
          const vals: unknown[] = keys.map((k) => patch[k]);
          const where: string[] = [];
          const b = {
            eq(k: string, v: unknown) { if (!/^[a-z_]+$/.test(k)) throw new Error(k); vals.push(v); where.push(`${k} = $${vals.length}`); return b; },
            is(k: string, v: unknown) { if (!/^[a-z_]+$/.test(k)) throw new Error(k); if (v !== null) throw new Error("solo is null"); where.push(`${k} is null`); return b; },
            async select(ret: string) {
              if (!/^[a-z_]+$/.test(ret)) throw new Error(ret);
              const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
              const r = await client.query(`update public.${table} set ${set} where ${where.join(" and ")} returning ${ret}`, vals);
              return { data: r.rows, error: null };
            },
          };
          return b;
        },
      };
    },
  };
}

async function insert(status: string, extra: { started?: string | null; authorizedAt?: string } = {}) {
  const id = randomUUID();
  await db.query(
    `insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,estimated_usd,authorized_usd,authorized_at,run_started_at)
     values ($1,$2,'revision','narracion',$3::jsonb,$4,1,2, coalesce($5::timestamptz, now()), $6::timestamptz)`,
    [id, U, JSON.stringify({ version: "podcast-studio/3" }), status, extra.authorizedAt ?? null, extra.started === undefined ? null : extra.started],
  );
  return id;
}
const snap = async (id: string) => (await db.query("select status, run_token::text, run_started_at, authorized_usd::text, authorized_at from public.podcast_studio_episodes where id=$1", [id])).rows[0];

async function main() {
  await db.connect();
  await db.query("insert into auth.users(id,email) values ($1,'revision-delta@local.test') on conflict do nothing", [U]);
  const cols = (await db.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='podcast_studio_episodes' and column_name in ('status','run_token','run_started_at','authorized_usd','authorized_at') order by column_name`)).rows;
  console.log("SCHEMA", JSON.stringify(cols));
  const checks = (await db.query(`select conname from pg_constraint where conrelid='public.podcast_studio_episodes'::regclass and contype='c' order by conname`)).rows.map((r) => r.conname);
  console.log("CHECKS", checks.join(","));

  // 1) Dos workers a la vez sobre «authorized»: exactamente uno gana. El release del perdedor no toca el token del ganador.
  {
    const id = await insert("authorized");
    const c1 = new Client({ host, port: Number(process.env.PGPORT), user: "postgres", database: process.env.DB ?? "atomivid_cierre" });
    const c2 = new Client({ host, port: Number(process.env.PGPORT), user: "postgres", database: process.env.DB ?? "atomivid_cierre" });
    await c1.connect(); await c2.connect();
    let n = 0; let open: () => void = () => {};
    const gate = new Promise<void>((r) => { open = r; });
    const wait = async () => { n++; if (n === 2) open(); await gate; };
    const g1 = supabaseRunGuard(service(c1, { wait }) as never);
    const g2 = supabaseRunGuard(service(c2, { wait }) as never);
    const t1 = "a".repeat(40), t2 = "b".repeat(40);
    const [w1, w2] = await Promise.all([g1.acquire(id, t1), g2.acquire(id, t2)]);
    const before = await snap(id);
    const loser = w1 ? g2 : g1; const loserToken = w1 ? t2 : t1;
    await loser.release(id, loserToken);
    const after = await snap(id);
    ok("PG dos workers: exactamente uno adquiere", (w1 ? 1 : 0) + (w2 ? 1 : 0) === 1, `w1=${w1} w2=${w2}`);
    ok("PG el ganador deja generating y un run_token; el perdedor no lo borra", before.status === "generating" && !!before.run_token && after.run_token === before.run_token && after.status === "generating", `${before.run_token} → ${after.run_token}`);
    const again = await supabaseRunGuard(service(db) as never).acquire(id, "c".repeat(40));
    const still = await snap(id);
    ok("PG un tercer worker sobre el generating reciente pierde y no cambia el token", again === false && still.run_token === before.run_token);
    await c1.end(); await c2.end();
  }

  // 2) failed y ready: el guard no escribe.
  for (const status of ["failed", "ready"] as const) {
    const id = await insert(status, { started: new Date(Date.now() - 3 * 3600_000).toISOString() });
    const before = await snap(id);
    const won = await supabaseRunGuard(service(db) as never).acquire(id, "d".repeat(40));
    const after = await snap(id);
    ok(`PG «${status}» no se toma y no se escribe`, won === false && after.status === status && after.run_token === before.run_token && String(after.run_started_at) === String(before.run_started_at));
  }

  // 3) Runner perdido (generating viejo) sí lo recupera el guard.
  {
    const id = await insert("generating", { started: new Date(Date.now() - 3 * 3600_000).toISOString() });
    const won = await supabaseRunGuard(service(db) as never).acquire(id, "e".repeat(40));
    const after = await snap(id);
    const age = Date.now() - new Date(after.run_started_at).getTime();
    ok("PG runner perdido (generating > 45 min) se recupera y refresca run_started_at", won === true && after.status === "generating" && age < 60_000, `edad ${age} ms`);
  }

  // 4) Recuperación de producción: mark-failed (solo generating) → reautorización del dueño → el guard toma «authorized».
  {
    const id = await insert("generating", { started: new Date(Date.now() - 5 * 3600_000).toISOString() });
    const marked = await db.query("update public.podcast_studio_episodes set status='failed', error='interrumpido', updated_at=now() where id=$1 and status='generating' returning id", [id]);
    ok("PG mark-failed solo cierra un generating", marked.rowCount === 1 && (await snap(id)).status === "failed");
    const readyId = await insert("ready");
    const markedReady = await db.query("update public.podcast_studio_episodes set status='failed' where id=$1 and status='generating' returning id", [readyId]);
    ok("PG mark-failed no toca un episodio listo", markedReady.rowCount === 0 && (await snap(readyId)).status === "ready");
    const reauth = await db.query("update public.podcast_studio_episodes set status='authorized', authorized_usd=2, authorized_at=now(), error=null, updated_at=now() where id=$1 and user_id=$2 and status in ('draft','failed') returning id", [id, U]);
    const won = await supabaseRunGuard(service(db) as never).acquire(id, "f".repeat(40));
    ok("PG tras reautorizar (failed→authorized) el worker puede tomar el episodio", reauth.rowCount === 1 && won === true && (await snap(id)).status === "generating");
    const stale = await supabaseRunGuard(service(db) as never).acquire(id, "9".repeat(40));
    ok("PG el episodio ya tomado no se vuelve a tomar", stale === false);
  }

  // 5) Re-despacho: authorized sin arranque posterior a authorized_at no llama a authorize ni cambia authorized_usd. Arranque posterior → 409.
  {
    const spec = StudioSpec.parse({ version: STUDIO_VERSION, mode: "narracion", title: "T", script: "Primer párrafo sobre la señal.\n\nSegundo párrafo sobre el silencio.", target_minutes: 1, participants: [{ id: "A", name: "Narrador", voice_id: "voiceNarradorA1", avatar: { kind: "ninguno" } }], visual: { provider: "solo_set", recreations: false }, music: {}, budget_usd: 5, output: "audio" });
    const id = await insert("authorized", { started: new Date(Date.now() - 3600_000).toISOString(), authorizedAt: new Date().toISOString() });
    await db.query("update public.podcast_studio_episodes set spec=$2::jsonb, estimated_usd=1, authorized_usd=2 where id=$1", [id, JSON.stringify(spec)]);
    const row = (await db.query("select * from public.podcast_studio_episodes where id=$1", [id])).rows[0];
    const asApi = { ...row, estimated_usd: Number(row.estimated_usd), authorized_usd: Number(row.authorized_usd), authorized_at: new Date(row.authorized_at).toISOString(), run_started_at: row.run_started_at ? new Date(row.run_started_at).toISOString() : null, user_id: row.user_id, status: row.status, spec: row.spec };
    let authorized = 0;
    const deps = (load: () => Promise<unknown>): ApiDeps => ({
      userId: U, viewer: { id: U, email: "revision-delta@local.test", email_confirmed_at: "2026-01-01" }, voices: async () => [], enabled: true, llm: null,
      insert: async () => null, load: load as ApiDeps["load"],
      authorize: async () => { authorized++; return true; }, dispatch: async () => true,
    });
    const again = await authorizeAction(deps(async () => asApi as never), id, { confirm: true, authorizedUsd: 50 });
    const usd = (await snap(id)).authorized_usd;
    ok("PG re-despacho con arranque anterior a authorized_at: 200, authorize no corre, authorized_usd intacto", again.status === 200 && authorized === 0 && usd === "2.0000", `status ${again.status} usd ${usd}`);
    const later = { ...asApi, run_started_at: new Date(Date.now() + 60_000).toISOString() };
    const blocked = await authorizeAction(deps(async () => later as never), id, { confirm: true, authorizedUsd: 50 });
    ok("PG arranque posterior a authorized_at → 409 y authorize no corre", blocked.status === 409 && authorized === 0, String(blocked.status));
    const failedRow = { ...asApi, status: "failed" };
    const noUsd = await authorizeAction(deps(async () => failedRow as never), id, { confirm: true });
    ok("PG failed + confirm sin monto → 402, sin authorize", noUsd.status === 402 && authorized === 0);
  }

  // 6) Libro real: liquidada no se vuelve a pagar; incierta bloquea; por encima de authorized_usd la BD rechaza la reserva.
  {
    const id = await insert("authorized");
    await db.query("update public.podcast_studio_episodes set status='generating' where id=$1", [id]);
    const ledger: StudioLedger = {
      async get(key) {
        const r = await db.query("select * from public.podcast_studio_operations where key=$1", [key]);
        const d = r.rows[0]; if (!d) return undefined;
        return { key: d.key, owner: d.user_id, episode: d.episode_id, provider: d.provider, op: d.op, state: d.state, reserved_usd: Number(d.reserved_usd), actual_usd: d.actual_usd == null ? null : Number(d.actual_usd), result: d.result ?? undefined };
      },
      async put(r: LedgerRow) {
        if (r.owner !== U) throw new Error("ACCESO_DENEGADO");
        await db.query(`insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd,actual_usd,result)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict (key) do update set state=excluded.state, reserved_usd=excluded.reserved_usd, actual_usd=excluded.actual_usd, result=excluded.result, updated_at=now()`,
        [r.key, r.owner, r.episode, r.provider, r.op, r.state, r.reserved_usd, r.actual_usd, r.result ?? null]);
      },
      async byEpisode(e) {
        const r = await db.query("select * from public.podcast_studio_operations where episode_id=$1 and user_id=$2", [e, U]);
        return r.rows.map((d) => ({ key: d.key, owner: d.user_id, episode: d.episode_id, provider: d.provider, op: d.op, state: d.state, reserved_usd: Number(d.reserved_usd), actual_usd: d.actual_usd == null ? null : Number(d.actual_usd), result: d.result ?? undefined }));
      },
    };
    let calls = 0;
    const key = "ab".repeat(32);
    const req = { key, owner: U, episode: id, provider: "elevenlabs", op: "tts", usd: 0.4, budgetUsd: 2, authorized: true };
    await paidOnce(ledger, req, async () => { calls++; return { result: "storage:voz.mp3", actualUsd: 0.4 }; });
    const reused = await paidOnce(ledger, req, async () => { calls++; return { result: "otra", actualUsd: 0.4 }; });
    ok("PG clave liquidada: segunda pasada reutiliza y no llama al proveedor", reused.reused === true && calls === 1 && reused.usd === 0);
    const ukey = "cd".repeat(32);
    await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ($1,$2,$3,'elevenlabs','tts','uncertain',0.3)", [ukey, U, id]);
    let uncertainCalls = 0;
    let uncertain = "";
    try { await paidOnce(ledger, { ...req, key: ukey, usd: 0.3 }, async () => { uncertainCalls++; return { result: "x", actualUsd: 0.3 }; }); }
    catch (e) { uncertain = (e as Error).name; }
    ok("PG clave incierta: no se vuelve a pagar", uncertain === UncertainChargeError.name && uncertainCalls === 0);
    let cap = "";
    try { await paidOnce(ledger, { ...req, key: "ef".repeat(32), usd: 5, budgetUsd: 50 }, async () => { calls++; return { result: "x", actualUsd: 5 }; }); }
    catch (e) { cap = (e as Error).message; }
    const n = Number((await db.query("select count(*)::int n from public.podcast_studio_operations where episode_id=$1 and key=$2", [id, "ef".repeat(32)])).rows[0].n);
    ok("PG reserva por encima de authorized_usd: la BD rechaza y no queda fila ni llamada", /STUDIO_CAP/.test(cap) && n === 0, cap.slice(0, 140));
    ok("PG el proveedor no se llamó en el exceso", calls === 1, `llamadas ${calls}`);
    // presupuesto de la app también bloquea antes de la BD cuando el restante no alcanza
    let app = "";
    try { await paidOnce(ledger, { ...req, key: "11".repeat(32), usd: 1.5, budgetUsd: 2 }, async () => ({ result: "x", actualUsd: 1.5 })); }
    catch (e) { app = (e as Error).name; }
    ok("PG el libro de la app rechaza antes de reservar si no cabe en el presupuesto", app === BudgetExceededError.name);
  }

  await db.query("delete from public.podcast_studio_operations where user_id=$1", [U]);
  await db.query("delete from public.podcast_studio_episodes where user_id=$1", [U]);
  await db.end();
  console.log(`RESULTADO ${pass}/${pass + fails.length} PASS`);
  if (fails.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
