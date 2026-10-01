/** Video #004 shared production context: frozen plan loading (with freeze verification), Supabase
 * Storage I/O under videos/video-004-thermopylae/, the idempotent paid-operation ledger with the
 * authorized exposure ceiling (the USD 20 hard cap), telemetry and process helpers. Every paid call reserves BEFORE it
 * is sent and is refused when exposure + its maximum cost would exceed the ceiling.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../../src/lib/supabase/service';
import {idempotencyKey as piKey} from '../../src/lib/production-intelligence/ledger';
import {canSpend, exposureUsd, type LedgerEntry} from '../lib/dulce-part1-core';
import {ROWS, PAUSES, video004ShotRecords, secondsOf} from '../../content/productions/video-004-thermopylae/storyboard';
import {AUTHORIZED_FREEZE_HASH, AUTHORIZED_ENGINE_TREE, EXPOSURE_CEILING_USD, PROVIDER_CEILING_USD, PROJECT, GRAPHICS, GENERATIVE_COUNT, CLIP_RETRY} from './plan';

export const FPS = 30;
export const P = PROJECT;
export const DIR = 'content/productions/video-004-thermopylae';
export const out = process.env.V4_OUT || '/tmp/video-004';
export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const log = (tag: string, v: unknown) => console.log(`@@V4_${tag} ` + JSON.stringify(v));
export const readJson = async <T>(f: string): Promise<T> => JSON.parse(await fs.readFile(f, 'utf8')) as T;
export const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
/** Still retakes recorded in reviews.json (id -> correction note): a retaken still lives at rev v2 under a new paid claim. */
export const STILL_RETAKES: Record<string, string> = (() => { try { return (JSON.parse(fsSync.readFileSync(`${'content/productions/video-004-thermopylae'}/reviews.json`, 'utf8')) as {stillRetake?: Record<string, string>}).stillRetake || {}; } catch { return {}; } })();
export const stillRev = (id: string) => (STILL_RETAKES[id] ? 'v2' : 'v1');
export const clipRev = (id: string) => (CLIP_RETRY[id] ? 'v2' : 'v1');
export const stillPath = (id: string) => `${PROJECT}/stills/${id}-${stillRev(id)}.png`;

// ---------------- frozen plan ----------------
export type Kind = 'stock' | 'still' | 'parallax' | 'ai' | 'graphic';
export type Shot = {
  id: string; planShotId: string | null; scene: string; kind: Kind; seconds: number; purpose: string; visual: string; narration: string;
  pause: number; method: string; provider: 'pexels' | 'openai' | 'runway' | 'internal'; cls: string; continuity: string | null; generative: boolean;
};
export type Plan = {shots: Shot[]; scenes: string[]; freezeHash: string; manifest: Record<string, unknown>};

/** Loads the storyboard + frozen manifest, verifies the package against the authorized freeze, and
 * maps the manifest's paid-only shot ids (V4-001…083) onto the full timeline ids (V4-001…099). */
