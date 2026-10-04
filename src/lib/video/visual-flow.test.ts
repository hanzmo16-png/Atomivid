import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { OwnerFormTrial } from "@/lib/billing/owner-form-trial";
import { assertOwnerFormTrial } from "@/lib/billing/owner-form-trial";
import ts from "typescript";
import { NextResponse } from "next/server";
import { preserveUnchangedVisualPlans, visualPlanIssue } from "./visual-intent";
import type { GeneratedScript } from "@/lib/providers/types";

const script: GeneratedScript = { title: "Negocio", segments: [{ text: "Mide las ventas y los clientes.", visualQuery: "sales report analysis", visualConcepts: ["sales report analysis", "business spreadsheet"], visualIntent: { source: "stock", subject: "business sales reports", mustShow: ["person analyzing business reports"], mustNotShow: ["cryptocurrency trading"], imagePrompt: "Professional analyzing a printed business sales report at a desk." } }] };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const trial: OwnerFormTrial = { version: "owner-form-trial/1", ownerId: "owner", requestId: "request",
  expiresAt: "2099-01-01T00:00:00Z", topic: "negocio", style: "Educativo", language: "es", durationSeconds: 30,
  maxAccountedUsd: 1.25, maxScriptCalls: 3, scriptReservationUsd: 0.15, scriptModel: "claude-sonnet-5",
  maxVoiceCalls: 2, maxVoiceCharacters: 1000, voiceId: "voice", voiceModel: "eleven_multilingual_v2",
  maxImages: 6, maxImageReservationUsd: 0.08, maxReviews: 20, maxRenderAttempts: 1,
  authorization: "2026-10-04:owner-authorized-form-test" };

test("manual narration/search edits invalidate plans; unchanged scenes retain only the server plan", () => {
  for (const field of ["text", "visualQuery", "visualConcepts"] as const) {
    const edited = clone(script);
    if (field === "visualConcepts") edited.segments[0][field] = ["crypto trading"];
    else edited.segments[0][field] = "Different subject";
    assert.match(visualPlanIssue(preserveUnchangedVisualPlans(edited, script).segments)!, /escena 1/);
  }
  const forged = clone(script);
  forged.segments[0].visualIntent!.subject = "cryptocurrency trading";
  assert.deepEqual(preserveUnchangedVisualPlans(forged, script).segments[0].visualIntent, script.segments[0].visualIntent);
  assert.equal(visualPlanIssue(preserveUnchangedVisualPlans(script, script).segments), null);
  assert.ok(visualPlanIssue(preserveUnchangedVisualPlans(script, null).segments));
});

// Execute the actual HTTP handlers with explicit auth/database/provider doubles.
// This tests admission and write outcomes without credentials or paid inference.
const localRequire = createRequire(import.meta.url);
function handler(kind: "script" | "render", options: { row?: Record<string, unknown>; writeError?: boolean; race?: boolean; reviewed?: boolean; user?: string | null; trial?: OwnerFormTrial; quotaAllowed?: boolean } = {}) {
  const row = options.row ?? { id: "request", user_id: "owner", mode: "visual", status: "script_ready", script_json: clone(script), topic: "negocio", style: "Educativo", duration_seconds: 30, language: "es", recorded_audio_path: null, render_attempts: 0 };
  const state = { updates: [] as Record<string, unknown>[], dispatches: 0, quotaChecks: 0, scriptCalls: 0 };
  const service = { from() {
    let writing = false;
    const query = {
      select() { return query; }, eq() { return query; },
      update(values: Record<string, unknown>) { writing = true; state.updates.push(values); return query; },
      single: async () => ({ data: row, error: null }),
      then(resolve: (x: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve(writing ? { data: options.race ? [] : [{ id: "request" }], error: options.writeError ? { code: "TEST_DATABASE_FAILURE" } : null } : { data: row, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const overrides: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.user === null ? null : { id: options.user ?? "owner", email_confirmed_at: "2026-10-04T00:00:00Z" } } }) } }) },
    "@/lib/supabase/service": { createServiceClient: () => service },
    "@/lib/video/feature-flags": { getFeatureFlags: () => ({ reelVisualRelevanceEnabled: options.reviewed ?? true, avatarModeEnabled: true }) },
    "@/lib/video/generate-script": { generateScriptForRequest: async () => { state.scriptCalls++; return { script, providerName: "anthropic" }; } },
    "@/lib/billing/quota": { assertCanGenerate: async () => { state.quotaChecks++; return options.quotaAllowed === false ? { allowed: false, reason: "subscription" } : { allowed: true }; } },
    "@/lib/billing/usage": { recordScriptCall: async () => {} },
    "@/lib/video/script-quality": { checkScriptQuality: () => ({ ok: true }) },
    "@/lib/worker": { getRenderWorker: () => ({ name: "test", trigger: async () => { state.dispatches++; } }) },
    "@/lib/billing/owner-pilot": { readOwnerPilot: async () => null },
    "@/lib/billing/owner-form-trial": { readOwnerFormTrial: async () => options.trial ?? null, assertOwnerFormTrial, freezeOwnerFormRender: async () => {} },
    "@/lib/video/owner-form-script": { generateOwnerFormScript: async () => { state.scriptCalls++; return { script, providerName: "anthropic" }; } },
  };
  const routePath = path.join(__dirname, "../../app/api/generate/[id]", kind, "route.ts");
  const code = ts.transpileModule(fs.readFileSync(routePath, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, (r: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>> = {};
  vm.runInNewContext(code, { exports, require: (name: string) => overrides[name] ?? localRequire(name), Request, console });
  return { state, call: (method: "POST" | "PATCH", body?: GeneratedScript) => exports[method](new Request("https://example.test/api", { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "request" }) }) };
}

test("render HTTP rejects an edited/legacy visual plan before quota, mutation and worker dispatch", async () => {
  const legacy = clone(script); delete legacy.segments[0].visualIntent;
  const h = handler("render", { row: { id: "request", user_id: "owner", mode: "visual", status: "script_ready", script_json: legacy } });
  const response = await h.call("POST");
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Regenera esa escena/);
  assert.deepEqual(h.state, { updates: [], dispatches: 0, quotaChecks: 0, scriptCalls: 0 });
});

