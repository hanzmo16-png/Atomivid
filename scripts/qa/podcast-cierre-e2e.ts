/**
 * Cierre Podcast audiovisual — E2E reproducible con proveedores SIMULADOS (USD 0) sobre PostgreSQL DESECHABLE.
 * Construido por scripts/qa/podcast-cierre-db.sh (migraciones del repo + propuestas #198 y Podcast 3.0, solo en la BD local).
 *  A. Podcast 2.x ↔ pi_spend_authorizations (#198): sin autorización la BD rechaza; la app la abre (ensurePodcastSpendAuthorization);
 *     reintento de la misma clave no se cobra dos veces; tope inmutable aplicado por la BD.
 *  B. Estudio (Podcast 3.0, #192/#196): creación → generación (voz/narración/imágenes/avatar/conversación) → MP4 (ffmpeg real)
 *     → reproducción (ffprobe) → descarga (episodeAction, la lógica del GET) · aislamiento A/B (RLS + ruta) · interrupción y
 *     reanudación sin cargos duplicados (conteos del libro) · ejecución concurrente rechazada · tope de gasto EN LA BD.
 * Nunca acepta una BD remota. No usa secretos. Ningún proveedor real.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { ensurePodcastSpendAuthorization, type RpcClient } from "../../src/lib/podcast/spend-authorization-open";
import { runEpisode, preflight, DuplicateRunError, type RunGuard } from "../../src/lib/podcast/v3/pipeline";
import type { LedgerRow, StudioLedger } from "../../src/lib/podcast/v3/cost";
import { mockProviders } from "../../src/lib/podcast/v3/mocks";
import { episodeAction } from "../../src/lib/podcast/v3/api";
import type { StudioEpisodeRow } from "../../src/lib/podcast/v3/store";
import { NARRACION, AVATAR, DIALOGO } from "../podcast-3-0/fixtures";

const host = process.env.PGHOST ?? "";
if (!(host.startsWith("/") || ["127.0.0.1", "localhost"].includes(host))) throw new Error("solo PostgreSQL local desechable");
if (process.env.DATABASE_URL || process.env.PGSERVICE) throw new Error("conexiones externas prohibidas");
const OUT = path.resolve(process.env.OUT_DIR ?? "podcast-cierre-out");
const db = new Client({ host, port: Number(process.env.PGPORT), user: "postgres", database: process.env.DB ?? "atomivid_cierre" });
let pass = 0; const fails: string[] = []; const evidence: Record<string, unknown> = {};
const ok = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`); } else { fails.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); } };
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const one = async (sql: string, args: unknown[] = []) => Object.values((await q(sql, args))[0] ?? {})[0];
const sha = async (f: string) => createHash("sha256").update(await readFile(f)).digest("hex");
const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", f]).toString()) as { format: { duration: string }; streams: { codec_type: string; codec_name: string }[] };

const A = "aaaaaaaa-0000-4000-8000-00000000a001", B = "bbbbbbbb-0000-4000-8000-00000000b002";

/** Cliente RPC equivalente a supabase.rpc (service role) sobre la BD local. */
const rpc: RpcClient = { async rpc(fn, args) {
  try { const keys = Object.keys(args); const r = await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as r`, keys.map((k) => args[k])); return { data: r.rows[0].r, error: null }; }
  catch (e) { const err = e as { code?: string; message?: string }; return { data: null, error: { code: err.code, message: err.message } }; } } };

/** Libro del estudio sobre la tabla real (mismo upsert que supabaseStudioLedger). */
const pgLedger = (owner: string): StudioLedger => ({
  async get(key) { const [d] = await q<Record<string, string | null>>("select * from public.podcast_studio_operations where key=$1", [key]);
    return d ? { key: d.key!, owner: d.user_id!, episode: d.episode_id!, provider: d.provider!, op: d.op!, state: d.state as LedgerRow["state"], reserved_usd: Number(d.reserved_usd), actual_usd: d.actual_usd == null ? null : Number(d.actual_usd), result: d.result ?? undefined } : undefined; },
  async put(r) { if (r.owner !== owner) throw new Error("ACCESO_DENEGADO");
    await db.query(`insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd,actual_usd,result) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (key) do update set state=excluded.state, reserved_usd=excluded.reserved_usd, actual_usd=excluded.actual_usd, result=excluded.result, updated_at=now()`, [r.key, r.owner, r.episode, r.provider, r.op, r.state, r.reserved_usd, r.actual_usd, r.result ?? null]); },
  async byEpisode(e) { return (await q<Record<string, string | null>>("select * from public.podcast_studio_operations where episode_id=$1 and user_id=$2", [e, owner])).map((d) => ({ key: d.key!, owner: d.user_id!, episode: d.episode_id!, provider: d.provider!, op: d.op!, state: d.state as LedgerRow["state"], reserved_usd: Number(d.reserved_usd), actual_usd: d.actual_usd == null ? null : Number(d.actual_usd), result: d.result ?? undefined })); },
});
/** Exclusión por compare-and-set (misma regla que supabaseRunGuard). */
const pgGuard: RunGuard = {
  async acquire(e) { const r = await db.query("update public.podcast_studio_episodes set status='generating', run_token=gen_random_uuid(), run_started_at=now() where id=$1 and status='authorized' returning id", [e]); return r.rowCount === 1; },
  async release(e) { await db.query("update public.podcast_studio_episodes set run_token=null where id=$1", [e]); },
};
const ledgerStats = async (ep: string) => (await q<{ n: string; settled: string; reserved: string; uncertain: string; usd: string }>(
  `select count(*) n, count(*) filter (where state='settled') settled, count(*) filter (where state='reserved') reserved, count(*) filter (where state='uncertain') uncertain,
   coalesce(sum(coalesce(actual_usd,reserved_usd)) filter (where state='settled'),0) usd from public.podcast_studio_operations where episode_id=$1`, [ep]))[0];

async function partA() {
  console.log("== A. Podcast 2.x ↔ pi_spend_authorizations (#198)");
  const EA = randomUUID(), EB = randomUUID(), PJ = `podcast-${EA}`;
  await db.query("insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ($1,$2,'cierre A','tts','x','voiceA',5000,1.00),($3,$4,'cierre B','tts','x','voiceB',100,0.02)", [EA, A, EB, B]);
  const fresh = () => db.query("insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',100996,'OK','provider_api','GREEN',clock_timestamp())");
  const op = (k: string, p: string, usd: number) => db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
     values ($1,$2,$3,'elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$4,'RESERVED',round($4/0.0002))`, [k, p, `voice:${k}`, usd]);
  const submit = async (k: string) => { await fresh(); return (await one("select public.pi_submit_with_supply($1, null)->>'reason'", [k])) as string; };
  await op("cierre-k0", PJ, 0.60);
  const before = await submit("cierre-k0");
  ok("A1 bloqueo reproducido: sin autorización la BD rechaza el cargo de podcast", before === "authorization missing", before);
  ok("A1 la fila sigue RESERVED (el proveedor nunca se llama)", (await one("select status from public.pi_paid_operations where idempotency_key='cierre-k0'")) === "RESERVED");
  const opened = await ensurePodcastSpendAuthorization(rpc, EA, 1.234, `app:production:${A}:e2e`);
  ok("A2 la app abre la autorización antes del despacho (tope redondeado hacia arriba a centavos)", opened.ok && opened.state === "opened" && opened.capUsd === 1.24, JSON.stringify(opened));
  ok("A2 dueño de la autorización = dueño del episodio (no el llamador)", (await one("select owner_id::text from public.pi_spend_authorizations where project_id=$1", [PJ])) === A);
  const after = await submit("cierre-k0");
  ok("A3 con autorización la misma operación se admite", after === "admitted", after);
  const again = await submit("cierre-k0");
  ok("A3 reintento de la MISMA clave no se admite otra vez (sin doble cobro)", again !== "admitted", again);
  ok("A3 libro: exactamente 1 operación de la clave y 1 SUBMITTED", Number(await one("select count(*) from public.pi_paid_operations where idempotency_key='cierre-k0' and status='SUBMITTED'")) === 1);
  const second = await ensurePodcastSpendAuthorization(rpc, EA, 50, "otra", { neededUsd: 0.10 });
  ok("A4 segunda apertura: ya existe → se respeta la inmutable (tope no sube) y la ejecución que cabe se admite", second.ok && second.state === "already_open" && Number(await one("select cap_usd from public.pi_spend_authorizations where project_id=$1", [PJ])) === 1.24, JSON.stringify(second));
  const big = await ensurePodcastSpendAuthorization(rpc, EA, 50, "otra", { neededUsd: 50 });
  ok("A4 ejecución que no cabe en el saldo de la autorización existente → 409 antes de despachar", !big.ok && "status" in big && big.status === 409);
  await db.query("update public.pi_paid_operations set status='COMMITTED', committed_usd=0.60 where idempotency_key='cierre-k0'");
  await op("cierre-k1", PJ, 0.50); const k1 = await submit("cierre-k1");
  await op("cierre-k1b", PJ, 0.20); const over = await submit("cierre-k1b");
  ok("A5 tope en BD: k0 0.60 + k1 0.50 admitidos; + 0.20 > 1.24 rechazado antes del proveedor", k1 === "admitted" && over === "authorization exceeded", `${k1} / ${over}`);
  ok("A5 la reserva rechazada nunca pasa a SUBMITTED", (await one("select status from public.pi_paid_operations where idempotency_key='cierre-k1b'")) === "RESERVED");
  ok("A5b la reserva rechazada ANTES de abrir (cierre-k0) no quedó fuera del tope (baseline sin RESERVED)", Number(await one("select cardinality(baseline_keys) from public.pi_spend_authorizations where project_id=$1", [PJ])) === 0);
  ok("A5b uso = 0.60 (k0) + 0.50 (k1): todo lo cobrado tras abrir cuenta", Number(await one("select (public.pi_spend_authorization_usage($1)->>'committedUsd')::numeric + (public.pi_spend_authorization_usage($1)->>'pendingUsd')::numeric", [PJ])) === 1.1);
  const nothing = await ensurePodcastSpendAuthorization(rpc, EB, 0, "x");
  ok("A6 sin nada que pagar no se abre autorización", nothing.ok && nothing.state === "nothing_to_pay" && Number(await one("select count(*) from public.pi_spend_authorizations where project_id=$1", [`podcast-${EB}`])) === 0);
  const notInstalled = await ensurePodcastSpendAuthorization({ rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) }, EA, 1, "x");
  ok("A7 RPC ausente/no encontrada → 503 y nada se despacha (falla cerrada, auditoría #200 P0-2)", !notInstalled.ok && "status" in notInstalled && notInstalled.status === 503, JSON.stringify(notInstalled).slice(0, 120));
  const broken = await ensurePodcastSpendAuthorization({ rpc: async () => ({ data: null, error: { code: "57014", message: "timeout" } }) }, EA, 1, "x");
  ok("A8 error al registrar la autorización → no se despacha (falla cerrada)", !broken.ok);
  await op("cierre-k2", PJ, 0.10); await db.query("update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='cierre-k2'");
  const EC = randomUUID(); await db.query("insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ($1,$2,'cierre C','tts','x','voiceA',100,0.02)", [EC, A]);
  await op("cierre-k3", `podcast-${EC}`, 0.10); await db.query("update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='cierre-k3'");
  const unc = await ensurePodcastSpendAuthorization(rpc, EC, 1, "x");
  ok("A9 cobro incierto pendiente → no se autoriza gasto nuevo (409)", !unc.ok && unc.status === 409);
}