export async function loadPlan(): Promise<Plan> {
  const freeze = await readJson<{freezeHash: string; files: Record<string, string>}>(`${DIR}/freeze/freeze.json`);
  if (freeze.freezeHash !== AUTHORIZED_FREEZE_HASH) throw Error(`Freeze ${freeze.freezeHash} is not the authorized package ${AUTHORIZED_FREEZE_HASH}`);
  for (const [f, h] of Object.entries(freeze.files)) { const actual = sha(await fs.readFile(`${DIR}/${f}`)); if (actual !== h) throw Error(`${f} changed since the freeze (${actual} != ${h})`); }
  const tree = await run('git', ['ls-tree', '-r', 'HEAD', 'src/lib/production-intelligence']).catch(() => '');
  if (tree && sha(tree) !== AUTHORIZED_ENGINE_TREE) throw Error('Frozen PI V1.1 engine tree changed');
  const manifest = await readJson<{plan: {shots: {shotId: string; plannedMethod: string; provider: string; durationTargetSec: number; narrativePurpose: string}[]}}>(`${DIR}/freeze/manifest.json`);
  const paid = manifest.plan.shots;
  const recs = video004ShotRecords();
  const shots: Shot[] = []; let k = 0;
  for (const r of recs) {
    const row = ROWS[r.timelineOrder]; const kind = row[1] as Kind; const isGraphic = kind === 'graphic'; const secs = secondsOf(row);
    let p: (typeof paid)[number] | null = null;
    if (!isGraphic) { p = paid[k++]; if (!p || p.durationTargetSec !== secs || p.narrativePurpose !== row[2]) throw Error(`Manifest/storyboard mismatch at ${r.contract.shotId}`); }
    const method = isGraphic ? 'GRAPHIC' : p!.plannedMethod;
    const provider = isGraphic ? 'internal' : (p!.provider as Shot['provider']);
    shots.push({id: r.contract.shotId, planShotId: p?.shotId ?? null, scene: row[0], kind, seconds: secs, purpose: row[2], visual: row[3], narration: row[4], pause: PAUSES[row[2]] ?? 0, method, provider, cls: r.contract.shotClass, continuity: r.contract.continuityGroup, generative: /I2V/.test(method)});
  }
  if (k !== paid.length) throw Error('Manifest paid shot count differs from the storyboard');
  for (const s of shots) if (s.kind === 'graphic' && !GRAPHICS[s.id]) throw Error('No graphic spec for ' + s.id);
  const generative = shots.filter((s) => s.generative);
  if (generative.length !== GENERATIVE_COUNT) throw Error(`Frozen plan has ${GENERATIVE_COUNT} generative shots, found ${generative.length}`);
  if (generative.filter((s) => s.method === 'I2V_HERO').length !== 1) throw Error('Frozen plan has exactly one hero shot');
  return {shots, scenes: [...new Set(shots.map((s) => s.scene))], freezeHash: freeze.freezeHash, manifest: manifest as unknown as Record<string, unknown>};
}

// ---------------- storage ----------------
export const service = createServiceClient();
export const bucket = service.storage.from('videos');
export async function read(p: string, b = bucket): Promise<Buffer | null> {
  const {data, error} = await b.download(p);
  if (error) { if (String((error as {statusCode?: string}).statusCode) === '404' || /not.?found|Object not found/i.test(error.message)) return null; throw Error('Storage read failed ' + p + ': ' + error.message); }
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}
export async function put(p: string, b: Buffer, type: string, upsert = true) { const {error} = await bucket.upload(p, b, {contentType: type, upsert, cacheControl: '0'}); if (error) throw Error('Storage write failed ' + p + ': ' + error.message); }
export const putJson = (p: string, v: unknown, upsert = true) => put(p, Buffer.from(JSON.stringify(v, null, 2)), 'application/json', upsert);
export async function readJsonStore<T>(p: string): Promise<T | null> { const b = await read(p); return b ? (JSON.parse(b.toString()) as T) : null; }
export async function sign(p: string, days = 7) { const {data, error} = await bucket.createSignedUrl(p, days * 86400); if (error || !data) throw Error('Sign failed ' + p); return data.signedUrl; }

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => { const p = spawn(cmd, args); let e = ''; let o = ''; p.stdout.on('data', (c) => { o += c; if (o.length > 4e6) o = o.slice(-2e6); }); p.stderr.on('data', (c) => { e += c; if (e.length > 4e6) e = e.slice(-2e6); }); p.on('error', rej); p.on('close', (c) => (c === 0 ? res(e + o) : rej(Error(`${cmd} ${args.slice(0, 3).join(' ')}… exit ${c}: ${e.slice(-1500)}`)))); });
}
export async function probe(file: string): Promise<{duration: number; width?: number; height?: number; fps?: string; channels?: number; codec?: string}> {
  const o = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,channels:format=duration', '-of', 'json', file]);
  const j = JSON.parse(o.slice(o.indexOf('{'))); const v = (j.streams || []).find((s: {codec_type: string}) => s.codec_type === 'video'); const a = (j.streams || []).find((s: {codec_type: string}) => s.codec_type === 'audio');
  return {duration: Number(j.format?.duration ?? 0), width: v?.width, height: v?.height, fps: v?.r_frame_rate, channels: a?.channels, codec: v?.codec_name};
}