test("render HTTP admits valid plans; rollout-off and avatar keep their existing paths", async () => {
  for (const scenario of [{}, { row: { id: "request", user_id: "owner", mode: "avatar", status: "script_ready", script_json: { ...script, segments: [{ text: "avatar", visualQuery: "portrait" }] }, render_attempts: 0 } }, { reviewed: false, row: { id: "request", user_id: "owner", mode: "visual", status: "script_ready", script_json: { ...script, segments: [{ text: "legacy", visualQuery: "desk" }] }, render_attempts: 0 } }]) {
    const h = handler("render", scenario);
    const response = await h.call("POST");
    assert.equal(response.status, 200);
    assert.equal(h.state.dispatches, 1);
  }
});

test("script PATCH persists invalidation and returns the actual saved plan", async () => {
  const h = handler("script"); const edited = clone(script); edited.segments[0].text = "Habla con clientes.";
  const response = await h.call("PATCH", edited);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).script.segments[0].visualIntent, undefined);
  assert.equal((h.state.updates[0].script_json as GeneratedScript).segments[0].visualIntent, undefined);
});

test("script POST and PATCH never report saved success on database failure or a lost state race", async () => {
  for (const method of ["POST", "PATCH"] as const) {
    for (const options of [{ writeError: true }, { race: true }]) {
      const h = handler("script", options);
      const response = await h.call(method, method === "PATCH" ? script : undefined);
      assert.equal(response.status, "writeError" in options ? 500 : 409);
      assert.ok((await response.json()).error);
      assert.equal(h.state.dispatches, 0);
    }
  }
});

test("HTTP requires the authenticated request owner before edits or render", async () => {
  for (const kind of ["script", "render"] as const) {
    for (const user of [null, "someone-else"]) {
      const h = handler(kind, { user });
      const response = await h.call(kind === "script" ? "PATCH" : "POST", kind === "script" ? script : undefined);
      assert.equal(response.status, user === null ? 401 : 403);
      assert.equal(h.state.updates.length, 0);
      assert.equal(h.state.dispatches, 0);
    }
  }
});

test("private form trial admits its owner through the actual script and render handlers without a subscription", async () => {
  for (const kind of ["script", "render"] as const) {
    const h = handler(kind, { trial, quotaAllowed: false, reviewed: false });
    const response = await h.call("POST");
    assert.equal(response.status, 200);
    assert.equal(h.state.quotaChecks, 0);
    assert.equal(h.state.scriptCalls, kind === "script" ? 1 : 0);
    assert.equal(h.state.dispatches, kind === "render" ? 1 : 0);
  }
});

test("absent trial preserves the real subscription gate for script and render", async () => {
  for (const kind of ["script", "render"] as const) {
    const h = handler(kind, { quotaAllowed: false });
    assert.equal((await h.call("POST")).status, 402);
    assert.equal(h.state.scriptCalls + h.state.dispatches + h.state.updates.length, 0);
  }
});

test("expired or differently scoped form grants never call the provider or dispatch", async () => {
  for (const kind of ["script", "render"] as const) {
    for (const changed of [{ expiresAt: "2000-01-01T00:00:00Z" }, { ownerId: "someone-else" },
      { requestId: "different" }, { topic: "changed" }]) {
      const h = handler(kind, { trial: { ...trial, ...changed }, quotaAllowed: false });
      assert.notEqual((await h.call("POST")).status, 200);
      assert.equal(h.state.scriptCalls + h.state.dispatches + h.state.updates.length, 0);
    }
  }
});