async function partC() {
  console.log("== C. Reproducciones adversariales de la auditoría #200 (Claude, claude/audit-pr200 @ bead03f)");
  const EP = randomUUID(), PJ = `podcast-${EP}`;
  await db.query("insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ($1,$2,'audit R1','tts','x','v',2500,0.50)", [EP, A]);
  const fresh = () => db.query("insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',500000,'OK','provider_api','GREEN',clock_timestamp())");
  const op = (k: string, p: string, usd: number) => db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
     values ($1,$2,$3,'elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$4,'RESERVED',round($4/0.0002))`, [k, p, `voice:${k}`, usd]);
  const submit = async (k: string) => { await fresh(); return (await one("select public.pi_submit_with_supply($1, null)->>'reason'", [k])) as string; };
  // R1 (P1-1): narración sola abre 0.50 y consume 0.45; la producción pide 2.40 → antes: ok + despacho + rechazo a mitad.
  const o1 = await ensurePodcastSpendAuthorization(rpc, EP, 0.50, "app:narration:audit", { neededUsd: 0.50 });
  await op("audit-n1", PJ, 0.45); const n1 = await submit("audit-n1"); await db.query("update public.pi_paid_operations set status='COMMITTED',committed_usd=0.45 where idempotency_key='audit-n1'");
  const o2 = await ensurePodcastSpendAuthorization(rpc, EP, 2.40, "app:production:audit", { neededUsd: 2.40 });
  ok("C-R1 autorización existente con saldo 0.05 < 2.40 → 409 ANTES de despachar (no se inicia un job condenado)", o1.ok && n1 === "admitted" && !o2.ok && "status" in o2 && o2.status === 409, JSON.stringify(o2).slice(0, 160));
  const o3 = await ensurePodcastSpendAuthorization(rpc, EP, 2.40, "app:production:audit", { neededUsd: 0.04 });
  ok("C-R1 si la ejecución cabe en el saldo (0.04 ≤ 0.05) se admite", o3.ok && o3.state === "already_open", JSON.stringify(o3).slice(0, 120));
  // R2 (P1-2): USD 30 de ElevenLabs liquidados hoy en el estudio; una llamada documental de 15 (cap proveedor 20, global 40).
  await db.query("update public.pi_supply_policies set daily_cap_usd=200, monthly_cap_usd=1000 where provider='__global__'");
  await db.query("update public.pi_supply_policies set daily_cap_usd=200, monthly_cap_usd=1000, max_daily_calls=200 where provider='elevenlabs'");
  const SE = randomUUID();
  await db.query("insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ($1,$2,'audit R2','narracion','{\"version\":\"podcast-studio/3\"}','generating',50)", [SE, A]);
  await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('a',64),$1,$2,'elevenlabs','tts','reserved',30)", [A, SE]);
  await db.query("update public.podcast_studio_operations set state='settled', actual_usd=30 where key=repeat('a',64)");
  await db.query("update public.pi_supply_policies set daily_cap_usd=40 where provider='__global__'");
  await db.query("update public.pi_supply_policies set daily_cap_usd=20 where provider='elevenlabs'");
  await op("audit-d1", `documentary:${A}:audit`, 15); const d1 = await submit("audit-d1");
  ok("C-R2 el gasto del estudio (30) cuenta en los topes de la plataforma: llamada de 15 (cap proveedor 20 / global 40) rechazada", d1 !== "admitted" && /ceiling|cap/i.test(d1 ?? ""), String(d1));
  ok("C-R2 la operación rechazada nunca pasa a SUBMITTED", (await one("select status from public.pi_paid_operations where idempotency_key='audit-d1'")) === "RESERVED");
  let sErr = ""; try { await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('b',64),$1,$2,'elevenlabs','tts','reserved',1)", [A, SE]); } catch (e) { sErr = (e as Error).message; }
  ok("C-R2 y al revés: una reserva nueva del estudio sobre el cap del proveedor (30+1 > 20) se rechaza en la BD", /STUDIO_CAP: provider funded spend ceiling/.test(sErr), sErr.slice(0, 90));
  await db.query("update public.pi_supply_policies set daily_cap_usd=200 where provider in ('__global__','elevenlabs')");
  let gErr = ""; await db.query("update public.pi_supply_policies set daily_cap_usd=30.5 where provider='__global__'");
  try { await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('c',64),$1,$2,'pexels','imagen','reserved',1)", [A, SE]); } catch (e) { gErr = (e as Error).message; }
  ok("C-R2 cap global: reserva del estudio de otro proveedor que supera el global se rechaza", /global funded spend ceiling/.test(gErr), gErr.slice(0, 90));
  await db.query("update public.pi_supply_policies set daily_cap_usd=200 where provider='__global__'");
  await db.query("delete from public.podcast_studio_operations where episode_id=$1", [SE]);
}

