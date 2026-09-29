/**
 * Business Telemetry V0 tests: schema validation, idempotency (retries, repeated webhooks, recovery),
 * append-only behaviour, privacy, money semantics, provider trace, attribution, health, Command Center
 * integration, migration 0030 static guarantees. No network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  recordBusinessEvent, BusinessEventRejected, MemoryBusinessEventStore, MemoryRejectionSink, eventIdFor, type BusinessEventInput,
  EVENT_TYPES, EVENT_SCHEMAS, EVENT_SOURCE_STATUS, REQUIRED_REFERENCES, SCHEMA_VERSION, ISO_4217,
  sanitizeMetadata, looksSecret,
  captureAttribution, resolveTouches, MemoryAttributionStore, UTM_ALLOWLIST, CLICK_ID_ALLOWLIST,
  consumptionFromCostEntry, consumptionFromPaidOperation, consumptionFromBalanceEvent, NotConsumptionError, traceProduction,
  deriveProductionRequested, deriveProductionStarted, deriveFinalCutDecision, deriveYouTubeLinked, deriveYouTubeSnapshot, deriveUserRegistered, NOT_DERIVABLE,
  telemetryHealth, aggregateTelemetry, memoryTelemetrySource, AUTO_EXECUTE,
} from "./index";
import { CostLedger } from "@/lib/production-core/cost-engine";
import { CommandCenterService, SECTIONS } from "@/lib/command-center/service";
import { memorySource } from "@/lib/command-center/sources";
import { RICH } from "@/lib/command-center/fixtures";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;

const NOW = "2026-09-29T12:00:00.000Z";
const USER = "33333333-3333-4333-8333-333333333333";
const deps = () => { const store = new MemoryBusinessEventStore(); const rejections = new MemoryRejectionSink(); return { store, rejections, now: () => NOW }; };
const base = (over: Partial<BusinessEventInput> = {}): BusinessEventInput => ({ eventType: "production_requested", occurredAt: "2026-09-29T10:00:00Z", actorType: "user", actorId: USER, userId: USER, productionId: "p1", requestId: "p1", source: "video_requests", provenance: "derived_from_canonical_record", idempotencyKey: "production_requested:video_requests:p1", metadata: { production_type: "long_form", language: "es", duration_seconds_requested: 600 }, ...over });
const rejects = async (input: BusinessEventInput, reason: string, d = deps()) => { await assert.rejects(recordBusinessEvent(input, d), (e: BusinessEventRejected) => e instanceof BusinessEventRejected && e.reason === reason, reason); assert.equal(d.rejections.rejections.at(-1)?.reason, reason, "rejection logged"); assert.equal(d.store.events.size, 0, "nothing persisted"); return d; };

// ---------- schema / taxonomy ----------
test("taxonomy is small, stable and explicit: 14 versioned strict schemas, required references, honest source status", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(SCHEMA_VERSION, 1);
  for (const t of EVENT_TYPES) { assert.ok(EVENT_SCHEMAS[t]); assert.ok(REQUIRED_REFERENCES[t]); assert.ok(EVENT_SOURCE_STATUS[t]); }
  for (const t of ["subscription_started", "subscription_cancelled", "payment_succeeded", "production_completed", "production_failed"] as const) assert.equal(EVENT_SOURCE_STATUS[t].status, "contract_only_pending_integration", `${t} has no reliable source today`);
  assert.ok(!EVENT_SCHEMAS.production_completed.safeParse({ production_type: "reel", duration_seconds: 10, language: "es", provider_mix: ["openai"], extra: 1 }).success, "unknown keys rejected (strict)");
});

test("valid event is recorded canonically; same fact retried with the same key → exactly one record", async () => {
  const d = deps();
  const a = await recordBusinessEvent(base(), d);
  assert.equal(a.status, "recorded");
  assert.equal(a.event.eventId, eventIdFor("production_requested:video_requests:p1"));
  assert.match(a.event.eventId, /^bev_[a-f0-9]{32}$/);
  assert.equal(a.event.recordedAt, NOW); assert.equal(a.event.schemaVersion, 1); assert.equal(a.event.provenance, "derived_from_canonical_record");
  const b = await recordBusinessEvent(base(), d);
  assert.equal(b.status, "duplicate"); assert.equal(b.event.eventId, a.event.eventId);
  assert.equal(d.store.events.size, 1);
  assert.equal(d.rejections.rejections.length, 0, "a benign duplicate is not a rejection");
});

test("repeated webhook (same delivery id) → one record; recovery replay → no duplicate business fact; two different facts → two records", async () => {
  const d = deps();
  const hook = (): BusinessEventInput => ({ eventType: "youtube_video_linked", occurredAt: "2026-09-28T09:00:00Z", actorType: "webhook", actorId: "yt-link-hook", productionId: "p9", source: "yt_video_links", provenance: "observed_live", idempotencyKey: "youtube_video_linked:yt_video_links:p9:dQw4w9WgXcQ", metadata: { channel_id: "UCaaaaaaaaaaaaaaaaaaaaaa", video_id: "dQw4w9WgXcQ", master_checksum_sha256: "a".repeat(64), linked_by: "producer" } });
  for (let i = 0; i < 5; i++) await recordBusinessEvent(hook(), d);
  assert.equal(d.store.events.size, 1, "five deliveries, one record");
  // recovery: a crashed worker re-emits every event it had already written
  const replay = d.store.list().map((e) => ({ ...base(), eventType: e.eventType, occurredAt: e.occurredAt, actorType: e.actorType, actorId: e.actorId, userId: e.userId, productionId: e.productionId, requestId: e.requestId, masterId: e.masterId, provider: e.provider, source: e.source, provenance: e.provenance, idempotencyKey: e.idempotencyKey, metadata: e.metadata }));
  for (const r of replay) assert.equal((await recordBusinessEvent(r, d)).status, "duplicate");
  assert.equal(d.store.events.size, 1);
  await recordBusinessEvent({ ...hook(), idempotencyKey: "youtube_video_linked:yt_video_links:p9:xyz1234abcd", metadata: { ...(hook().metadata as object), video_id: "xyz1234abcd" } }, d);
  assert.equal(d.store.events.size, 2, "a different fact is a second record");
});

test("same idempotency key with a DIFFERENT payload is an idempotency_conflict, never a silent overwrite (append-only)", async () => {
  const d = deps();
  await recordBusinessEvent(base(), d);
  await assert.rejects(recordBusinessEvent(base({ metadata: { production_type: "reel", language: "en", duration_seconds_requested: 60 } }), d), (e: BusinessEventRejected) => e.reason === "idempotency_conflict");
  assert.equal(d.store.list()[0].metadata.production_type, "long_form", "original fact untouched");
  assert.equal(d.rejections.rejections[0].reason, "idempotency_conflict");
  assert.equal(d.rejections.rejections[0].idempotencyKeyHash, crypto.createHash("sha256").update("production_requested:video_requests:p1").digest("hex").slice(0, 32), "only a hash of the key is logged");
});

test("invalid events are rejected loudly and logged: schema, unknown type, missing provenance/reference, timestamp, actor, version", async () => {
  await rejects(base({ metadata: { production_type: "movie", language: "es", duration_seconds_requested: 1 } }), "invalid_schema");
  await rejects(base({ metadata: { production_type: "reel", language: "es", duration_seconds_requested: 1, extra: "x" } }), "invalid_schema");
  await rejects(base({ eventType: "video_watched" }), "unknown_event_type");
  await rejects(base({ provenance: "guessed" as never }), "missing_provenance");
  await rejects(base({ source: "" }), "missing_provenance");
  await rejects(base({ userId: null }), "missing_reference");
  await rejects({ ...base(), eventType: "final_cut_passed", masterId: null, metadata: { report_id: null, from_state: "EDITORIAL_INSPECTING", decided_by: "gate" } }, "missing_reference");
  await rejects(base({ occurredAt: "yesterday" }), "invalid_timestamp");
  await rejects(base({ occurredAt: "2027-01-01T00:00:00Z" }), "invalid_timestamp");
  await rejects(base({ actorType: "robot" as never }), "invalid_actor");
  await rejects(base({ schemaVersion: 2 }), "schema_version_mismatch");
  await rejects(base({ idempotencyKey: "short" }), "invalid_schema");
});

test("persistence failure is a typed rejection and nothing is reported as recorded", async () => {
  const d = deps(); d.store.failNext = new Error("connection reset");
  await assert.rejects(recordBusinessEvent(base(), d), (e: BusinessEventRejected) => e.reason === "persistence_failure");
  assert.equal(d.rejections.rejections[0].reason, "persistence_failure");
  assert.equal((await recordBusinessEvent(base(), d)).status, "recorded", "the retry succeeds and records once");
});

// ---------- privacy ----------
test("forbidden metadata keys and secret-like values are rejected, in nested objects and arrays too", async () => {
  await rejects(base({ metadata: { production_type: "reel", language: "es", duration_seconds_requested: 1, password: "x" } }), "forbidden_metadata");
  for (const k of ["api_key", "authorization", "cookie", "card_number", "ip_address", "email", "refresh_token", "client_secret"]) assert.equal(sanitizeMetadata({ [k]: "v" }).ok, false, k);
  for (const v of ["sk-abcdefghijklmnop", "sk_live_abc123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "Bearer abc.def", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz1234", "xoxb-123", "4242424242424242", "-----BEGIN RSA PRIVATE KEY-----", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2"]) assert.equal(looksSecret(v), true, v);
  assert.equal(looksSecret("a".repeat(64)), false, "a sha256 checksum is data, not a secret");
  assert.equal(looksSecret("long_form"), false);
  await rejects(base({ metadata: { production_type: "reel", language: "es", duration_seconds_requested: 1, note: "sk-abcdefghijklmnop" } }), "secret_like_value");
  assert.equal(sanitizeMetadata({ a: { b: { c: { d: 1 } } } }).ok, false, "depth limit");
  assert.equal(sanitizeMetadata({ items: [{ token_like: "x" }] }).ok, false, "forbidden key inside array");
  assert.equal(sanitizeMetadata({ "Bad-Key": 1 }).ok, false, "key shape");
  assert.equal(sanitizeMetadata([1]).ok, false);
});

// ---------- money ----------
test("money never travels without a currency; invalid currency rejected; original amount/currency preserved, never converted", async () => {
  const pay = (amount: unknown): BusinessEventInput => ({ eventType: "payment_succeeded", occurredAt: "2026-09-29T10:00:00Z", actorType: "webhook", actorId: "stripe", userId: USER, source: "stripe", provenance: "observed_live", idempotencyKey: "payment_succeeded:stripe:evt_123456", metadata: { billing_provider: "stripe", external_payment_ref: "pi_1", amount } });
  await rejects(pay({ amount: 19 }), "invalid_currency");
  await rejects(pay({ amount: 19, currency: "XXX" }), "invalid_currency");
  await rejects(pay({ amount: 19, currency: "usd" }), "invalid_currency");
  await rejects(pay(19), "invalid_schema");
  const d = deps(); const r = await recordBusinessEvent(pay({ amount: 349, currency: "MXN" }), d);
  assert.deepEqual(r.event.metadata.amount, { amount: 349, currency: "MXN" });
  assert.ok(ISO_4217.includes("USD") && ISO_4217.includes("MXN"));
});

// ---------- provider consumption ----------
test("top-up != COGS: a balance event never becomes consumption; only COMMITTED Cost Engine entries do", async () => {
  const ledger = new CostLedger("p1");
  ledger.recordTopUp({ provider: "openai", kind: "TOP_UP", amountUsd: 100, at: NOW, note: "recharge" });
  assert.throws(() => consumptionFromBalanceEvent(ledger.balanceJournal[0]), NotConsumptionError);
  const key = "cost_" + "1".repeat(24);
  ledger.entries.set(key, { costKey: key, requestId: "p1", shotId: "S1", provider: "runway", assetType: "ai_video", method: "I2V_ECONOMY" as never, estimatedUsd: 0.3, reservedUsd: 0.3, actualUsd: null, status: "RESERVED", updatedAt: NOW });
  assert.throws(() => consumptionFromCostEntry(ledger.entries.get(key)!, { attemptKind: "initial", source: "cost_engine" }), NotConsumptionError, "reserved is not consumption");
  ledger.commit(key, 0.25, "2026-09-29T11:00:00Z");
  const input = consumptionFromCostEntry(ledger.entries.get(key)!, { attemptKind: "initial", source: "cost_engine", model: "gen4_turbo", units: { quantity: 5, unit: "seconds" } });
  const d = deps(); const r = await recordBusinessEvent(input, d);
  assert.equal(r.status, "recorded");
  assert.deepEqual(r.event.metadata.actual, { amount: 0.25, currency: "USD" }, "actual copied from the Cost Engine, not recomputed");
  assert.equal(r.event.provider, "runway"); assert.equal(r.event.productionId, "p1"); assert.equal(r.event.metadata.consumption_kind, "committed_consumption");
  assert.equal(d.store.events.size, 1, "the USD 100 top-up produced no event");
  assert.throws(() => ledger.commit(key, 0.5, NOW));
  assert.throws(() => consumptionFromCostEntry(ledger.entries.get(key)!, { attemptKind: "retry", source: "cost_engine" }), /reconciliation required/);
});

test("provider fallback is observable and attributable: Runway fails → OpenAI executes → actual provider/cost recorded; trace sums per currency", async () => {
  const d = deps();
  const op = (key: string, provider: string, attemptKind: "initial" | "retry" | "fallback", committedUsd: number | null, status: string, fallbackFromProvider: string | null = null) => consumptionFromPaidOperation({ idempotencyKey: key, projectId: "p7", shotId: "S3", provider, model: provider === "runway" ? "gen4_turbo" : "sora-2", method: "I2V_ECONOMY", attemptKind, committedUsd, status, updatedAt: "2026-09-29T11:00:00Z" }, { source: "pi_paid_operations", fallbackFromProvider, attemptKind });
  assert.throws(() => op("op_fail", "runway", "initial", null, "REFUNDED"), NotConsumptionError, "a refunded failure is not consumption");
  assert.throws(() => op("op_fb", "openai", "fallback", 0.4, "COMMITTED"), NotConsumptionError, "a fallback must name the replaced provider");
  assert.throws(() => op("op_x", "openai", "initial", 0.4, "COMMITTED", "runway"), NotConsumptionError, "fallback_from only on fallback");
  await recordBusinessEvent(op("op_fb", "openai", "fallback", 0.4, "COMMITTED", "runway"), d);
  await recordBusinessEvent(op("op_voice", "elevenlabs", "initial", 0.05, "COMMITTED"), d);
  await recordBusinessEvent(op("op_fb", "openai", "fallback", 0.4, "COMMITTED", "runway"), d);
  const trace = traceProduction("p7", d.store.list());
  assert.deepEqual(trace.providers, ["elevenlabs", "openai"]);
  assert.deepEqual(trace.fallbacks, [{ from: "runway", to: "openai", operationKey: "op_fb" }]);
  assert.deepEqual(trace.totalByCurrency, { USD: 0.45 });
  assert.equal(trace.operations.length, 2, "duplicate emission counted once");
  assert.equal(trace.operations[0].model, "sora-2");
  assert.deepEqual(traceProduction("other", d.store.list()).operations, []);
});

// ---------- attribution ----------
test("UTM allowlist: only utm_*, gclid, fbclid and the landing PATH are captured; arbitrary/sensitive parameters ignored or refused", () => {
  const params = new URLSearchParams("utm_source=newsletter&utm_medium=email&utm_campaign=launch&gclid=Cj0KCQ&promo=SECRET&email=a@b.c&utm_term=history&session_token=abc");
  const r = captureAttribution({ params, landingPage: "https://atomivid.app/pricing?token=abc#x", visitorId: "visitor_00000001", touchedAt: "2026-09-20T10:00:00Z", source: "web" });
  assert.ok(r.ok);
  assert.deepEqual(r.touch.utm, { utm_source: "newsletter", utm_medium: "email", utm_campaign: "launch", utm_term: "history" });
  assert.deepEqual(r.touch.clickIds, { gclid: "Cj0KCQ" });
  assert.equal(r.touch.landingPage, "/pricing", "query string and fragment never stored");
  assert.deepEqual(r.ignoredKeys, ["email", "promo", "session_token"]);
  assert.match(r.touch.touchId, /^att_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(r.touch).includes("SECRET"), false);
  assert.deepEqual([...UTM_ALLOWLIST], ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]); assert.deepEqual([...CLICK_ID_ALLOWLIST], ["gclid", "fbclid"]);
  assert.equal(captureAttribution({ params: { utm_source: "a@b.c" }, visitorId: "visitor_00000001", touchedAt: NOW, source: "web" }).ok, false, "e-mail inside a UTM refused");
  assert.equal(captureAttribution({ params: { utm_campaign: "sk-abcdefghijklmnop" }, visitorId: "visitor_00000001", touchedAt: NOW, source: "web" }).ok, false, "secret-like UTM refused");
  assert.equal(captureAttribution({ params: { foo: "bar" }, visitorId: "visitor_00000001", touchedAt: NOW, source: "web" }).ok, false, "nothing allowlisted = no touch");
  assert.equal(captureAttribution({ params: {}, visitorId: "v", touchedAt: NOW, source: "web" }).ok, false, "invalid visitor id");
});

test("first touch / last touch resolve deterministically from append-only touches; a re-sent touch is not duplicated", async () => {
  const store = new MemoryAttributionStore();
  const t = (at: string, utm: Record<string, string>) => { const r = captureAttribution({ params: utm, landingPage: "/", visitorId: "visitor_00000001", touchedAt: at, source: "web" }); assert.ok(r.ok); return r.touch; };
  const first = t("2026-09-01T00:00:00Z", { utm_source: "google", utm_medium: "cpc" });
  const mid = t("2026-09-10T00:00:00Z", { utm_source: "newsletter" });
  const last = t("2026-09-20T00:00:00Z", { utm_source: "youtube", utm_medium: "organic" });
  for (const x of [mid, last, first, last]) await store.append(x);
  assert.equal(store.touches.size, 3);
  const res = resolveTouches(await store.forVisitor("visitor_00000001"))!;
  assert.equal(res.firstTouch.utm.utm_source, "google"); assert.equal(res.lastTouch.utm.utm_source, "youtube"); assert.equal(res.touches, 3);
  assert.equal(resolveTouches([]), null);
  // relation campaign → visit → registration is preserved through visitor_id on user_registered
  const reg = deriveUserRegistered({ id: USER, createdAt: "2026-09-21T00:00:00Z", visitorId: "visitor_00000001" })!;
  assert.equal((reg.metadata as { visitor_id: string }).visitor_id, "visitor_00000001");
});

// ---------- derivation / backfill ----------
test("no speculative backfill: derivation only with real timestamps and identities; completed/failed/billing never derived", async () => {
  assert.ok(deriveProductionRequested({ id: "r1", userId: USER, mode: "visual", createdAt: "2026-09-01T00:00:00Z", language: "en", durationSeconds: 60 }));
  assert.equal(deriveProductionRequested({ id: "r1", userId: USER, mode: "visual", createdAt: "" }), null);
  assert.equal(deriveProductionStarted({ id: "r1", userId: USER, mode: "visual", createdAt: NOW, renderStartedAt: null }), null, "no render_started_at → no event");
  assert.equal((deriveProductionStarted({ id: "r1", userId: USER, mode: "long_form", createdAt: NOW, renderStartedAt: "2026-09-02T00:00:00Z", renderAttempts: 2 })!.metadata as { attempt: number }).attempt, 2);
  assert.equal(deriveFinalCutDecision({ id: 1, productionId: "p1", masterId: "m1", fromState: "EDITORIAL_PENDING", toState: "EDITORIAL_INSPECTING", decidedAt: NOW }), null, "intermediate states are not business events");
  const pass = deriveFinalCutDecision({ id: 2, productionId: "p1", masterId: "m1", fromState: "EDITORIAL_INSPECTING", toState: "EDITORIAL_QA_PASS", decidedAt: "2026-09-03T00:00:00Z", reportId: "fcr_1" })!;
  assert.equal(pass.eventType, "final_cut_passed"); assert.equal(pass.idempotencyKey, "final_cut_passed:fc_qa_decisions:2");
  assert.equal(deriveFinalCutDecision({ id: 3, productionId: "p1", masterId: "m1", fromState: "HUMAN_REVIEW_REQUIRED", toState: "EDITORIAL_QA_FAIL", decidedAt: NOW, humanOverride: { by: "producer" } })!.actorType, "admin");
  assert.equal(deriveYouTubeLinked({ linkKey: "p1:dQw4w9WgXcQ", projectId: "p1", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", masterChecksumSha256: "a".repeat(64), linkedAt: NOW, linkedBy: "producer", status: "unlinked" }), null);
  assert.equal(deriveYouTubeSnapshot({ snapshotKey: "s1", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", window: "7d", status: "PENDING", collectedAt: null }), null);
  assert.ok(NOT_DERIVABLE.production_completed && NOT_DERIVABLE.payment_succeeded);
  // every derivation is reproducible: same row → same key → one record
  const d = deps(); const row = { id: "r1", userId: USER, mode: "visual", createdAt: "2026-09-01T00:00:00Z" };
  await recordBusinessEvent(deriveProductionRequested(row)!, d); await recordBusinessEvent(deriveProductionRequested(row)!, d);
  assert.equal(d.store.events.size, 1);
  assert.equal(d.store.list()[0].provenance, "derived_from_canonical_record");
});

// ---------- health / command center ----------
test("telemetry health: UNKNOWN is never HEALTHY; failures degrade; only observed writes can be healthy", () => {
  assert.equal(telemetryHealth({ storeAvailable: null, lastSuccessfulWriteAt: null, eventsRecorded: null, validationFailures: null, persistenceFailures: null, now: NOW }).state, "UNKNOWN");
  assert.equal(telemetryHealth({ storeAvailable: false, lastSuccessfulWriteAt: NOW, eventsRecorded: 5, validationFailures: 0, persistenceFailures: 0, now: NOW }).state, "UNKNOWN");
  assert.equal(telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: null, eventsRecorded: 0, validationFailures: 0, persistenceFailures: 0, now: NOW }).state, "UNKNOWN", "zero events is not healthy");
  assert.equal(telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: NOW, eventsRecorded: 3, validationFailures: 0, persistenceFailures: 0, now: NOW }).state, "HEALTHY");
  assert.equal(telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: NOW, eventsRecorded: 3, validationFailures: 2, persistenceFailures: 0, now: NOW }).state, "DEGRADED");
  assert.equal(telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: NOW, eventsRecorded: 3, validationFailures: 0, persistenceFailures: 1, now: NOW }).state, "DEGRADED");
  assert.equal(telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: NOW, eventsRecorded: 3, validationFailures: null, persistenceFailures: null, now: NOW }).state, "DEGRADED", "unknown failure facts cannot be healthy");
});

test("Command Center telemetry foundation: no ledger → UNAVAILABLE with no numbers; empty ledger → 0 events but UNKNOWN health; data → real counts; screen untouched", async () => {
  const env = { AVATAR_PREPARATION_OWNER_EMAIL: "owner@atomivid.test" };
  const owner = { id: "u-owner", email: "owner@atomivid.test", email_confirmed_at: NOW };
  type T = ReturnType<typeof aggregateTelemetry>;
  const none = new CommandCenterService({ source: memorySource(RICH), env, now: () => NOW });
  const t0 = (await none.section(owner, "telemetry", "7D")).data as T;
  assert.equal(t0.state, "UNAVAILABLE"); assert.equal(t0.health, "UNKNOWN"); assert.equal(t0.eventsCollected.value, null); assert.equal(t0.rejections.value, null);
  const d = deps();
  const svc = new CommandCenterService({ source: memorySource(RICH), telemetry: memoryTelemetrySource(d.store, d.rejections), env, now: () => NOW });
  const t1 = (await svc.section(owner, "telemetry", "7D")).data as T;
  assert.equal(t1.eventsCollected.value, 0); assert.equal(t1.eventsCollected.state, "KNOWN"); assert.equal(t1.health, "UNKNOWN", "0 events: UNKNOWN, not HEALTHY"); assert.equal(t1.lastEventAt, null);
  await recordBusinessEvent(base(), d); await assert.rejects(recordBusinessEvent(base({ eventType: "nope" }), d));
  const ov = await svc.section(owner, "overview", "7D");
  const t2 = (ov.data as { telemetry: ReturnType<typeof aggregateTelemetry> }).telemetry;
  assert.equal(t2.eventsCollected.value, 1); assert.equal(t2.lastEventAt, "2026-09-29T10:00:00.000Z"); assert.equal(t2.lastWriteAt, NOW); assert.equal(t2.rejections.value, 1); assert.equal(t2.health, "DEGRADED");
  const failing = new CommandCenterService({ source: memorySource(RICH), telemetry: { summary: async () => { throw new Error("boom"); } }, env, now: () => NOW });
  assert.equal(((await failing.section(owner, "telemetry", "7D")).data as T).state, "UNAVAILABLE", "a failing source never fabricates");
  assert.ok(SECTIONS.includes("telemetry"));
  const view = fs.readFileSync("src/app/dashboard/command-center/CommandCenterView.tsx", "utf8"); assert.ok(!/telemetry/i.test(view), "Command Center screen not redesigned");
  assert.equal(aggregateTelemetry(null, NOW).note, "Business telemetry not available");
});

// ---------- constitution / scope ----------
test("no autonomy: AUTO_EXECUTE is false, constitution documents the eight principles and the L0-L5 levels, no ad/Stripe/payment execution code in the module", () => {
  assert.equal(AUTO_EXECUTE, false);
  const c = fs.readFileSync("docs/operating-intelligence/CONSTITUTION.md", "utf8");
  for (const p of ["SINGLE SOURCE OF TRUTH", "DEFINITIONS BEFORE DASHBOARDS", "UNKNOWN != ZERO != HEALTHY", "OBSERVED != PROJECTED", "RESERVED CASH BEFORE REINVESTABLE CASH", "CONFIDENCE GOVERNS LANGUAGE", "COLLECT EARLY, AUTOMATE LATE", "RECOMMENDER != EXECUTOR", "AUTO_EXECUTE = FALSE", "L0", "L5"]) assert.ok(c.includes(p), p);
  const src = fs.readdirSync("src/lib/business-telemetry").filter((f) => !f.endsWith(".test.ts")).map((f) => fs.readFileSync(`src/lib/business-telemetry/${f}`, "utf8")).join("\n");
  assert.ok(!/predicted_|forecast|expected_cac|ltv|payback/i.test(src), "no projections in V0");
  assert.ok(!/googleads|facebook\.com\/ads|graph\.facebook|stripe\.com|paymentIntents|refunds\.create|transfers\.create/i.test(src), "no financial or ad execution surface");
  assert.ok(!/from\("(video_requests|generation_costs|subscriptions|pi_paid_operations)"\)/.test(src), "telemetry does not re-read canonical tables to recompute facts");
  assert.equal(networkCalls, 0);
});

// ---------- migration 0030 ----------
test("migration 0030: additive, no destructive lines, RLS without policies on the three tables, client revokes, append-only triggers, pinned search_path; manifest and verify test present", () => {
  const sql = fs.readFileSync("supabase/migrations/0030_business_telemetry_foundation.sql", "utf8");
  const DESTRUCTIVE = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|update\s+public\.|alter\s+column\s+\w+\s+type|rename\s+(table|column))\b/i;
  for (const line of sql.split("\n")) assert.ok(!DESTRUCTIVE.test(line.split("--")[0]), `destructive: ${line}`);
  const code = sql.split("\n").map((l) => l.split("--")[0]).join("\n").toLowerCase();
  assert.ok(!/create\s+policy/.test(code) && !/using\s*\(\s*true\s*\)/.test(code) && !/with\s+check\s*\(\s*true\s*\)/.test(code) && !/security\s+definer/.test(code) && !/\bgrant\b/.test(code));
  for (const t of ["business_events", "business_event_rejections", "business_attribution_touches"]) {
    assert.ok(code.includes(`create table if not exists public.${t}`), t);
    assert.ok(code.includes(`alter table public.${t} enable row level security`), `${t} rls`);
    assert.ok(code.includes(`revoke all on public.${t} from anon, authenticated`), `${t} revoke`);
    assert.ok(code.includes(`create trigger ${t}_append_only before update or delete on public.${t}`), `${t} append-only`);
  }
  assert.ok(code.includes("set search_path = pg_catalog, public") && code.includes("create or replace function public.bt_append_only()"));
  assert.ok(code.includes("idempotency_key text not null unique") && code.includes("jsonb_typeof(metadata) = 'object'") && code.includes("provenance in ('observed_live', 'derived_from_canonical_record')"));
  assert.ok(!/0029|0028/.test(code.replace(/migration 0030/g, "")), "does not touch earlier migrations");
  const manifest = JSON.parse(fs.readFileSync("supabase/migration-manifest.json", "utf8")) as { migrations: { migrationName: string; sha256: string; knownProductionApplied: boolean }[] };
  const entry = manifest.migrations.find((m) => m.migrationName === "0030_business_telemetry_foundation.sql");
  assert.ok(entry); assert.equal(entry.sha256, crypto.createHash("sha256").update(fs.readFileSync("supabase/migrations/0030_business_telemetry_foundation.sql")).digest("hex")); assert.equal(entry.knownProductionApplied, false);
  const verify = fs.readFileSync("supabase/migrations/verify/08_business_telemetry_test.sql", "utf8");
  for (const s of ["set role anon", "set role authenticated", "set role service_role", "\\i supabase/migrations/0030_business_telemetry_foundation.sql", "bt_append_only"]) assert.ok(verify.includes(s), s);
  assert.ok(fs.readFileSync("supabase/migrations/verify/README.md", "utf8").includes("08_business_telemetry_test.sql"));
});