// ---------------- ledger (idempotent, exposure-capped) ----------------
export type Entry = LedgerEntry & {opKey: string; provider: string; shotId: string | null; reason?: string; at: string};
let ledger: {entries: Entry[]} = {entries: []};
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => { const n = queue.then(fn); queue = n.catch(() => undefined); return n; };
export const LEDGER_PATH = `${P}/ledger.json`;
export async function loadLedger() { const b = await readJsonStore<{entries: Entry[]}>(LEDGER_PATH); if (b) ledger = b; return ledger; }
export const entries = () => ledger.entries;
export const exposure = () => exposureUsd(ledger.entries);
export const committedUsd = (provider?: string) => ledger.entries.filter((e) => e.status === 'committed' && (!provider || e.provider === provider)).reduce((a, e) => a + (e.actualUsd ?? e.maxUsd), 0);
export const providerExposure = (provider: string) => exposureUsd(ledger.entries.filter((e) => e.provider === provider));
/** Production Core idempotency key for a paid operation (op_<sha256 of the canonical fingerprint>). */
export function opKey(f: {shotId: string; provider: string; model: string; method: string; inputFingerprint: string; attemptOrdinal: number}) {
  return piKey({projectId: P, ...f});
}
/** Reserve BEFORE the paid call; refuses (no call) when the authorized exposure ceiling or the provider ceiling would be exceeded. */
export function reserve(e: {key: string; opKey: string; kind: string; provider: string; shotId: string | null; maxUsd: number; reason?: string}) {
  return serial(async () => {
    if (process.env.V4_ALLOW_PAID !== 'true') throw Error('Paid authorization missing for this stage');
    if (ledger.entries.some((x) => x.key === e.key && x.status !== 'released')) throw Error('Existing paid claim; reconcile rather than resend ' + e.key);
    const gate = canSpend(ledger.entries, e.maxUsd, EXPOSURE_CEILING_USD);
    if (!gate.ok) throw Error(`EXPOSURE CEILING: ${gate.exposure.toFixed(2)} + ${e.maxUsd.toFixed(2)} > ${EXPOSURE_CEILING_USD}; stopped before the call (needs new authorization)`);
    const pc = PROVIDER_CEILING_USD[e.provider] ?? 0; const pe = providerExposure(e.provider);
    if (pe + e.maxUsd > pc + 1e-9) throw Error(`PROVIDER CEILING ${e.provider}: ${pe.toFixed(2)} + ${e.maxUsd.toFixed(2)} > ${pc}; stopped before the call`);
    const retries = ledger.entries.filter((x) => x.key === e.key && x.status === 'released').length;
    await putJson(`${P}/claims/${e.key}${retries ? `-r${retries}` : ''}.json`, {...e, at: new Date().toISOString()}, true); // informational; the ledger is authoritative
    ledger.entries.push({...e, actualUsd: null, status: 'reserved', at: new Date().toISOString()});
    await putJson(LEDGER_PATH, ledger);
  });
}
export const settle = (key: string, actualUsd: number | null, status: 'committed' | 'released') => serial(async () => {
  const e = ledger.entries.find((x) => x.key === key && x.status === 'reserved'); if (!e) return;
  e.actualUsd = actualUsd; e.status = status; await putJson(LEDGER_PATH, ledger);
});
export async function writeLedgerSnapshot() { await fs.mkdir(out, {recursive: true}); await fs.writeFile(path.join(out, 'ledger.json'), JSON.stringify({exposureUsd: exposure(), committedUsd: committedUsd(), ceilingUsd: EXPOSURE_CEILING_USD, byProvider: Object.fromEntries(Object.keys(PROVIDER_CEILING_USD).map((p) => [p, {committed: committedUsd(p), exposure: providerExposure(p), ceiling: PROVIDER_CEILING_USD[p]}])), ledger}, null, 2)); }

// ---------------- telemetry ----------------
export type Attempt = {attemptId: string; opKey: string; shotId: string; stage: string; provider: string; model: string; method: string; attemptOrdinal: number; costUsd: number; latencySeconds: number; outputSha256: string | null; generatedSeconds: number; qa?: {result: 'PASS' | 'FAIL' | 'PENDING'; notes?: string; reasons?: string[]}; failureKind?: string; retryReason?: string; at: string};
export const tele = (a: Attempt) => putJson(`${P}/telemetry/${a.attemptId}.json`, a);
export async function listTelemetry(): Promise<Attempt[]> { const {data} = await bucket.list(`${P}/telemetry`, {limit: 1000}); const r: Attempt[] = []; for (const e of data || []) { const b = await read(`${P}/telemetry/${e.name}`); if (b) r.push(JSON.parse(b.toString())); } return r; }

export const ensureOut = async () => { await fs.mkdir(out, {recursive: true}); return out; };
export const exists = (f: string) => fsSync.existsSync(f);