async function partD() {
  console.log("== D. Estudio + pipeline normal juntos: concurrencia y cuota diaria de llamadas (checkpoint ChatGPT T-20261024-1016)");
  const fresh = () => db.query("insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',500000,'OK','provider_api','GREEN',clock_timestamp())");
  const op = (k: string, usd = 0.01) => db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
     values ($1,$2,$3,'elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$4,'RESERVED',round($4/0.0002))`, [k, `documentary:${A}:limits`, `voice:${k}`, usd]);
  const submit = async (k: string) => { await fresh(); return (await one("select public.pi_submit_with_supply($1, null)->>'reason'", [k])) as string; };
  const state = async () => (await one("select public.pi_supply_state('elevenlabs')")) as { activeCalls: number; todayCalls: number; studioActiveCalls: number; studioTodayCalls: number };
  await db.query("update public.pi_supply_policies set daily_cap_usd=500, monthly_cap_usd=2000 where provider in ('__global__','elevenlabs')");
  // Sin otras llamadas en vuelo: cierra lo que dejaron A/C.
  await db.query("update public.pi_paid_operations set status='COMMITTED', committed_usd=reserved_usd where provider='elevenlabs' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')");
  await db.query("update public.podcast_studio_operations set state='settled', actual_usd=reserved_usd where state in ('reserved','uncertain')");
  const SE = randomUUID();
  await db.query("insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ($1,$2,'limits','narracion','{\"version\":\"podcast-studio/3\"}','generating',50)", [SE, A]);
  const sres = (k: string) => db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ($1,$2,$3,'elevenlabs','tts','reserved',0.01)", [k.repeat(64).slice(0, 64), A, SE]);
  const s0 = await state();
  await db.query("update public.pi_supply_policies set max_concurrent=2, max_daily_calls=$1 where provider='elevenlabs'", [s0.todayCalls + 100]);
  await sres("1"); await op("lim-p1"); const p1 = await submit("lim-p1");
  const s1 = await state();
  ok("D1 1 llamada de estudio en vuelo + 1 del pipeline: activeCalls = 2 (el estado ve ambas)", p1 === "admitted" && s1.activeCalls === s0.activeCalls + 2 && s1.studioActiveCalls === 1, JSON.stringify({ p1, ...s1 }));
  await op("lim-p2"); const p2 = await submit("lim-p2");
  ok("D2 pipeline: 3ª llamada simultánea rechazada por concurrencia (cuenta la del estudio)", p2 === "concurrency", p2);
  let e1 = ""; try { await sres("2"); } catch (e) { e1 = (e as Error).message; }
  ok("D3 estudio: reserva simultánea rechazada por concurrencia (cuenta la del pipeline)", /STUDIO_CAP: concurrency/.test(e1), e1.slice(0, 80));
  await db.query("update public.podcast_studio_operations set state='settled', actual_usd=0.01 where key=$1", ["1".repeat(64)]);
  const p2b = await submit("lim-p2");
  ok("D4 al liquidar la del estudio se libera el hueco y la llamada del pipeline entra", p2b === "admitted", p2b);
  await db.query("update public.pi_paid_operations set status='COMMITTED', committed_usd=reserved_usd where idempotency_key in ('lim-p1','lim-p2')");
  const s2 = await state();
  await db.query("update public.pi_supply_policies set max_concurrent=10, max_daily_calls=$1 where provider='elevenlabs'", [s2.todayCalls + 1]);
  await sres("3");
  const s3 = await state();
  ok("D5 cuota diaria: la llamada del estudio cuenta en todayCalls", s3.todayCalls === s2.todayCalls + 1 && s3.studioTodayCalls === s2.studioTodayCalls + 1, JSON.stringify(s3));
  await op("lim-p3"); const p3 = await submit("lim-p3");
  ok("D6 pipeline: cuota diaria agotada por el estudio → 'daily request quota'", p3 === "daily request quota", p3);
  let e2 = ""; try { await sres("4"); } catch (e) { e2 = (e as Error).message; }
  ok("D7 estudio: cuota diaria agotada → reserva rechazada", /STUDIO_CAP: daily request quota/.test(e2), e2.slice(0, 80));
  ok("D8 sin duplicados: ninguna fila del estudio copiada a pi_paid_operations; filas del estudio = llamadas admitidas (2)",
    Number(await one("select count(*) from public.pi_paid_operations where project_id like '%' || $1 || '%'", [SE])) === 0 && Number(await one("select count(*) from public.podcast_studio_operations where episode_id=$1", [SE])) === 2);
  await db.query("update public.pi_supply_policies set max_concurrent=4, max_daily_calls=100000 where provider='elevenlabs'");
  await db.query("update public.podcast_studio_operations set state='settled', actual_usd=0.01 where episode_id=$1", [SE]);
}

type Mode = { tag: string; spec: typeof NARRACION; owner: string };
async function insertEpisode(m: Mode, authorizedUsd: number | null, status = "authorized") {
  const id = randomUUID(); const pf = await preflight(m.spec, mockProviders());
  await db.query("insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,estimate,estimated_usd,authorized_usd,authorized_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
    [id, m.owner, m.spec.title, m.spec.mode, m.spec, status, { totalUsd: pf.estimate.totalUsd }, pf.estimate.totalUsd, authorizedUsd]);
  return { id, estimate: pf.estimate.totalUsd };
}

async function partB() {
  console.log("== B. Estudio: creación → generación → MP4 → reproducción → descarga");
  const storage = path.join(OUT, "storage"); await mkdir(storage, { recursive: true });
  const modes: Mode[] = [{ tag: "narracion-imagenes", spec: NARRACION, owner: A }, { tag: "avatar", spec: AVATAR, owner: A }, { tag: "conversacion-avatares", spec: DIALOGO, owner: A }];
  const delivered: { id: string; row: StudioEpisodeRow; mp4: string }[] = [];
  for (const m of modes) {
    const { id, estimate } = await insertEpisode(m, Math.min(50, Math.round((estimate0(m) + 0.5) * 100) / 100));
    const dir = path.join(OUT, m.tag);
    // 1) Primera ejecución interrumpida a mitad del render (runner perdido): lo pagado queda liquidado en el libro.
    const p1 = mockProviders();
    let interrupted = false;
    try { await runEpisode(m.spec, { owner: A, episode: id, dir, providers: p1, ledger: pgLedger(A), guard: pgGuard, authorizedUsd: Number(await one("select authorized_usd from public.podcast_studio_episodes where id=$1", [id])), small: true, musicDir: path.join(OUT, "music"),
      onProgress: (stage, pct) => { if (stage === "video" && pct >= 80) { interrupted = true; throw new Error("RUNNER_PERDIDO (simulado)"); } } }); }
    catch (e) { ok(`B-${m.tag} interrupción simulada tras pagar voz/avatar`, interrupted, (e as Error).message.slice(0, 80)); }
    const s1 = await ledgerStats(id);
    const calls = (p: ReturnType<typeof mockProviders>) => p.calls.tts.length + p.calls.avatar.length + p.calls.recreate.length + p.calls.prepare.length;
    const paid1 = calls(p1);
    ok(`B-${m.tag} libro tras la interrupción: sin reservas abiertas ni inciertas`, Number(s1.reserved) === 0 && Number(s1.uncertain) === 0, JSON.stringify(s1));
    // 2) Recuperación: el worker marca «failed»; sin nueva autorización un worker rezagado NO lo regenera.
    await db.query("update public.podcast_studio_episodes set status='failed' where id=$1", [id]);
    const pStale = mockProviders();
    const stale = await runEpisode(m.spec, { owner: A, episode: id, dir, providers: pStale, ledger: pgLedger(A), guard: pgGuard, authorizedUsd: 50, small: true, musicDir: path.join(OUT, "music") }).then(() => "corrió", (e: Error) => e.name);
    ok(`B-${m.tag} episodio «failed» sin reautorizar: el worker no lo toma (0 llamadas de pago)`, stale === "DuplicateRunError" && calls(pStale) === 0 && (await one("select status from public.podcast_studio_episodes where id=$1", [id])) === "failed", `${stale}; ${calls(pStale)} llamadas`);
    // El dueño pulsa «Reintentar» → la API reautoriza (failed → authorized, misma regla que la ruta) → reanuda sin volver a pagar.
    await db.query("update public.podcast_studio_episodes set status='authorized', authorized_at=now() where id=$1 and status='failed'", [id]);
    const p2 = mockProviders();
    const r = await runEpisode(m.spec, { owner: A, episode: id, dir, providers: p2, ledger: pgLedger(A), guard: pgGuard, authorizedUsd: Number(await one("select authorized_usd from public.podcast_studio_episodes where id=$1", [id])), small: true, musicDir: path.join(OUT, "music") });
    const s2 = await ledgerStats(id);
    const paid2 = calls(p2), auth = Number(await one("select authorized_usd from public.podcast_studio_episodes where id=$1", [id]));
    ok(`B-${m.tag} 1ª ejecución: cada llamada de pago tiene exactamente una fila liquidada`, paid1 === Number(s1.n), `${paid1} llamadas / ${s1.n} filas`);
    ok(`B-${m.tag} reanudación: lo ya pagado se reutiliza (0 repeticiones), solo se paga lo que faltaba`, r.reusedOps >= Number(s1.n) && paid2 === Number(s2.n) - Number(s1.n) && Number(s2.settled) === Number(s2.n),
      `1ª=${paid1} llamadas, 2ª=${paid2} nuevas; filas ${s1.n}→${s2.n}; reutilizadas ${r.reusedOps}; USD ${s1.usd}→${s2.usd}`);
    const r3 = await (async () => { await db.query("update public.podcast_studio_episodes set status='authorized', authorized_at=now() where id=$1", [id]); const p3 = mockProviders(); await runEpisode(m.spec, { owner: A, episode: id, dir, providers: p3, ledger: pgLedger(A), guard: pgGuard, authorizedUsd: auth, small: true, musicDir: path.join(OUT, "music") }); return { paid: calls(p3), s: await ledgerStats(id) }; })();
    ok(`B-${m.tag} 3er reintento completo: 0 llamadas de pago, libro idéntico (sin cobro duplicado)`, r3.paid === 0 && r3.s.n === s2.n && r3.s.usd === s2.usd, `llamadas=${r3.paid}; filas=${r3.s.n}; USD ${r3.s.usd}`);
    ok(`B-${m.tag} gasto liquidado ≤ autorizado (tope)`, Number(s2.usd) <= auth + 1e-6, `USD ${s2.usd} / autorizado ${auth} (estimación ${estimate})`);
    ok(`B-${m.tag} cada clave del libro es única (sha256)`, Number(await one("select count(distinct key) from public.podcast_studio_operations where episode_id=$1", [id])) === Number(s2.n));
    if (m.spec.mode !== "narracion") ok(`B-${m.tag} avatar generado (simulado)`, p1.calls.avatar.length + p2.calls.avatar.length > 0, `${p1.calls.avatar.length}+${p2.calls.avatar.length} clips`);
    if (m.spec.mode === "dialogo") ok(`B-${m.tag} conversación: dos voces distintas`, new Set(p1.calls.tts.map((c) => c.split(":")[0])).size >= 2);
    if (m.spec.visual.recreations || m.spec.mode === "narracion") ok(`B-${m.tag} imágenes/planos visuales en el plan`, r.plan.shots.length > 0, r.plan.shots.map((s) => s.kind).join(","));
    // 3) MP4 + reproducción.
    assert.ok(r.mp4, "sin MP4");
    const pr = probe(r.mp4!);
    ok(`B-${m.tag} MP4 reproducible: H.264 + AAC, duración = audio (±1 s)`, pr.streams.some((s) => s.codec_name === "h264") && pr.streams.some((s) => s.codec_name === "aac") && Math.abs(Number(pr.format.duration) - r.durationSeconds) <= 1,
      `${pr.streams.map((s) => s.codec_name).join("+")} ${Number(pr.format.duration).toFixed(2)} s`);
    ok(`B-${m.tag} loudness del master −16±1.5 LUFS, TP ≤ −1`, Math.abs(r.lufs + 16) <= 1.5 && r.truePeak <= -1, `${r.lufs} LUFS / ${r.truePeak} dBTP`);
    // 4) Entrega: rutas privadas del dueño en «storage» (como el worker) y estado ready.
    const vp = `${A}/podcast-studio/${id}/episodio.mp4`, ap = `${A}/podcast-studio/${id}/episodio.${path.extname(r.audio).slice(1)}`;
    await mkdir(path.join(storage, path.dirname(vp)), { recursive: true }); await copyFile(r.mp4!, path.join(storage, vp)); await copyFile(r.audio, path.join(storage, ap));
    await db.query("update public.podcast_studio_episodes set status='ready', video_path=$2, audio_path=$3, cost_usd=$4 where id=$1", [id, vp, ap, Number(s2.usd)]);
    const [row] = await q<StudioEpisodeRow>("select * from public.podcast_studio_episodes where id=$1", [id]);
    delivered.push({ id, row, mp4: r.mp4! });
    evidence[m.tag] = { episode: id, duration_s: +r.durationSeconds.toFixed(2), streams: pr.streams.map((s) => s.codec_name), lufs: r.lufs, true_peak: r.truePeak, shots: r.plan.shots.length,
      paid_calls_first_run: paid1, paid_calls_resume: paid2, paid_calls_third_run: r3.paid, ledger_rows: Number(s2.n), ledger_settled_usd: Number(s2.usd), estimate_usd: estimate, mp4_sha256: await sha(r.mp4!) };
  }
  console.log("== B. Descarga y aislamiento");
  const signed: string[] = [];
  const sign = async (p: string) => { signed.push(p); return `file://${path.join(storage, p)}`; };
  for (const d of delivered) {
    const own = await episodeAction(A, d.row, sign);
    const url = String(own.body.video_url ?? "");
    const dl = path.join(OUT, `descarga-${d.id}.mp4`); if (url) await copyFile(url.replace("file://", ""), dl);
    ok(`B-descarga ${d.id.slice(0, 8)}: el dueño obtiene enlace firmado y el archivo = MP4 renderizado (sha)`, own.status === 200 && !!url && (await sha(dl)) === (await sha(d.mp4)) && !!own.body.audio_url && !("spec" in (own.body.episode as object)));
    const n = signed.length;
    const other = await episodeAction(B, d.row, sign);
    ok(`B-aislamiento ${d.id.slice(0, 8)}: usuario B → 404, sin datos ni firma`, other.status === 404 && signed.length === n && !JSON.stringify(other.body).includes(d.row.video_path!));
  }
  const forged = { ...delivered[0].row, video_path: `${B}/podcast-studio/${delivered[0].id}/x.mp4` };
  const n0 = signed.length; const f = await episodeAction(A, forged, sign);
  ok("B-aislamiento: ruta fuera de la carpeta del dueño nunca se firma", f.body.video_url === null && !signed.slice(n0).includes(forged.video_path));
  const asUser = async (u: string, sql: string) => { await db.query("begin"); try { await db.query("set local role authenticated"); await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [u]); return Number(await one(sql)); } catch { return -1; } finally { await db.query("rollback"); } };
  const ids = delivered.map((d) => `'${d.id}'`).join(",");
  const bEp = await asUser(B, `select count(*) from public.podcast_studio_episodes where id in (${ids})`), bOps = await asUser(B, `select count(*) from public.podcast_studio_operations where episode_id in (${ids})`);
  ok("B-aislamiento RLS: B no ve episodios ni libro de A", (bEp === 0 || bEp === -1) && (bOps === 0 || bOps === -1), `episodios=${bEp} libro=${bOps}`);
  const aEp = await asUser(A, `select count(*) from public.podcast_studio_episodes where id in (${ids})`);
  ok("B-RLS: A ve los suyos (o lectura denegada por privilegios del esquema)", aEp === delivered.length || aEp === -1, String(aEp));
  const bWrite = await (async () => { await db.query("begin"); try { await db.query("set local role authenticated"); await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [B]); await db.query(`update public.podcast_studio_episodes set status='authorized' where id in (${ids})`); const r = await db.query(`select count(*) c from public.podcast_studio_episodes where id in (${ids}) and status='authorized'`); return Number(r.rows[0].c); } catch { return -1; } finally { await db.query("rollback"); } })();
  ok("B-aislamiento: B no puede modificar episodios de A", bWrite === 0 || bWrite === -1, String(bWrite));

  console.log("== B. Concurrencia y tope en BD");
  const c = await insertEpisode(modes[0], 5);
  const runs = await Promise.allSettled([0, 1].map(() => runEpisode(NARRACION, { owner: A, episode: c.id, dir: path.join(OUT, "concurrente"), providers: mockProviders(), ledger: pgLedger(A), guard: pgGuard, authorizedUsd: 5, small: true, musicDir: path.join(OUT, "music") })));
  ok("B-concurrencia: dos ejecuciones simultáneas → una sola corre, la otra DuplicateRunError", runs.filter((x) => x.status === "fulfilled").length === 1 && runs.some((x) => x.status === "rejected" && x.reason instanceof DuplicateRunError));
  const capEp = await insertEpisode(modes[0], 0.0001);
  const pc = mockProviders();
  let capErr = "";
  try { await runEpisode(NARRACION, { owner: A, episode: capEp.id, dir: path.join(OUT, "tope"), providers: pc, ledger: pgLedger(A), guard: pgGuard, authorizedUsd: 50, small: true, musicDir: path.join(OUT, "music") }); } catch (e) { capErr = (e as Error).message; }
  const sc = await ledgerStats(capEp.id);
  ok("B-tope BD: aunque la app pase un autorizado mayor (fallo/bypass), la BD rechaza la reserva y el proveedor no se llama", /STUDIO_CAP/.test(capErr) && pc.calls.tts.length === 0 && Number(sc.n) === 0, `${capErr.slice(0, 90)}; llamadas=${pc.calls.tts.length}; filas=${sc.n}`);
  const draft = await insertEpisode(modes[0], null, "draft");
  let draftErr = ""; try { await pgLedger(A).put({ key: "f".repeat(64), owner: A, episode: draft.id, provider: "elevenlabs", op: "tts", state: "reserved", reserved_usd: 0.01, actual_usd: null }); } catch (e) { draftErr = (e as Error).message; }
  ok("B-tope BD: reserva sobre un episodio no autorizado rechazada", /not authorized/.test(draftErr), draftErr.slice(0, 80));
  let crossErr = ""; try { await db.query("insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values ($1,$2,$3,'elevenlabs','tts','reserved',0.01)", ["e".repeat(64), B, delivered[0].id]); } catch (e) { crossErr = (e as Error).message; }
  ok("B-tope BD: reserva de B sobre el episodio de A rechazada (owner mismatch)", /owner mismatch/.test(crossErr), crossErr.slice(0, 80));
  let capCol = ""; try { await db.query("update public.podcast_studio_episodes set authorized_usd=51 where id=$1", [c.id]); } catch (e) { capCol = (e as Error).message; }
  ok("B-tope BD: authorized_usd > 50 rechazado por CHECK", /authorized_max/.test(capCol), capCol.slice(0, 80));
}
const estimate0 = (m: Mode) => estimates.get(m.tag) ?? 5;
const estimates = new Map<string, number>();

