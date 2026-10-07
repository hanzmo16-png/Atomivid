import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupConfigurableRequest } from "./configure-lookup";
import { ScriptJobCard } from "@/components/video/ScriptJobCard";

const owner = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222", jobId = "33333333-3333-4333-8333-333333333333";
const script = { topic: "Gucci", beats: [1, 2, 3, 4, 5].map(i => ({ id: `beat-${i}`, narration: `Block ${i}.`, visuals: [] })) };
function client(rows: Record<string, unknown>[]) {
  const writes: string[] = [];
  const q = () => { const f: [string, unknown][] = []; const b = {
    select: () => b, eq: (k: string, v: unknown) => { f.push([k, v]); return b; },
    update: () => { writes.push("update"); return b; }, insert: () => { writes.push("insert"); return b; },
    maybeSingle: async () => ({ data: rows.find(r => f.every(([k, v]) => r[k] === v)) ?? null, error: null }) }; return b; };
  return { db: { from: q } as unknown as SupabaseClient, writes };
}
const row = { id: requestId, user_id: owner, mode: "long_form", topic: "Gucci", status: "script_ready", duration_seconds: 420, script_json: script, long_form_confirmed_at: null };

/** The 404 class this guards: a UI link built with the wrong identifier, or to
 * a route that does not exist, for a completed documentary job. */
test("the completed-job link targets the existing configure route with the request id", async () => {
  const html = renderToStaticMarkup(<ScriptJobCard job={{ id: jobId, topic: "Gucci", status: "completed", stage: "Guion listo", error_message: null, request_id: requestId,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }} nowMs={0} />);
  const href = html.match(/href="(\/dashboard\/long-form\/configure\/[^"]+)"/)?.[1];
  assert.equal(href, `/dashboard/long-form/configure/${requestId}`);
  assert.ok(existsSync(path.join(process.cwd(), "src/app/dashboard/long-form/configure/[id]/page.tsx")), "route file must exist");
  const { db } = client([row]);
  assert.equal((await lookupConfigurableRequest(db, { id: owner }, href!.split("/").at(-1)!, true)).kind, "ok");
});

test("lookup outcomes: wrong id, foreign owner, placeholder and no access are 404; reading never writes", async () => {
  const { db, writes } = client([row]);
  const reason = async (id: string, user = owner, access = true) => { const r = await lookupConfigurableRequest(db, { id: user }, id, access); return r.kind === "not_found" ? r.reason : r.kind; };
  assert.equal(await reason(requestId), "ok");
  assert.equal(await reason(jobId), "missing", "a job id is not a request id");
  assert.equal(await reason("<request>"), "invalid_id");
  assert.equal(await reason(requestId, "44444444-4444-4444-8444-444444444444"), "missing", "another user's request is never shown");
  assert.equal(await reason(requestId, owner, false), "no_access");
  assert.deepEqual(writes, []);
  const confirmed = client([{ ...row, long_form_confirmed_at: "2026-10-07T00:00:00Z" }]);
  assert.deepEqual(await lookupConfigurableRequest(confirmed.db, { id: owner }, requestId, true), { kind: "redirect", to: `/dashboard/videos/${requestId}` });
});
