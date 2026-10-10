/**
 * Owner validation in PRODUCTION of the podcast video (real UI on a phone, zero provider cost: the episode is
 * already narrated, stock comes from Pexels' free licence, the editor runs on the worker):
 *  1. Double tap: two simultaneous «Producir video» requests → exactly one accepted (202), the other refused (409).
 *  2. Leave and return mid-production: the page shows the live stage (progress kept).
 *  3. Interruption: the worker run is cancelled mid-production → the episode shows the interruption at once and
 *     offers «Reintentar»; the retry from the UI is accepted.
 *  4. The retried run delivers: player plays 1920x1080 on the phone, download = stored bytes (sha256), stock credits
 *     stored next to the video, no new paid-call ledger row and the episode cost unchanged (narration reused).
 * Frames of the delivered video are sealed to the operator key (private media never in public logs).
 * Owner session: one-time admin sign-in link inside the runner (no password), always signed out.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createCipheriv, createHash, publicEncrypt, randomBytes, constants } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connectResolved } from "../lib/supabase-db";

const APP = "https://atomivid.vercel.app";
const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const REPO = process.env.GITHUB_REPOSITORY ?? "", GH = process.env.GH_ACTIONS_TOKEN ?? "";
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const results: { check: string; ok: boolean; simulated?: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const opened: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync("sealed-out", { recursive: true });

function seal(name: string, bytes: Buffer) {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const ek = publicEncrypt({ key: readFileSync("ops/session-public-key.txt", "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
}

async function sessionCookies(userId: string) {
  const { data: u } = await admin.auth.admin.getUserById(userId);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: u!.user!.email! });
  const otp = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s } = await otp.auth.verifyOtp({ type: "magiclink", token_hash: link!.properties!.hashed_token });
  if (!s.session) throw new Error("no session");
  opened.push(s.session.access_token);
  const jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(URL_, KEY, { cookies: { getAll: () => jar, setAll: (list) => { for (const c of list) { const i = jar.findIndex((x) => x.name === c.name); if (i >= 0) jar.splice(i, 1); if (c.value) jar.push({ name: c.name, value: c.value }); } } } });
  await ssr.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
  return jar;
}

async function gh(path: string, method = "GET") {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { method, headers: { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json" } });
  return { status: r.status, json: r.status === 202 || r.status === 204 ? null : await r.json().catch(() => null) };
}

type Row = { video_status: string | null; video_stage: string | null; video_path: string | null; video_bytes: number | null; video_sha256: string | null; video_duration_seconds: number | null; video_error: string | null; duration_seconds: number | null; cost_usd: number | null; video_attempts: number | null };

async function main() {
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised" }); process.exitCode = 1; return; }
  const { client } = await connectResolved();
  const owner = (await client.query("select user_id::text id from podcast_editor.propietarios limit 1")).rows[0]?.id as string;
  const ep = (await client.query(`select id::text id from public.podcast_episodes where user_id=$1 and status='ready' and source='tts' and audio_path is not null and duration_seconds >= 20 order by created_at desc limit 1`, [owner])).rows[0]?.id as string | undefined;
  const ledger = async () => (await client.query(`select count(*)::int n, count(*) filter (where status='COMMITTED')::int committed from public.pi_paid_operations where project_id=$1`, [`podcast-${ep}`])).rows[0] as { n: number; committed: number };
  log("PRECONDITIONS", { owner: Boolean(owner), narratedEpisode: Boolean(ep), actionsToken: Boolean(GH) });
  if (!owner || !ep) { process.exitCode = 1; await client.end(); return; }
  const db = createClient(URL_, KEY, { auth: { persistSession: false } });
  const read = async () => (await db.from("podcast_episodes").select("video_status,video_stage,video_path,video_bytes,video_sha256,video_duration_seconds,video_error,duration_seconds,cost_usd,video_attempts").eq("id", ep).single()).data as Row;
  const before = { ledger: await ledger(), row: await read() };
  log("BEFORE", { ledgerRows: before.ledger.n, committed: before.ledger.committed, videoStatus: before.row.video_status });
  if (before.row.video_status === "queued" || before.row.video_status === "running") { check("precondition: no production already running", false); await client.end(); process.exitCode = 1; return; }

  const pw = ["play", "wright"].join("");
  const { chromium, devices } = (await import(pw)) as { chromium: { launch: (o?: object) => Promise<any> }; devices: Record<string, object> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const browser = await chromium.launch();
  const cookies = await sessionCookies(owner);
  const phone = await browser.newContext({ acceptDownloads: true, ...devices["iPhone 13"] });
  await phone.addCookies(cookies.map((c) => ({ ...c, domain: "atomivid.vercel.app", path: "/", secure: true, sameSite: "Lax" as const })));
  const dismiss = async (page: any) => { const b = page.getByRole("button", { name: "Omitir", exact: true }); if (await b.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) await b.click(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const open = async () => { const p = await phone.newPage(); await p.goto(`${APP}/dashboard/podcast/${ep}`, { waitUntil: "networkidle" }); await dismiss(p); return p; };
  const waitFor = async (pred: (r: Row) => boolean, maxMs: number, stages?: Set<string>) => {
    const end = Date.now() + maxMs;
    let r = await read();
    while (!pred(r) && Date.now() < end) { await sleep(5000); r = await read(); if (r.video_stage) stages?.add(r.video_stage); }
    return r;
  };
  try {
    // 1. Double tap: two simultaneous requests from the owner's phone session.
    let page = await open();
    const statuses: number[] = await page.evaluate(async (id: string) => {
      const go = () => fetch(`/api/podcast/${id}/video`, { method: "POST" }).then((r) => r.status);
      return Promise.all([go(), go()]);
    }, ep);
    check("double tap: exactly one production accepted, the other refused", [...statuses].sort().join(",") === "202,409", { statuses });
    await page.close(); // the owner leaves

    // 2. Wait until it works on the picture; then (after the cancel below, before mark-failed lands) come back.
    const stages = new Set<string>();
    let row = await waitFor((r) => r.video_status === "running" && /Buscando|Montando/.test(r.video_stage ?? ""), 8 * 60_000, stages);
    // 3. Interruption: cancel the worker run mid-production (first, while it is surely still working).
    const runs = await gh(`/actions/workflows/podcast-video.yml/runs?status=in_progress&per_page=5`);
    const run = (runs.json as { workflow_runs?: { id: number; event: string }[] } | null)?.workflow_runs?.find((r) => r.event === "repository_dispatch");
    const cancel = run ? await gh(`/actions/runs/${run.id}/cancel`, "POST") : { status: 0 };
    check("interruption: worker run cancelled mid-production", cancel.status === 202, { cancelStatus: cancel.status, stageAtCancel: row.video_stage?.replace(/\(\d+\/\d+\)/, "(n/N)") ?? null });
    page = await open();
    const live = await page.getByText(/En producción:/).first().textContent().catch(() => null);
    check("leave and return: the page shows the production in progress with its stage", Boolean(live && /Buscando|Montando|Preparando|Guardando/.test(live)), { live: live?.replace(/\(\d+\/\d+\)/, "(n/N)").slice(0, 80) ?? null });
    await page.close();

    const t0 = Date.now();
    row = await waitFor((r) => r.video_status === "failed", 6 * 60_000);
    check("interruption: the episode shows the interruption promptly (no 12-minute stall)", row.video_status === "failed" && /interrump/i.test(row.video_error ?? ""), { status: row.video_status, seconds: Math.round((Date.now() - t0) / 1000) });
    page = await open();
    const retry = page.getByRole("button", { name: "Reintentar" });
    check("interruption: the UI offers «Reintentar» with the message", (await retry.count()) === 1 && (await page.getByText(/se interrumpió/).count()) > 0);
    const [resp] = await Promise.all([page.waitForResponse((r: any) => r.url().endsWith("/video") && r.request().method() === "POST", { timeout: 60_000 }), retry.click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
    check("interruption: retry accepted from the UI", resp.status() === 202, { status: resp.status() });
    await page.close();

    // 4. Delivery after the retry.
    row = await waitFor((r) => r.video_status === "ready" || r.video_status === "failed", 40 * 60_000, stages);
    check("retry: the worker delivered the verified video", row.video_status === "ready", { status: row.video_status, error: row.video_error, stages: [...stages].map((s) => s.replace(/\(\d+\/\d+\)/, "(n/N)")).filter((s, i, a) => a.indexOf(s) === i) });
    if (row.video_status === "ready") {
      check("video duration matches the audio", Math.abs(Number(row.video_duration_seconds) - Number(row.duration_seconds)) <= 2);
      page = await open();
      const playback = await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return { found: false, played: false, w: 0, h: 0 };
        v.muted = true; await v.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 4000));
        return { found: true, played: v.currentTime > 1, w: v.videoWidth, h: v.videoHeight };
      });
      check("phone: the video plays 1920x1080", playback.found && playback.played && playback.w === 1920 && playback.h === 1080, playback);
      const href = await page.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
      const r = await fetch(href!);
      const buf = Buffer.from(await r.arrayBuffer());
      check("phone: download returns the stored MP4 (sha256 = stored) as an attachment", r.ok && buf.length === Number(row.video_bytes) && createHash("sha256").update(buf).digest("hex") === row.video_sha256 && /attachment/i.test(r.headers.get("content-disposition") ?? ""), { bytes: buf.length });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: no horizontal overflow", overflow <= 1, { overflow });
      const { data: credits } = await db.storage.from("videos").download(row.video_path!.replace(/episodio\.mp4$/, "creditos.json"));
      const sources = credits ? (JSON.parse(await credits.text()) as { sources?: unknown[] }).sources?.length ?? 0 : 0;
      check("stock: licensed Pexels sources credited next to the video", sources > 0, { sources });
      writeFileSync("/tmp/delivered.mp4", buf);
      const d = Number(row.video_duration_seconds);
      const times = [2, d * 0.35, d * 0.65, Math.max(0, d - 3)].map((t) => t.toFixed(2));
      times.forEach((t, i) => execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t, "-i", "/tmp/delivered.mp4", "-frames:v", "1", "-vf", "scale=960:-1", `/tmp/frame-${i}.jpg`]));
      execFileSync("ffmpeg", ["-v", "error", "-y", ...times.flatMap((_, i) => ["-i", `/tmp/frame-${i}.jpg`]), "-filter_complex", "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0", "/tmp/sheet.jpg"]);
      seal("podcast-video-frames.jpg", readFileSync("/tmp/sheet.jpg"));
      await page.close();
    }
    const after = { ledger: await ledger(), row: await read() };
    check("no new paid call: ledger rows unchanged and episode cost unchanged", after.ledger.n === before.ledger.n && Number(after.row.cost_usd) === Number(before.row.cost_usd), { rowsBefore: before.ledger.n, rowsAfter: after.ledger.n });
    await phone.close();
  } finally {
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
    await client.end().catch(() => undefined);
    for (const t of opened) { const { error } = await admin.auth.admin.signOut(t, "local"); check("temporary owner session logout", !error); }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
}
main().catch((e) => { console.error("FAILED: podcast quality validation", e instanceof Error ? e.constructor.name : "unknown"); process.exitCode = 1; });