async function main() {
  await mkdir(OUT, { recursive: true });
  await db.connect();
  await db.query("insert into auth.users(id,email) values ($1,'hans-e2e@local.test'),($2,'otro-e2e@local.test') on conflict do nothing", [A, B]);
  for (const [tag, spec] of [["narracion-imagenes", NARRACION], ["avatar", AVATAR], ["conversacion-avatares", DIALOGO]] as const) estimates.set(tag, (await preflight(spec, mockProviders())).estimate.totalUsd);
  try { await partA(); } catch (e) { ok("A sin excepción", false, (e as Error).stack?.slice(0, 400)); }
  if (process.env.ONLY_C === "1") { try { await partC(); await partD(); } catch (e) { ok("C sin excepción", false, (e as Error).message.slice(0, 300)); } await db.end(); console.log(`RESULTADO ${pass}/${pass + fails.length} PASS`); process.exit(fails.length ? 1 : 0); }
  try { await partC(); } catch (e) { ok("C sin excepción", false, (e as Error).stack?.slice(0, 400)); }
  try { await partD(); } catch (e) { ok("D sin excepción", false, (e as Error).stack?.slice(0, 400)); }
  try { await partB(); } catch (e) { ok("B sin excepción", false, (e as Error).stack?.slice(0, 600)); }
  await db.end();
  await writeFile(path.join(OUT, "evidence.json"), JSON.stringify({ pass, fails, evidence }, null, 2));
  console.log(`RESULTADO ${pass}/${pass + fails.length} PASS`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
