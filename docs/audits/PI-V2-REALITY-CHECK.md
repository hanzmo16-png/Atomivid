# ATOMIVID — Production Intelligence V2 Hardening, Fase A: Code Reality Check / Gap Analysis

**Date:** 2026-10-02 · **Repo:** `hanzmo16-png/Atomivid` · **HEAD audited:** `692e9ec` (branch `claude/production-intelligence-v1`) · **Updated:** Fase B1 (RB-01 double-charge guard, section 17) Fase B2 (RB-02 capacity hold, section 18) Fase B3 (RB-06 owner-scoped signing, section 19) and Fase B3.1 (RB-06 column guard migration 0031, section 20) · **Mode:** READ-ONLY (no code, no migrations, no deploy, no paid calls, no assets, no render, no publish) · **Spend:** USD 0.00

**Scope rule.** "Product path" / "Generate" means the customer flow and nothing else:
`POST /api/generate/[id]/render` (`src/app/api/generate/[id]/render/route.ts`) → `src/lib/worker/{index,github-actions}.ts` → `.github/workflows/render.yml` → `scripts/render-worker.ts` → `src/lib/video/run-job.ts` → `src/lib/video/generate-video.ts` (Reel) · `src/lib/video/long-form/produce.ts` (Long Form) · `src/lib/video/avatar/pipeline.ts` (Avatar).

**Modules that are NOT on the product path** (grep of imports from `src/lib/video`, `src/lib/worker`, `src/app`: zero hits): `src/lib/production-intelligence/*` (PI V1/V1.1, frozen), `src/lib/production-core/*`, `src/lib/final-cut/*`, `src/lib/delivery/policy.ts`, `src/lib/video/visual-qa.ts`. Their consumers are `scripts/*`, distribution and telemetry. Nothing they enforce counts for a blocker unless stated.

**Classification rules applied** (from the mandate): IMPLEMENTED = executable code + real enforcement on the product path + an automated test proving the invariant. Code without a test, or a test that does not prove the invariant = PARTIAL. A control whose only defence is a prompt, a comment, a doc or an operator procedure = MISSING as an autonomous control. UNVERIFIABLE only when the control lives outside the repo (provider console, manual ACL, dashboard setting). UNKNOWN ≠ PASS.

**Cross-cutting fact that caps every rating:** no workflow in `.github/workflows/` runs `test:unit`, `npm test` or `node --test` (grep: 0 hits). Every "test exists" below means "exists locally"; nothing enforces it in CI.

---

## 1. Executive summary

- **RELEASE READINESS: NOT_READY.** After Fase B3: 6 of 13 blockers are MISSING on the product path (RB-03, RB-07, RB-08, RB-09, RB-10, RB-13); 7 are PARTIAL (RB-01 since B1, RB-02 since B2, RB-06 since B3, RB-04, RB-05, RB-11, RB-12); 0 IMPLEMENTED. One MISSING is enough for NOT_READY; there are six.
- **The money path is unprotected where it matters.** The Reel branch of Generate reaches ElevenLabs (`src/lib/ai/voice.ts:113`), OpenAI images and Beatoven with no provider-call record, no idempotency key, no timeout, no reconciliation. Long Form has a real write-ahead record (STARTED → COMPLETED in Storage JSON) with tests, but no idempotency key reaches any provider, a Storage read error is treated as "absent" (resubmission), and there is no sweeper. **A timeout can produce two charges** (RB-01: yes, both branches). **Ten jobs can read the same balance and all start** (RB-02: yes; quota is a read-then-act count, provider balance is never read on Generate).
- **PI V1's ledger (`pi_paid_operations`, `executePaidOperation`) is correct but unreachable:** it is not imported by anything on the product path. The red team's RESERVED/DISPATCHED/NEEDS_RECONCILE model exists in migration 0023 and in `src/lib/production-intelligence/ledger.ts`, and Generate never passes through it.
- **Tenant isolation has a concrete hole** (RB-06): the `video_requests` INSERT policy (`0001_init.sql:27-29`) checks only `auth.uid() = user_id`; no column grant or trigger constrains `status`, `video_path`, `render_attempts`, `created_at` or `long_form_production_plan`. The dashboard signs `video_path` with the service role without a path check (`src/lib/storage/signed-url.ts:13-23`, `src/app/dashboard/videos/[id]/page.tsx:67-68`). Static reading shows a cross-tenant read and quota/attempt bypass; not executed in this turn.
- **Content contracts are prompts, not code** (RB-07, RB-08, RB-09): no pronunciation dictionary, voice pin or display/tts split on the product request builder; shot class is a rotating cycle with silent downgrade to a Ken Burns still by design; factual support is self-labelled by the same LLM and never validated.
- **No composed-frame QA on the product path** (RB-10): the only frame-level QA in the repo is the operator script `scripts/video-004/render.ts:279-311` (no test). The AI-video clip on Long Form carries no provenance label (`shot-executor.ts:439` → `produce.ts:631`).
- **Thermopylae regressions R1–R9 are documented, not tested:** 6 TEST_MISSING, 4 TEST_PARTIAL, 0 TEST_EXISTS.
- **Concurrency: sin límite en código** at user, tenant, provider and global level. The only lock on the product path is the per-request GitHub Actions concurrency group plus a compare-and-set on `video_requests`.

---

## 2. Table of 13 blockers

| ID | Blocker | Status (product path) | Branch detail | Complexity |
|---|---|---|---|---|
| RB-01 | Provider idempotency / reconciliation | **PARTIAL** (B1; was MISSING at `692e9ec`) | Every paid call site named in section 4 now writes a `pi_paid_operations` row before the HTTP (section 17). Still open: sweeper, CI, idempotency key not sent to providers, no-shotId AI video path, test-only in-process fallback ledgers | L |
| RB-02 | Atomic budget / capacity hold | **PARTIAL** (B2; was MISSING at `692e9ec`) | Atomic provider-capacity hold on `pi_paid_operations` before any Generate job reaches the gate (section 18): voice units only; balance through a port reading `pi_capacity_snapshots`; UNKNOWN = no job. Still open: user/platform USD caps, images/video demand, stale-hold sweeper, real balance monitor, CI | L |
| RB-03 | Paid asset saga / storage consistency | **MISSING** | Reel MISSING · Long Form PARTIAL | M |
| RB-04 | Single job owner / fencing | **PARTIAL** | CAS + attempt token on `video_requests` only | M |
| RB-05 | Review ≠ publish | **PARTIAL** | No publish code exists; no review state exists | S |
| RB-06 | Secrets / signed-URL redaction / tenant isolation | **PARTIAL** (B3; was MISSING at `692e9ec`) | Customer pages now sign only a path under the owned row's own `${id}/` prefix (section 19). Migration 0031 (written, verified on Postgres 16, NOT applied to production) stops clients writing `video_path`, `created_at`, `render_attempts`, the plan and the confirmation, and pins client rows to their own `user_id` and `pending`/`script_ready` (section 20). Still open: 0031 not applied, `avatars` insert shape, Sentry redaction, `isReviewOwner` wiring | M |
| RB-07 | Immutable pronunciation contract | **MISSING** | TTS cache identity PARTIAL | M |
| RB-08 | Visual class contract | **MISSING** | Downgrade is designed behaviour | L |
| RB-09 | Factual grounding / creative risk | **MISSING** | — | L |
| RB-10 | Final-frame license / attribution QA | **MISSING** | Cover-spec checks PARTIAL (cover only) | M |
| RB-11 | Master storage contract | **PARTIAL** | Long Form post-render PARTIAL · Reel MISSING · pre-generation gate MISSING | M |
| RB-12 | Controls in code, not prompts | **PARTIAL** | Paid gates in code; content controls prompt/operator-only | M (inventory) |
| RB-13 | AI motion autonomy contract | **MISSING** (as autonomous control) | Opt-in, reservation, bounded retry PARTIAL; artifact QA, same-class fallback, risk state, review boundary MISSING | L |

---

## 3. Status per blocker

| ID | Status | One-line reason |
|---|---|---|
| RB-01 | PARTIAL (B1) | At `692e9ec`: the Reel paid calls (`voice.ts:113`, `providers/image/openai.ts:134`, `providers/music/beatoven.ts:83`) had no durable record, no key, no timeout. Since B1 (section 17) all Generate paid call sites pass through `guardPaidCall` on `pi_paid_operations` with mock tests; no sweeper, no CI, no provider-side key. |
| RB-02 | PARTIAL (B2) | At `692e9ec`: `assertCanGenerate` (`billing/quota.ts:91-145`) was read-then-act and no balance was read on Generate. Since B2 (section 18) the worker acquires an atomic hold (PK-serialised sequence on `pi_paid_operations`) against a snapshot balance before dispatch; UNKNOWN or a failed read starts nothing. The monthly quota count in `quota.ts` is unchanged (still read-then-act, still forgeable per RB-06). |
| RB-03 | MISSING | Reel pays, uploads `${requestId}/attempt-N/*`, then writes `video_path` in a separate step; a retry re-pays voice and music. No content-addressed paths, no orphan GC, no reconciliation except Long Form's output size check. |
| RB-04 | PARTIAL | Compare-and-set on `status`/`render_attempts` (`render/route.ts:163-180`, `attempt-state.ts:6-18`) with a race test against a fake PostgREST; no lease expiry, no `pipeline_version`, Storage/budget writes unfenced, script routes unfenced. |
| RB-05 | PARTIAL | `AUTO_PUBLISH` is the literal `false` and tested; no YouTube write endpoint is called anywhere; bucket private since 0006. But `READY_FOR_REVIEW`/`PUBLISH_REQUESTED`/`PUBLISHED` do not exist and `completed` is delivery. |
| RB-06 | PARTIAL (B3) | At `692e9ec`: INSERT policy with no column restriction + unchecked `video_path` signing = cross-tenant read (static). Since B3 the signing is owner- and prefix-scoped (section 19) so a forged `video_path` yields no URL; the insert policy itself still lets a client set `status`, `created_at`, `render_attempts` and the plan (quota/attempt/budget bypass), which only SQL can close. `redactSignedUrl` still unused at runtime (nothing logs a URL); Sentry has no `beforeSend`; `isReviewOwner` not wired on this branch. |
| RB-07 | MISSING | Product request body is `{text, model_id, voice_settings}` (`voice.ts:121-125`): no dictionary, no version, no SSML; voice/model from env at call time; captions from TTS words; no alias lint. |
| RB-08 | MISSING | Shot type from `STRATEGY_CYCLES` (`long-form/shots.ts:41-61,229`); `allocateShotTypes` converts `ai_video` → `generated_placeholder` → `ken_burns_image` (`production-plan.ts:233-245`); tests assert the downgrade. |
| RB-09 | MISSING | `ClaimSchema.support` is LLM self-labelled (`documentary-script.ts:56-66`), never validated; sources not persisted (`long-form/new/actions.ts:118-121`); no judge, no spans, no hashes. |
| RB-10 | MISSING | No frame is extracted from the rendered master on the product path; `creditText` never set; AI-video scene gets `provenance: undefined`; 3072/2304 class of error is undetectable in product. |
| RB-11 | PARTIAL | TUS upload, size-fit, sha256 in `state/output.json`, reconciliation by size (Long Form, tested on memory fakes). `estimateOutputBytes` has no product caller; Reel has no policy; no proxy; no capacity reservation. |
| RB-12 | PARTIAL | Quota, confirmation, plan pin, durable budget, real-mode token, CAS are code. Factual, visual-fallback, voice allowlist, pronunciation, Reel quality gate are prompt/comment/operator-only. |
| RB-13 | MISSING | Opt-in (`strategy === "cinematic"` + `LONG_FORM_AI_VIDEO_ENABLED`) and write-ahead reservation are code+tests, but fallback crosses class to a still, artifact QA is byte sniffing of declared metadata, no `UNVERIFIED_GENERATIVE`, no human gate before `status: "completed"`. |

---

## 4. Exact evidence per blocker

### RB-01 — Provider idempotency / reconciliation

**Paid call sites reachable from Generate (trace):**

| Branch | Trace | Call site | Record before call | Idempotency key sent | Timeout | Retry after possible charge |
|---|---|---|---|---|---|---|
| Reel voice | `run-job.ts` → `generate-video.ts:122` and `:145` (speed correction = second paid call) → `providers/voice/real.ts:7` → `ai/voice.ts:93 synthesizeVoice` | `voice.ts:113` `fetch(https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps)` | none | none | none | n/a (no retry, but a new attempt re-pays) |
| Reel image | `generate-video.ts:210-237` → `visual-resource-resolver` → `providers/image/openai.ts:134` | `openai.ts:134` | none (in-memory `visualCostSpentUsd`) | none | client-side | retry loop `openai.ts:255-276` on `upstream_error`, which includes HTTP 5xx; `openai.test.ts:248-270` asserts the retry |
| Reel music | `generate-video.ts` → `providers/music/beatoven.ts:83` | `beatoven.ts:83` | none | none | — | — |
| Long Form TTS | `produce.ts:214-227` → `production-tts-cache.ts:123,175-215` → `timeline.ts:81` → `voice.ts:113` | same | STARTED record `long-form/${id}/state/tts/${key}.json` before call, COMPLETED after | none | none | STARTED throws `TtsUncertainCostStateError` (blocks resubmission) |
| Long Form image | `shot-executor.ts:273-299` → `durable-shot-assets.ts` → `openai.ts:134` | same | STARTED/COMPLETED/FAILED_NO_CHARGE record | none | — | as Reel image |
| Long Form AI video | `shot-executor.ts:423-439` → `ai-video-resolver.ts` → `ai-video-durable-provider.ts:75-316` → `runway.ts:63` / `veo.ts:227` | same | STARTED with `providerJobId` before polling; `maxInAttemptResumes: 2` (`produce.ts:310`), never resubmit | none | Runway `POLL_TIMEOUT_MS=180000`, Veo 240 s; **no timeout on the submit POST** | Runway `maxRetries: 0`; Veo ambiguous POST unrecorded |
| Avatar | `avatar/pipeline.ts:245-260` claim (`avatar_generation_started_at` CAS, migration 0014) → `heygen.ts:60/119`, `did.ts:322-338` (no retry) and `did.ts:262-267` (2 retries on image upload) | provider | DB claim, single attempt | none | — | D-ID image upload retried ×2 |

**Reconciliation / sweeper:** none on the product path. `deleteAiVideoClipRecord` is unused. Storage read errors are treated as "absent" and lead to resubmission: `ai-video-storage.ts:73-74`, `durable-shot-assets.ts:80-81`, `production-tts-cache.ts:59-60`.

**Timeout → two charges?** Yes. (a) Reel: `voice.ts` has no timeout; `limits.ts:14 RENDER_TIMEOUT_MS = 15 min` lets `evaluateRenderStart` admit a new attempt while the old job (job timeout 18 min, `render.yml:41`) is still in the provider call; both calls are billed, the old one is then fenced only at its next DB write. (b) Long Form: Veo submit POST is unrecorded if the process dies between POST and record write; Storage read error → resubmit.

**PI ledger (off path):** `supabase/migrations/0023_production_intelligence.sql:24,31-39` `pi_paid_operations` (PK `idempotency_key`, states RESERVED/SUBMITTED/PROVIDER_JOB_RECORDED/COMMITTED/REFUNDED/RECONCILIATION_REQUIRED, forward-only trigger); `src/lib/production-intelligence/ledger.ts executePaidOperation`. Not imported by `src/lib/video`, `src/lib/worker`, `src/app` (grep: 0). Verified by `verify/03_production_intelligence_test.sql` against a local Postgres only.

**Tests:** `ai-video-durable-provider.test.ts`, `ai-video-durable-failure-injection.test.ts` (A–F, in-memory store, strong invariants: STARTED never resubmitted, moderation never retried); `tts-cache.test.ts:290`, `production-tts-cache.test.ts:167` (STARTED throws); `runway.test.ts` (ambiguous POST never retried); `attempt-state.test.ts` (duplicate claim race on fake PostgREST). **None for Reel** (`produce.test.ts:5-9` is Long Form). No test proves "a timeout cannot double-charge".

### RB-02 — Atomic budget / capacity hold

- User quota: `src/lib/billing/quota.ts:91-145 assertCanGenerate` — `select count(*)` of `video_requests` with `status in (processing, completed)` and `created_at >= start of month`, then returns `allowed`. No lock, no RPC, no `FOR UPDATE`; the CAS at `render/route.ts:163-180` guards the row, not the count. Two different requests of the same user pass simultaneously. `created_at` is client-writable (RB-06), so the count itself is forgeable.
- Long Form per-request budget: `production-budget.ts:44-120` `ProductionBudget` → Storage JSON `${requestId}/state/production-budget.json`, upsert, `load()` returns null on any error → fresh state `used = 0`. Covers generative image/video only (`production-plan.ts:143`); TTS, QA, render, storage are not in the hold. Write-ahead `reserveAiVideoSubmit` before submit (`produce.ts:309`, `ai-video-durable-provider.ts:189,250`). Tests: `production-budget.test.ts` (reservation persisted before returning true; cap never exceeded), `shot-executor.test.ts:168`.
- Plan-time gate: `confirm-production.ts:88-104` compares estimated USD with `getLongFormBudget().maxTotalUsd` and pins the plan with CAS on `status='script_ready'` (migration 0019). `resolveExecutablePlan` (`production-plan.ts:367-388`) does **not** re-check the cap at run time (the plan JSON is client-writable, RB-06).
- Reel: `generate-video.ts:210-237` in-memory `visualCostSpentUsd` vs `getFeatureFlags().maxVisualCostUsd`; `ai-video-cost-guard.ts` in-memory. Nothing durable.
- After-the-fact accounting: `generation_costs` (migration 0008, PK `request_id`), written by `billing/usage.ts:101-123,246-268` as read-modify-write upsert, errors ignored.
- Provider balance: never read on Generate. `getHeygenWallet` only in scripts; `readDidCredits` only `/api/avatar/credits`. `production-intelligence/capacity/accounts.ts:50`: "Balance is UNKNOWN until an official endpoint is verified" (off path). `pi_capacity_snapshots` (0023:139-155) has no product writer.
- Platform/tenant headroom: none in code.

**Can 10 jobs read the same balance and all start?** Yes: 10 requests of one user each pass `assertCanGenerate` on the same count and each get their own CAS and runner. Across users there is no shared counter at all.

**Tests:** `quota.test.ts` (errors not masked; **no race test**), `production-budget.test.ts`, `ai-video-cost-guard.test.ts` (11, caps refuse), `cost-estimator.test.ts`, `confirm-production.test.ts:84` (double-click → one confirmation). No concurrency test anywhere on quota.

### RB-03 — Paid asset saga / storage consistency

- Reel: `generate-video.ts:299,367,406,471` `uploadToStorage` (`:561-585`, `upsert: true`, path `${requestId}/attempt-N/...`), `run-job.ts:180-183` writes `video_path` in a later fenced update. Provider charged → DB fails: the money is spent, nothing records it; a retry (`MAX_RENDER_ATTEMPTS = 3`) re-pays voice (`:122`), speed correction (`:145`), images and music. DB ok → storage fails: `uploadToStorage` throws, attempt fails, same re-pay on retry.
- Long Form: `ai-video-storage.ts:138-192` STARTED → upload → COMPLETED with sha256 in the record; `durable-shot-assets.ts` same pattern; clip stored twice via `persistMedia` (`shot-executor.ts:148-175`); `output-finalize.ts:155-302` with `reconcileExistingOutput` (`:128-135`, size only, not hash). Retry reuses COMPLETED records with zero calls (`produce-pipeline.test.ts` "0 paid calls on retry").
- Content-addressed storage: none. Paths are `${requestId}/...`; the TTS cache key is a sha256 of the identity (`tts-cache.ts:72`) but the stored object is not addressed by content hash.
- Orphan recovery / GC: none. The only `.remove` is avatar cleanup in `src/app/dashboard/new/actions.ts:269/297/352`. Paid-object protection: `upsert: true` everywhere (`output-finalize.ts:87,103`, `durable-shot-assets.ts:93`, `production-tts-cache.ts:74`, `ai-video-storage.ts:82`); a stale attempt overwrites.
- `delivery_assets` (migration 0025, with checksum) has no product writer.

**Tests:** `ai-video-storage.test.ts`, `visual-test-v2-storage.test.ts` (round-trips), `output-delivery.test.ts` (17, memory fakes, no sha256 assertion). None for Reel, none for "charged but not stored".

### RB-04 — Single job owner / fencing

- Claim: `render/route.ts:163-180` update `.eq("id").eq("status", read).eq("render_attempts", read)` → `processing`, `render_attempts + 1`; 0 rows → 409. `render_attempts` is the fencing token, passed as `renderAttempt` (`worker/github-actions.ts client_payload`).
- Fenced writes: `attempt-state.ts:6-18` (`update` requires id + user_id + `status='processing'` + attempt; `claim` CAS `progress_stage` null/queued → voice). `run-job.ts:85-93,115-116,177-181`; `scripts/render-worker.ts:21-26`; `scripts/mark-render-failed.ts`.
- Workflow guard: `render.yml:28-30` `concurrency.group: atomivid-render-${requestId}`, `cancel-in-progress: false`.
- Plan version pin (Long Form only): `production-plan.ts:367-388` `EXECUTABLE_PLAN_VERSIONS=[1,2,3]`, `scriptHash` check.
- Gaps: no lease with expiry (`render-guard.ts isRenderStale` from clock: 15 min Reel, 25 min heartbeat Long Form; job timeouts 18/135 min exceed them; the old worker is never told to stop). Fencing covers only `video_requests`; `canonicalOutputPath = ${requestId}/output/final.mp4` upserted (`output-finalize.ts:33,87,103`), budget JSON last-writer-wins (`production-budget.ts:135-138`), `generation_costs` RMW. Unfenced status writes: `script/route.ts:157-161` (`update({status:"script_ready", script_json}).eq("id", id)` after a slow LLM call), `script/route.ts:240`, `regenerate-scene/route.ts:115-119`. Manual `workflow_dispatch` adopts the current attempt (`render-worker.ts:25`). No `pipeline_version` or `lease` column (grep: 0). No partial unique index "one processing attempt per request".
- Tests: `attempt-state.test.ts` (fake PostgREST; two concurrent claims → one wins; stale attempt fenced; foreign user blocked) — the only real race test, DB row only. `render-route-cas.test.ts` = regex over route source. `render-guard.test.ts` pure decision table. `confirm-production.test.ts:84`. None for `run-job.ts` end to end, output overwrite, budget concurrency, script-route races.

### RB-05 — Review ≠ publish

- States: `video_requests.status` ∈ {pending, script_ready, processing, completed, failed} (`0004_script_review.sql:16`). `READY_FOR_REVIEW`, `PUBLISH_REQUESTED`, `PUBLISHED`: grep 0 hits. `completed` = visible and signed on the dashboard (`dashboard/page.tsx:52-58`).
- Publish code: no call to `videos.insert`/`upload/youtube` anywhere (grep 0). `distribution/youtube/upload.ts:20-30 prepareUpload` builds an object only, hard-codes `privacyStatus: "private"`, requires `UPLOAD_PRIVATE` capability (env `YOUTUBE_UPLOAD_PRIVATE_ENABLED`, default off) and `approval.status === "approved"`. `capabilities.ts:22-36`: `AUTO_PUBLISH` typed as literal `false`; `assertCapability` always throws for `PUBLISH`/`SCHEDULE`. `prepareLaunchRecord`, `recordManualPublication`, `prepareUpload` have no non-test callers. OAuth: `connect-flow.ts:46-47` refuses non-read scopes; `yt_oauth_connections.refresh_token_enc` AES-256-GCM, RLS with no policy (0024); `yt_launch` status `PREPARED | PUBLISHED_MANUALLY` with `yt_launch_published_consistent` (0028:50).
- Public storage: `videos` made private in `0006_render_worker.sql:37-39`; no `getPublicUrl` in `src` (only `scripts/test-pipeline*.ts` stubs). `music-library` bucket "must be created manually" (`providers/music/storage.ts:4-12`) → **UNVERIFIABLE** (outside repo). Production bucket flag → UNVERIFIABLE from repo.
- Tenant-specific OAuth minor issue: `store.ts:67 upsertChannel` upserts on PK `channel_id`; a second account authorising the same channel takes over `owner_user_id`.
- Tests: `youtube.test.ts:25` (AUTO_PUBLISH false; public/schedule refused; upload-private off by default), `go-live.test.ts:78,166,193` (read-only scopes; never published by the app; no network), `monitoring.test.ts:118`, `delivery/policy.test.ts:16`. No static test bans a YouTube write endpoint; no test of the bucket flag against a DB; no review state for customer jobs.

### RB-06 — Secrets / signed-URL redaction / tenant isolation

- **Insert hole (static):** `0001_init.sql:27-29` `create policy "Users can insert their own video requests" ... with check (auth.uid() = user_id)`. No later migration revokes column privileges or adds a BEFORE INSERT trigger on `video_requests` (grep `revoke`/`trigger` on this table: 0). The app inserts with the user's own client (`dashboard/new/actions.ts:80`), so the policy is live. An authenticated user can PostgREST-insert a row with arbitrary `status`, `video_path`, `created_at`, `render_attempts`, `long_form_confirmed_at`, `long_form_production_plan`, `script_json`.
- **Cross-tenant read (static):** `src/app/dashboard/videos/[id]/page.tsx:67-68` and `src/app/dashboard/page.tsx:52-58` call `getSignedVideoUrl(request.video_path)` when `status === "completed"`; `src/lib/storage/signed-url.ts:13-23` signs any path with the service role and documents that the caller must check ownership; no caller does. Storage paths are keyed by request id, not user id. Owner-only review objects have fixed paths in source (`src/lib/delivery/review-stream.ts:16-47`), so forging `video_path` to one of them bypasses the `/r/[slug]` owner gate. **Not executed in this turn (read-only); demonstrated by reading the policy, the page and the helper.**
- Gate bypasses that follow: monthly quota counts by client-controlled `created_at` (`quota.ts:125-126`); `render_attempts` client-supplied; render route never calls `canAccessLongFormBeta` (only `confirm-production/route.ts:22`); `resolveExecutablePlan` does not re-check `maxTotalUsd` (forged plan → allocation from it, `production-budget.ts:55-75`); `LONG_FORM_REAL_RUN_CONFIRM` still applies.
- `avatars` has the same insert shape (`0011:119-122`); `pipeline.ts:143` checks `avatar.user_id` but not that the provider avatar belongs to that user.
- Per-route ownership (OK): render `:94`, script POST/PATCH `loadOwnedRequest :43-67`, regenerate-scene `:63`, confirm-production `:62`, avatar/diagnostic, stripe webhook signature, youtube connect/callback state-owner binding, review recording `isOwnedRecordingPath`.
- Review Delivery: `src/app/r/[slug]/route.ts:26` still gates with `canPrepareAvatar` (e-mail equality against `AVATAR_PREPARATION_OWNER_EMAIL`, `avatar/private-access.ts:6`); `isReviewOwner`/`REVIEW_DELIVERY_OWNER_USER_ID` (`review-stream.ts:124-134`) is defined and tested but **not called** on the route (grep in `src` excluding tests: definitions only). The production branch may differ (deployed route moved to `review-route.ts` per RC-002); this audit is of HEAD `692e9ec`.
- Secrets: public env limited to `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SENTRY_DSN`; `supabase/service.ts` has no `server-only` import guard; `render.yml` scopes secrets per mode; 18 `'use client'` files import only constants.
- Redaction: `redactSignedUrl` (`review-stream.ts:91`) used only by its test. Sentry (`sentry.server.config.ts`, `instrumentation-client.ts`) has no `beforeSend`. `run-job.ts:205-208` stores raw provider `error.message` in `error_message` for Reel/Avatar with a `(Código: …)` suffix that `job-error.ts:14` passes through to the UI; `scrubInternalPaths` is Long Form only; `dashboard/new/actions.ts:91,353` puts raw DB `error.message` in a redirect URL. No `console.log` of signed URLs/tokens found.
- RLS by table: `video_requests` select+insert; `generation_costs` select via join (0008:40-46); `yt_*` owner select; `delivery_assets`, `pi_*`, `fc_*`, `business_*` RLS on, no policy (service role only); `storage.objects` no policies after 0006.
- Tests: `access.test.ts` (`selectIfOwned` pure), `db-hardening.test.ts` (text of migration 0029), `verify/01_rls_and_idempotency_test.sql` (grants insert to `authenticated`, tests impersonation only), `generative-providers-no-secrets.test.ts` (regex over a fixed list of provider files), `review-stream.test.ts` (redaction of a string), `review-route.test.ts` (route core with fakes; on the production branch). None for column-level insert restriction or foreign `video_path` signing.

### RB-07 — Immutable pronunciation contract

- Request builder: `src/lib/ai/voice.ts:93-127 synthesizeVoice`; body `voice.ts:121-125` = `{ text, model_id: MODEL_ID, voice_settings }`. No `pronunciation_dictionary_locators`, no `previous_text`/`next_text`, no SSML/phoneme anywhere in `src` (grep: only `voice.ts:84/124` and a comment in `review-stream.ts`).
- Voice/model/settings: `voice.ts:19 DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "uYlzyj2kIZo3HfBB21vF"`, `:33 MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2"`, `:36-42 VOICE_SETTINGS` constant. Header `voice.ts:1-10` admits no approved-voice allowlist ("fallback silencioso"). Confirmed plan stores only `voice: "elevenlabs"` (`production-plan.ts:54,302`). `video_requests.voice_choice` (migration 0021) has no reader or writer in `src` (grep 0). `run-job.ts:63` selects no voice column for Reel/Long Form.
- display_text vs tts_text: captions come from TTS words: `generate-video.ts:428 buildCaptions(voice.words, …)`; Long Form `scene-captions.ts balancedGroups(words)`. Separation exists only in operator code: `scripts/lib/dulce-part1-core.ts:85` (test `dulce-part1-core.test.ts:50`), `scripts/video-004/v3.ts:32`.
- Alias lint: none. `scripts/video-004/plan.ts:32 ALIASES` holds `['Thermopylae','Ther-MOP-ih-lee']`-style aliases pushed unchecked to `/v1/pronunciation-dictionaries/add-from-rules` at `scripts/video-004/produce.ts:44` (same `video-003/produce.ts:45`, `dulce-part1.ts:150`). The V3 fix (`v3.ts:1-5`: lowercase respellings, dictionary excluded) and the gate (`pron-gate.ts`) are operator procedure.
- Cache key: `tts-cache.ts:41-51 TtsCacheIdentity = {videoId, beatId, text, voiceId, modelId, voiceSettingsJson, language, providerName}`; `computeTtsCacheKey :72`; `getVoiceIdentity` excludes `speed` on purpose (`voice.ts:52-65`). No dictionary id/version, no context. Reel has no TTS cache.
- Concurrent-job isolation: no dictionary on the product path, so no mutation; voice identity from process env means changing `ELEVENLABS_VOICE_ID` between attempts re-bills everything with another voice. Operator scripts pin `{id, versionId}` in `${P}/voice/setup.json` (`video-004/produce.ts:38-50`), untested.
- Account-side dictionary behaviour (shared dictionary in the ElevenLabs account): **UNVERIFIABLE** (outside repo), noted apart; the absence of a pin in the request builder is MISSING.
- Tests: `voice.test.ts` (4: identity omits speed, deterministic), `tts-cache.test.ts:80-418` (key changes on text/voice/model/settings; STARTED throws), `production-tts-cache.test.ts:87-220`. None for dictionary, alias lint, display/tts split, voice pin per job, SSML. `production-core/video-004.test.ts` has no pronunciation assertion.

### RB-08 — Visual class contract

- Classes: Shorts storyboard `storyboard/types.ts:18-24 ResourceTypeSchema` (LLM suggestions, only when `VISUAL_DIRECTOR_ENABLED`, `generate-video.ts:93-105`). Long Form `long-form/shots.ts:41-61 STRATEGY_CYCLES` chosen by `cycleShotType(i + typeOffset, strategy)` (`:229`); `:230` demotes text/diagram/map without a salient fact to `ken_burns_image`; product cycles exclude map and diagram; `shot-executor.ts:405-408` executes `map`/`diagram` as a text card. No `map_motion` capability. `shotClass` exists only in `production-core/shot-record.ts:74-87` (off path).
- Silent downgrade by design: `production-plan.ts:187 allocateShotTypes` → `:233` `{type:"generated_placeholder", motion:"ken_burns", plannedType:"ai_video", degradeReason}`, `:235/:245` `ken_burns_image, source:"stock"` on budget; `shot-executor.ts:11-13` header "video IA → imagen IA con movimiento; imagen IA → archivo real; archivo → tarjeta de texto"; `:427` no provider → placeholder; `:435-436` skipped → placeholder; `:382-396 stockOrText`. Deviations recorded (`produce.ts:386-390 budget.recordDeviation`), non-blocking and not shown to the customer (no "deviation" hits in `src/app`/`src/components`).
- Blocking checks: text-card ratio > 25% (`produce.ts:81,408-409`), `assertVisualQuality` (`visual-report.ts:260-267`, repeats/title cards, anchored_v1 only). Neither considers class or motion loss. Reel: image failure → stock (`generate-video.ts:270-283`); Remotion Ken Burns on every scene; quality gate warn-only (`:358-363`).
- `BLOCKED_NEEDS_CUSTOMER`: grep 0.
- Tests prove the downgrade is expected: `production-plan.test.ts:101,108`, `shot-executor.test.ts:112,168,237`, `visual-quality.test.ts:321`. No test asserts class preservation or a customer-blocking decision.

### RB-09 — Factual grounding / creative risk

- Entry: `src/app/dashboard/long-form/new/actions.ts:105 generateDocumentaryScript({researchPack:{topic, sources, openQuestions}})`; sources parsed from free text (`parse.ts:7-23`) into `{id, title, kind:"secondary", locator?, notes?}`; nothing fetched, hashed or verified; only hard check "≥ 1 source line" (`actions.ts:84-89`, `documentary-script.ts:160-163`).
- Claims: `documentary-script.ts:56-66 ClaimSchema {support: sourced|inference|unverified, sourceIds}` filled by the same LLM; honesty rule is prompt text (`:171-178`). Post-parse checks are duration, `assertOriginalHook`, `usesBannedOpener` (`:242-247`). No validation that `sourceIds` exist, that "sourced" matches text, or that "unverified" is absent. Sources are not persisted: `actions.ts:118-121` stores `script_json = {topic, beats}`.
- No judge / `FACTUAL_PASS` (grep 0). Shorts `script/route.ts:126 checkScriptQuality` (`script-quality.ts:4-21`) is structural only; `ai/script.ts` prompt has no sourcing rule.
- Deterministic vs heuristic: no deterministic grounding exists; heuristics are `script-quality.ts`, `originality.ts`, `duration-budget.ts`, lexical `stock-selection.ts` relevance reported as `uncertainScenes` (`visual-report.ts:200`, not blocking). `production-intelligence/qa-gate.ts` is off path and has no factual category.
- Tests: `documentary-script.test.ts` (2: no sources throws; no key throws), `script-quality.test.ts:18-85`, `generate-script.test.ts`, `script-loader.test.ts`. None for claim/source integrity.

### RB-10 — Final-frame license / attribution QA

- License metadata: Pexels `ai/footage.ts:26,120` keeps `photographer` only; `shot-executor.ts:87 PEXELS_LICENSE` constant, `:197-201` provenance `{kind, license, author}` into the durable record; AI image `:307` `ai_recreation`; music licences hard-coded in `providers/music/manifest.ts:25,77-358`, copied to reports (`produce.ts:567`, `generate-video.ts:498`). `long-form/types.ts:88-89` `license`/`attribution` are placeholders on the real path (`shots.ts:169-170,247-248`: `"resolved-at-execution"`, `""`). Citation on text cards: `real-graphics.ts:55` uses `shot.license` with a string heuristic (tested `real-graphics.test.ts`).
- On screen: `remotion/LongFormDoc.tsx:282-305 SceneLabels` draws `provenanceLabel` ("Recreación IA" only for `ai_recreation`, `long-form-card-fit.ts:55`), `creditText`, "Material pendiente". **`creditText` is never set on the product path** (only `sample-manifest.ts:43,56`, operator). No end credits composition. **AI-video scenes get no label:** `shot-executor.ts:439 persistMedia(... "ai_video" ...)` passes no provenance; `produce.ts:621,631` reads `executions[i]?.assetMeta?.provenance?.kind` → `undefined`. `ai_unlabeled` check exists only in `sample-manifest.ts:161` (operator; `quality-m3.test.ts:43`).
- Spec-level checks (before render, not on frames): `remotion/cover-rules.ts:270-323 validateCover` (safe area, `overlaps_captions` with `VIDEO_CAPTION_ZONE_TOP=780`, `overlaps_labels`, contrast); called from `render.ts:62-66,155`, `packaging.ts:92-96`; `produce.ts:470-477` catches `CoverValidationError` and drops the cover with `console.warn`. `render.ts:73-82 assertRenderInputValid`/`assertCardsFit`; `assertApprovalReady` only when `purpose === "approval"`, which nothing passes. Caption timing `quality-m2.test.ts:131,140`. Labels vs captions: no geometric check. `visual-qa.ts:50 checkAspectRatioSafety` 9:16 only and dead on the product path. Safe-area constants: `LongFormDoc.tsx:475 SAFE_BOTTOM_PADDING = 120`, `VerticalReel.tsx:184 = 280`, unverified after render.
- Composed-frame QA on the product path: none. After `renderMedia` (`render.ts:122`) produce runs `masterAudioLoudness` and `finalizeLongFormOutput` (ffprobe bytes/duration/codec). `long-form-qc.ts` (`assertVideoQc`, `detectAnomalousSilences`) is used only by `scripts/qc-video-001.ts`, `scripts/contact-sheet-video-001.ts`, `final-cut/adapters/media.ts`. The only product ffmpeg frame grab is `asset-identity.ts:106` (source asset at t=1 s, perceptual hash for dedupe).
- **3072×1728 vs 2304×1296 case (Thermopylae R4):** `grep 3072|2304|1728|1296 src remotion` = 0. The product renders Remotion at 1920×1080 (`output-policy.ts:20-35`) with no post-render geometry check, so a coordinate-space mismatch between an overlay and the composed frame would not be detected. The only detector is operator code `scripts/video-004/render.ts:279-311` (extracts composed frames from the final master, `safeArea`, `clearOfSubtitles`, `composedMatch meanDiff < 14`, `graphicsCount17`, `pictureFramesExact`) — no test file. SVG validation (sharp/`SVG_DENSITY`) does not count.
- Crop-aware verification: none for 16:9 output.
- Tests: `cover-rules.test.ts` (11, layout math on specs), `render-preflight.test.ts` (12, timing), `packaging.test.ts` (7), `quality-m2/m3`, `produce-pipeline.test.ts:362-372` (report provenance for v3 non-card scenes; no AI-video label assertion). None on rendered frames.

### RB-11 — Master storage contract

- Pre-generation: `estimateOutputBytes` (`output-policy.ts:86-103`) has no product caller (only `output-delivery.test.ts:54-58`, `scripts/recover-long-form-output.ts:270`, a comment at `render.ts:133`). `confirm-production.ts:88-95` checks USD only.
- Post-render Long Form (`output-finalize.ts:155-302`): probe → size-fit against `min(policyMaxBytes = 1 GiB, LONG_FORM_STORAGE_MAX_OBJECT_BYTES)` (`:241`) → 2-pass transcode (≤ 2 passes, floor `minFitVideoKbps = 1000`) → upload → on `size_rejected` refit to `demonstratedStorageMaxBytes = 50 MiB` (`:269-272`) → `LongFormOutputError` with customer-safe message and a kept local copy. Demonstrated limit documented at `output-policy.ts:1-17` (project-wide 50 MiB, bucket `file_size_limit` null; dashboard setting → UNVERIFIABLE from repo).
- Upload: `output-upload.ts` TUS resumable (`/storage/v1/upload/resumable`, 6 MB chunks, resume from HEAD offset, `maxAttempts` 4) then standard fallback; `classifyStorageError`.
- Hashes: sha256 only in `${requestId}/state/output.json` (`output-finalize.ts:288`, `.catch(() => undefined)`), not in DB; `reconcileExistingOutput :128-135` compares size, not hash. `delivery_assets` (0025, checksum column) has no product writer. `delivery/policy.ts` (`PRO_STORAGE_LIMIT_BYTES` 500 MB, `planMasterDelivery`) is imported by nothing but its test → two inconsistent policies.
- Reel: `generate-video.ts:561-585` single `upload` with `upsert: true`, no size policy, no hash, no proxy.
- Review proxy for the product: none. `review-stream.ts:16-47` is a static operator allowlist for Thermopylae proxies.
- Capacity reservation: none for storage (USD only via `production-budget.ts`); `production-intelligence/capacity` off path.
- Tests: `output-delivery.test.ts` (17 on `memoryOutputDeps`: fit math, exact production rejection, preflight before upload, 5xx safe error + kept file, `too_large`, reconciliation size mismatch, TUS resume, no retry on size reject; **no sha256 assertion**), `render-preflight.test.ts` (12), `packaging.test.ts` (7), `delivery/policy.test.ts` (3, unused module).

### RB-12 — Controls in code, not prompts

**A. Code-enforced on the customer path (Generate runs with no operator pasting instructions):** `assertCanGenerate` → 402 (`render/route.ts:7,150`; test is source-regex `render-route-cas.test.ts:177`); Long Form confirmation required (`render/route.ts:126-129` → 409; `run-job.ts:129-136 resolveExecutablePlan`; behavioural test `production-plan.test.ts:149`; source-regex `confirm-production-route.test.ts:22`); script-changed guard (`produce.ts:182 LongFormScriptChangedError`); durable budget (`produce.ts:200`; `production-budget.test.ts`, `shot-executor.test.ts:168`); uncertain-cost stop (`TtsUncertainCostStateError`); real-mode token (`long-form/mode.ts:28,66 LONG_FORM_REAL_RUN_CONFIRM === "YES_SPEND_REAL_MONEY"`, `render.yml:100`; `mode.test.ts:33-54`); CAS (`render/route.ts:168-176`, `run-job.ts:78-86`).

**B. Text-only or operator-only controls (MISSING as autonomous controls):**

| # | Control | Lives in | Enforcement on product path | P0? |
|---|---|---|---|---|
| 1 | Factual honesty (sourced/inference/unverified) | prompt `documentary-script.ts:171-178`, schema `.describe()` `:56-66` | none (RB-09) | yes |
| 2 | Visual fallback order / motion_graphic last resort | schema text `storyboard/types.ts:78-81` | none; consumer `visual-qa.ts` unwired | yes (RB-08) |
| 3 | Visual non-misinterpretation rules | prompt text `storyboard/types.ts:49-56,65` | only `storyboard/sanitize.ts` (not audited in depth) | — |
| 4 | Era/place coherence of visuals | prompt `documentary-script.ts:198-199` | lexical `stock-selection.ts`, reported not blocked | — |
| 5 | Approved-voice allowlist | TODO comment `voice.ts:1-10` | none; silent env fallback | yes (RB-07) |
| 6 | Pronunciation approval | human listening `scripts/video-004/pron-gate.ts`, `content/productions/video-004-thermopylae/v3/pronunciation-manifest.json`, `v3.ts:45` | none | yes (RB-07) |
| 7 | Shorts quality gate | `generate-video.ts:358-363` | warn only | yes (RB-08/10) |
| 8 | Operator spend authorisation | `production-request.json "confirm": "SPEND"`, `video-004-production.yml:37-41`, `video-003-production.yml:40` | YAML check on an operator commit; off path | n/a |
| 9 | Pronunciation-gate cost cap | `pron-gate.ts:12 MAX_USD = 0.09`, reason string `:33` | hard-coded per run; off path | n/a |
| 10 | Video 001 dispatch token | `produce-video-001.yml:92` | operator-typed; off path | n/a |

`AGENTS.md`/`CLAUDE.md` carry only the Next.js agent notice; `docs/CONTINUITY.md` is narrative. **Can Generate operate without an operator pasting instructions?** Yes for the paid gates in A; the content guarantees in B do not exist without a human.

### RB-13 — AI motion autonomy contract

- Opt-in: global `LONG_FORM_AI_VIDEO_ENABLED` (`feature-flags.ts:94`; `ai-video-cost-guard.ts:132` refuses when false), `PREMIUM_CLIPS_ENABLED` (`:41`, `providers/video-gen/index.ts`); per request `strategy === "cinematic"` (`production-plan.ts:139`), plan pinned by CAS (`confirm-production.ts:101-103`); render requires `long_form_confirmed_at`. Which shots animate: lexical heuristic `ai-video-eligibility.ts:27-60`.
- Cost reservation: write-ahead `budget.reserveAiVideoSubmit(units.veoClipUsd)` (`produce.ts:309`, `ai-video-durable-provider.ts:189,250`) persisted before submit (`production-budget.ts:106`, no CAS); in-memory `assertAiVideoBudget` (`ai-video-resolver.ts:113-128`). Tests: `production-budget.test.ts` (4), `ai-video-durable-failure-injection.test.ts:220,235`, `ai-video-cost-guard.test.ts` (11).
- Artifact QA: `ai-video-validation.ts` — MIME allowlist, 32 B–500 MB, `ftyp`/EBML magic, fixture signature, **declared** duration 0.5–60 s and declared w/h. No ffprobe, no resolution conformance, no deformation/anatomy/temporal check. `ai-video-evaluation.ts` subjective fields are benchmark-only. Test `ai-video-validation.test.ts` (11, bytes).
- Retry policy: Veo `DEFAULT_MAX_POLL_ATTEMPTS=30`, `DEFAULT_POLL_TIMEOUT_MS=240000` (`veo.ts:82-83`); Runway `POLL_TIMEOUT_MS=180_000`, `maxRetries: 0` (`runway.ts:14,113`); `maxInAttemptResumes: 2` on the same job id (`produce.ts:310`, `ai-video-durable-provider.ts:244-292`); `MAX_RENDER_ATTEMPTS=3`. Tests: `runway.test.ts`, `veo.test.ts`, failure-injection A–F.
- Fallback: cross-class. Skipped/rejected/invalid/no-provider → reference AI still as `generated_placeholder` (`shot-executor.ts:422,435-436`), else stock/text (`:421`); deviation written to budget JSON (`produce.ts:389`), not surfaced to the customer. Test `shot-executor.test.ts:237` asserts the downgrade.
- Provider rejection: typed `GenerativeProviderError` → skipped; moderation → FAILED record never resubmitted; Kling always `contract_unverified`; `requireReal` + fixture throws.
- `UNVERIFIED_GENERATIVE` / risk state: none on the product path (similar names only in `production-intelligence/state-machine.ts:6` `MOTION_QA`, `final-cut` `HUMAN_REVIEW_REQUIRED`, `tts-cache.ts:53` `NEEDS_REVIEW`).
- Human-review boundary: before spend yes (confirm); before customer delivery no (`run-job.ts:181` sets `status:"completed", video_path`); before YouTube only via operator distribution (`0028:38,50`).
- Keeping AI motion is a product decision and does not change the status: a heuristic eligibility + byte-sniff QA + silent cross-class fallback cannot be IMPLEMENTED for autonomous publication.

---

## 5. Risk if left as is

| ID | Risk |
|---|---|
| RB-01 | Double billing on timeouts and stale-attempt restarts (Reel: every retry re-pays voice ×2, images, music); unrecorded Veo submissions; no way to reconcile provider invoices to jobs. |
| RB-02 | Unbounded spend per user and per platform under concurrency; provider balance exhaustion mid-job discovered only as a provider error; quota forgeable (RB-06). |
| RB-03 | Paid assets lost on DB/storage failure and re-bought; orphaned objects accumulate; delivered master can be overwritten by a stale attempt. |
| RB-04 | Zombie worker keeps spending after a new attempt starts; `final.mp4` replaced by an old attempt; budget lost-update; live job's script swapped by a late POST. |
| RB-05 | Low today (no publish code). The review gate for customer jobs exists only as documentation; a future publish feature would attach to `completed`. |
| RB-06 | Cross-tenant read of private videos via forged `video_path` (owner review masters reachable); quota/attempt/Long Form budget bypass with real spend; avatar-likeness misuse; provider error text and signed URLs reach Sentry/UI unredacted. |
| RB-07 | Mispronounced names ship undetected; voice drifts between attempts and re-bills; any future dictionary edit silently reuses stale cached audio; alias spellings would leak into captions. |
| RB-08 | A customer pays for "cinematic" and receives stills/text cards; the only trace is an internal deviation log. |
| RB-09 | Fabricated or mis-attributed facts in paid documentaries with no audit trail (sources discarded at generation). |
| RB-10 | Unlabelled AI footage, missing credits, overlays outside safe area or over subtitles, and geometry mismatches (the 3072/2304 class) all ship undetected; license obligations unverifiable per frame. |
| RB-11 | Paid generation completes and the master cannot be stored (size) or is stored without a verifiable hash; Reel has no size envelope at all; no customer proxy. |
| RB-12 | Content guarantees silently depend on prompts and an operator; a prompt regression is invisible to tests. |
| RB-13 | Deformed or off-brief AI motion delivered as `completed` with no risk flag; motion silently replaced by stills on any provider hiccup. |

---

## 6. Minimum fix required (invariant + call site; no architecture)

- **RB-01.** Invariant: no paid HTTP request leaves the process without a durable record keyed by an idempotency key that is also sent to the provider when the provider supports one, and a record left in a non-final state is never resubmitted and is reconciled by a sweeper. Call sites: `src/lib/ai/voice.ts:113` (Reel and Long Form TTS), `src/lib/providers/image/openai.ts:134` (+ restrict the retry loop `:255-276` to pre-response failures), `src/lib/providers/music/beatoven.ts:83`, `src/lib/providers/video-gen/veo.ts:227` (record before POST), and the Storage read fallbacks `ai-video-storage.ts:73-74`, `durable-shot-assets.ts:80-81`, `production-tts-cache.ts:59-60` (a read error must fail closed, not mean "absent"). The sweeper call site does not exist; say so: there is no scheduled job or reconciliation entry point in the repo.
- **RB-02.** Invariant: admission of a paid job is a single atomic operation that counts open holds plus committed spend for the user and the platform and refuses when the sum exceeds the cap; UNKNOWN provider balance refuses. Call site: `src/lib/billing/quota.ts:121-137` (replace count with an atomic increment under a DB lock or RPC), and `src/app/api/generate/[id]/render/route.ts:150-176` (admission and CAS in one transaction). Provider balance call site: none on Generate; say so.
- **RB-03.** Invariant: a paid object is stored under a path derived from its content hash before the spend is marked committed, and a retry reuses it with zero calls; the delivered master is never overwritten by a lower attempt. Call sites: `generate-video.ts:299,367,406,471 uploadToStorage` (Reel), `output-finalize.ts:33,87,103` (attempt-scoped or hash-scoped path), `reconcileExistingOutput :128-135` (compare hash). GC entry point: none; say so.
- **RB-04.** Invariant: every side effect of a job (DB, Storage, budget) is fenced by the attempt token, a lease has an expiry the worker must renew, and a job runs the `pipeline_version` it was admitted with. Call sites: `attempt-state.ts:6-18` (lease columns), `render/route.ts:166` (write version), `output-finalize.ts:33`, `production-budget.ts:135`, `script/route.ts:157-161,240`, `regenerate-scene/route.ts:115-119` (add `.eq("status", ...)`).
- **RB-05.** Invariant: `completed` is not deliverable to distribution; a distinct review state and an explicit publish request exist and no code path can reach a YouTube write endpoint without them. Call sites: `0004_script_review.sql:16` enum (new migration), `run-job.ts:181` (write the review state instead of `completed`), plus a static test banning `youtube/v3/videos` POST.
- **RB-06.** Invariant: a client can never set `status`, `video_path`, `render_attempts`, `created_at`, `long_form_confirmed_at`, `long_form_production_plan` on insert; a signed URL is only issued for a path under `${request.id}/`; no signed URL or provider error text reaches logs/UI unredacted. Call sites: `0001_init.sql:27-29` (new migration: column grants or BEFORE INSERT trigger), `src/lib/storage/signed-url.ts:13-23` callers `videos/[id]/page.tsx:68`, `dashboard/page.tsx:55`, `src/app/r/[slug]/route.ts:26` (use `isReviewOwner`), `sentry.server.config.ts` (`beforeSend` → `redactSignedUrl`), `run-job.ts:205-208`.
- **RB-07.** Invariant: the TTS request carries the dictionary `{id, version}`, voice id, model and settings pinned in the confirmed plan, the cache key includes them, captions are built from display text, and an alias with an internal hyphen or uppercase is rejected at plan confirmation. Call sites: `voice.ts:93-127` (request body), `production-plan.ts:54,302` (persist), `tts-cache.ts:41-51` (identity), `generate-video.ts:428` and `long-form/scene-captions.ts` (captions), `confirm-production.ts` (lint).
- **RB-08.** Invariant: every shot has a mandatory class assigned from content, the solver only substitutes within the class, and a class that cannot be served results in BLOCKED_NEEDS_CUSTOMER rather than a lower class. Call sites: `long-form/shots.ts:229-231`, `production-plan.ts:198-247`, `shot-executor.ts:405-445`, `produce.ts:386-410`, `generate-video.ts:270-358`.
- **RB-09.** Invariant: every `sourced` claim references a persisted source with a content hash and span, unresolved `sourceIds` or `unverified` claims block paid execution. Call sites: `documentary-script.ts` after `:240`, `long-form/new/actions.ts:118` (persist sources), `confirm-production.ts` (gate), `script/route.ts:126` (Shorts).
- **RB-10.** Invariant: after render, frames are extracted from the final master at each overlay/credit/CTA slot and checked for safe area, subtitle overlap, presence of the required provenance label and credit, and composed geometry; failure blocks `completed`. Call sites: `long-form/produce.ts` after `render.ts:122` (`renderMedia`) and before `finalizeLongFormOutput`; `shot-executor.ts:439` (attach provenance to AI clips); `remotion/LongFormDoc.tsx:298` (`creditText` source); Reel `generate-video.ts:468` before upload.
- **RB-11.** Invariant: predicted master size is checked against the storage ceiling before any paid call, the delivered hash is stored in the DB and verified on reconcile, and Reel follows the same policy. Call sites: `confirm-production.ts:88-95` (`estimateOutputBytes`), `output-finalize.ts:288` and `reconcileExistingOutput :131-133`, `run-job.ts:180-183` (persist hash), `generate-video.ts:471`.
- **RB-12.** Invariant: rows 1–7 of the inventory are checks that fail the job in code. Call sites: `confirm-production.ts` (plan time), `produce.ts:386-410` and `generate-video.ts:358` (pre-render).
- **RB-13.** Invariant: an AI clip is delivered only after a measured artifact QA (ffprobe conformance at minimum), a failed clip falls back within its class or blocks, and a job containing unreviewed generative motion carries an explicit state until a human or a verified check clears it. Call sites: `ai-video-validation.ts` (measure, not declared), `shot-executor.ts:435-436,422` (fallback), `run-job.ts:181` (state before `completed`).

---

## 7. Missing tests

| ID | Test that would prove the invariant (none exists today) |
|---|---|
| RB-01 | Reel: a `synthesize`/image call that times out after the provider charged is not re-issued on the next attempt. Long Form: a Storage read error on a STARTED record fails closed. Veo: process death between POST and record write leaves a reconcilable record. |
| RB-02 | Two concurrent `assertCanGenerate` for the same user at `limit - 1` admit exactly one (real Postgres, `verify/*.sql` style). Ten concurrent renders never exceed the platform cap. UNKNOWN balance refuses. |
| RB-03 | Provider charged + DB write fails → the next attempt finds and reuses the object with zero calls (Reel). Lower attempt cannot overwrite `final.mp4`. |
| RB-04 | Two workers (attempt N and N+1) through `runRenderJob` against real Postgres and Storage: only N+1's output, budget and status survive. Late `script` POST on a `processing` row changes nothing. |
| RB-05 | Static: no file calls a YouTube write endpoint. Behavioural: a `completed` request cannot be passed to `prepareUpload`. |
| RB-06 | `verify/*.sql` as `authenticated`: insert with `status='completed'`, `video_path='x'`, past `created_at`, `render_attempts=-5` is rejected or normalised. Route test: a `video_path` outside `${id}/` is never signed. Sentry `beforeSend` redacts a signed URL. |
| RB-07 | Request body contains dictionary locator and pinned voice/model/settings from the plan; cache key changes with dictionary version; captions never contain an alias; `Ther-MOP-ih-lee` and `THERMOPYLAE` aliases are rejected (fixtures Thermopylae, Ephialtes, Thespiae, Locrians). |
| RB-08 | An `action`/`map_motion` beat with no provider or no budget yields BLOCKED_NEEDS_CUSTOMER, never `ken_burns_image`. |
| RB-09 | A `sourced` claim whose `sourceIds` do not exist in the persisted pack blocks confirmation; an `unverified` claim blocks. |
| RB-10 | Frame extracted from a rendered master with an overlay at 3072-space coordinates on a 2304-space frame fails `composedMatch`; AI-video scene without "Recreación IA" fails; credit missing fails; overlay in subtitle band fails. |
| RB-11 | Predicted size over ceiling refuses confirmation before any paid call; sha256 of the delivered file is persisted and a mismatch on reconcile refuses adoption. |
| RB-12 | Each row 1–7 has a failing-input test that makes the job fail without any prompt involvement. |
| RB-13 | A clip with declared 1080p but measured 480p is rejected; a rejected clip in a motion class blocks or substitutes within class; a job with generative motion is not `completed` until the risk state is cleared. |

---

## 8. Thermopylae regression reality check

| # | Regression (REALITY-CHECK-V2 R1–R9 + delivery) | Status | Evidence |
|---|---|---|---|
| 1 | Alias with internal hyphen/caps (`Ther-MOP-ih-lee`) accepted by the dictionary builder | **TEST_MISSING** | Aliases pushed unchecked at `scripts/video-004/produce.ts:44`; `plan.ts:32`; no lint, no test. `dulce-part1-core.test.ts:50` only proves subtitles do not use aliases. |
| 2 | Internal pause / abnormal word duration inside a patched word | **TEST_MISSING** | Runtime check only in `scripts/video-004/v3.ts` (`fitPatch`, 150 ms rule); no test file for `v3.ts`. |
| 3 | 3072×1728 render composited over a 2304×1296 crop | **TEST_MISSING** | Only detector is `scripts/video-004/render.ts:279-311` composed-frame QA at runtime; no test; product path has no equivalent. |
| 4 | Safe-area violation (96/54) | **TEST_PARTIAL** | `remotion/cover-rules.test.ts:34,53` test the cover spec's safe area (specs, not frames, cover only). Graphics safe area is runtime-only in `render.ts:301`. |
| 5 | Subtitle / citation overlap | **TEST_PARTIAL** | `cover-rules.test.ts` `overlaps_captions`/`overlaps_labels` (cover spec); `quality-m2.test.ts:131,140` caption timing across cuts; no pixel-level or label-vs-caption test. |
| 6 | Graphics manifest count mismatch (17) | **TEST_PARTIAL** | `long-form-qc.test.ts:158,170` prove `evaluateProductionReportForRealRun` detects a wrong shot count vs storyboard (module not on product path); `graphicsCount17` is runtime-only in `render.ts:310`. |
| 7 | CTA insertion causing subtitle drift | **TEST_MISSING** | No test references CTA timing (`grep CTA` in tests: 0 relevant). Runtime check `ctaAfterEndCardsBeforeEndCard` in `render.ts:311` only. |
| 8 | Wrong CTA language | **TEST_MISSING** | No test; CTA text is in `scripts/video-004/v3-cta.ts` with no language assertion. |
| 9 | Gate of 3 samples (G1–G3) unlocking all patches | **TEST_MISSING** | Rule exists only in `docs/production-intelligence/REALITY-CHECK-V2.md` (R6) and the operator's authorisation; no code or test. |
| 10 | HLS / GitHub artifact / runner HTTP 200 treated as customer delivery | **TEST_PARTIAL** | `review-stream.test.ts` `LONG_SIGNED_URL_RUNNER_PASS_IS_NOT_SUFFICIENT_FOR_DELIVERY_PASS` proves `classifyReviewDelivery` returns RUNNER_PASS without device confirmation; the classifier has no caller on any delivery path, so nothing enforces it. `delivery/policy.test.ts:16` (records store paths) tests an unused module. |

Totals: TEST_EXISTS 0 · TEST_PARTIAL 4 · TEST_MISSING 6.

---

## 9. State machine inventory

**Real states today (product path):**

| Where | Values | Source |
|---|---|---|
| `video_requests.status` | pending, script_ready, processing, completed, failed | `0004_script_review.sql:16`; `request-view.ts:57-71` |
| `progress_stage` (Reel/Avatar, no CHECK) | queued, voice, footage, music, render, uploading | `0005:7`; `src/lib/video/stages.ts:6`; `generate-video.ts onProgress` |
| `long_form_stage` | scripting, storyboard, assets, ai_video, rendering | `0016:62` = `long-form/stages.ts:9` (`stages.test.ts` asserts the match) |
| Long Form progress key | queued · stage · uploading; heartbeat `long_form_progress.updatedAt` | `progress.ts:23,39`; `render-guard.ts isRenderStale` |
| Attempt fencing (not an enum) | id + user_id + status='processing' + render_attempts; claim progress_stage null/queued → voice | `attempt-state.ts:7-18` |
| AI video clip record (Storage JSON) | STARTED, COMPLETED, FAILED | `ai-video-storage.ts:43` |
| Durable shot asset | STARTED, COMPLETED, FAILED_NO_CHARGE | `durable-shot-assets.ts:52` |
| TTS cache | STARTED, COMPLETED, NEEDS_REVIEW | `tts-cache.ts:53` |
| Production TTS cache | STARTED, COMPLETED | `production-tts-cache.ts:28` |
| Output delivery | UPLOADED, FAILED (Storage JSON) | `output-finalize.ts:39` |
| Plan version | 1, 2, 3 | `production-plan-types.ts:20` |
| Avatars | draft, uploaded, processing, ready, failed, deleted; `avatar_render_status` draft, queued, processing, completed, failed, cancelled | `0013:40,46` |
| Avatar claim | `avatar_generation_started_at` null → set (single attempt) | `0014`; `pipeline.ts:245-260` |

**Real states today (off the product path):** `pi_paid_operations` RESERVED, SUBMITTED, PROVIDER_JOB_RECORDED, COMMITTED, REFUNDED, RECONCILIATION_REQUIRED (`0023:24`); PI asset states PLANNED … MOTION_AUTHORIZED, MOTION_PENDING, MOTION_QA, MOTION_FAILED, LOCKED, RENDERED, DELIVERED, CANCELLED (`production-intelligence/state-machine.ts:6-10`); PI capacity GREEN/YELLOW/RED/UNKNOWN; Final Cut editorial 8 states incl. HUMAN_REVIEW_REQUIRED (`final-cut/gate.ts:10`, `0027:76`); `fc_repairs` PROPOSED/GATED_OK/GATED_BLOCKED/AUTHORIZED/EXECUTED/REJECTED (`0027:58`); YouTube launch PREPARED/PUBLISHED_MANUALLY (`0028:50`), approvals proposed/approved/rejected (`0024:62`), snapshots NOT_DUE/PENDING/COLLECTED/PARTIAL/UNAVAILABLE; `user_voices`/`tts_jobs` (0021/0022, podcast feature); benchmark reference image not_generated/pending_review/approved.

**Comparison with the red team's list (no state is added by this audit):**

| Red team state | Exists on product path? | Nearest real thing |
|---|---|---|
| HELD | No | `ProductionBudget.reserveAiVideoSubmit` writes a reservation into JSON, not a job state |
| DISPATCHED | No | STARTED record (Long Form); `pi` SUBMITTED off path |
| PROVIDER_SETTLED_UNSTORED | No | `pi` PROVIDER_JOB_RECORDED off path; nothing on Generate |
| STORED | Partial | COMPLETED record (Long Form); Reel has none |
| COMMITTED | No | `pi` COMMITTED off path; `generation_costs` after-the-fact row |
| NEEDS_RECONCILE | No | `pi` RECONCILIATION_REQUIRED off path; `TtsUncertainCostStateError` is an exception, not a state |
| SUBTITLE_STALE | No | — |
| PICTURE_LOCK | No | `pi` LOCKED off path |
| QA_INCOMPLETE | No | — (Reel quality gate warns) |
| BLOCKED_NEEDS_CUSTOMER | No | grep 0 |
| CANCELLED | No (customer jobs) | `avatar_render_status` cancelled; `pi` CANCELLED off path; no cancel route for `video_requests` (only Stripe webhook mentions cancel) |
| PIPELINE_PINNED | No | plan `version` 1–3 and `scriptHash` (Long Form only); no code version |
| READY_FOR_REVIEW | No | `completed` doubles as delivered |
| PUBLISH_REQUESTED | No | — |
| PUBLISHED | No | `yt_launch` PUBLISHED_MANUALLY (operator) |

---

## 10. Concurrency reality check (static analysis only, no simulation)

| Dimension | What the code does | Limit |
|---|---|---|
| Job admission | `evaluateRenderStart` → `assertCanGenerate` (read-then-act count) → CAS on the row → `repository_dispatch` | per request: 1 active attempt (CAS + GH group). Per user, per tenant, global: **sin límite en código** |
| Worker | One `ubuntu-latest` job per request (`render.yml:34`), `concurrency.group` per request, `cancel-in-progress: false`; inline worker never used on Vercel (`worker/index.ts:31`) | GitHub account runner concurrency: outside repo (UNVERIFIABLE); in code: sin límite |
| Provider concurrency | No semaphore, no rate limiter; 429 only classified (`veo.ts:149`), Runway `maxRetries: 0`; `production-core/policy-engine.ts:50 maxConcurrent` is read by nothing | sin límite en código |
| DB locking | CAS on `video_requests` only; no `FOR UPDATE`, no RPC, no advisory lock on Generate (the only `pg_advisory_xact_lock` is the 0021 `tts_jobs`/`user_voices` trigger, podcast feature) | quota TOCTOU |
| Durable budget | Storage JSON upsert, last-writer-wins (`production-budget.ts:13-15,135-138`), relies on the GH group | no CAS |
| Inside one job | Long Form shots sequential; registry seeding batched by 10 `Promise.all` reads (`produce.ts:321-329`); Reel sequential | n/a |
| Render queue | none beyond GitHub Actions | sin límite en código |
| Storage pressure | reactive size-fit on rejection only; no quota, no capacity check | sin límite en código |
| Per-request attempts | `MAX_RENDER_ATTEMPTS = 3` (`limits.ts:7`) | 3 |

**Scenarios (static):**
- **2 jobs, same request:** second POST gets 409 from the CAS; if the first is "stale" (15/25 min) the second is admitted while the first may still be in a provider call → double spend until the first's next fenced write (RB-01/04).
- **2 jobs, same user, different requests:** both pass the monthly count; both run; quota exceeded by one if at `limit - 1`.
- **10 jobs:** 10 runners, 10 independent provider streams, 10 budget JSONs; no shared counter; provider 429s surface as per-job failures (Runway no retry → skipped → still; Veo bounded poll). Monthly quota can be overshot by up to 10.
- **50 jobs:** same, bounded only by the GitHub plan's concurrent-job limit (UNVERIFIABLE); ElevenLabs/OpenAI account concurrency (UNVERIFIABLE) will throttle; TTS has no retry, so Reel jobs fail after paying nothing or after paying for the first call; Long Form STARTED records then throw `TtsUncertainCostStateError` on retry (jobs stuck without a sweeper).
- **100 jobs:** as 50; storage: 100 × up to 50 MiB masters plus attempt-scoped assets with no GC; Supabase project limits (UNVERIFIABLE).

---

## 11. Test suite inventory

**Counts (HEAD `692e9ec`):**

| Metric | Value |
|---|---|
| Test files on disk (`*.test.ts`/`*.test.tsx` under `src`, `scripts`, `remotion`) | 174 |
| Files listed in `package.json` `test:unit` | 172 (all exist) |
| On disk but not in `test:unit` | `scripts/lib/dulce-edit.test.ts`, `scripts/lib/dulce-part1-core.test.ts` |
| `test(`/`it(` calls | ≈1,386 |
| SQL verification scripts (`supabase/migrations/verify/*.sql`, manual against local Postgres per its README) | 8 (+ schema stub) |
| Source-text (regex over source) test files | 13 (`render-route-cas`, `confirm-production-route`, `visual-director-integration`, `run-job-diagnostics`, `script-route-recovery`, `long-form-independence`, `inline`, `db-hardening`, `pwa`, `*-structural`, `*.source`, `packaging` partly) |
| Conditional skips | `audio-master.test.ts:50,100` and `visual-quality.test.ts:347` (ffmpeg absent) |
| `.only` / `todo` / known flaky | none found |
| **CI execution of the suite** | **none** (no workflow runs `test:unit`) |

**By area (files):** `src/lib/video` 102 (of which `long-form` ≈ 70) · `src/lib/providers` 19 · `src/app` 8 · `src/lib/billing` 6 · `src/lib/production-core` 4 · `src/lib/distribution` 4 · `scripts` 4 · `src/lib/worker` 3 · `src/lib/auth` 3 · `src/lib/production-intelligence` 2 · `src/lib/http` 2 · `src/lib/delivery` 2 · `src/lib/ai` 2 · `remotion` 5 · one each: `proxy`, `security`, `onboarding`, `final-cut`, `env-errors`, `command-center`, `business-telemetry`, `blind-experiment`, `components`.

**Invariants vs happy paths (qualitative):**
- Real invariant tests exist for: Long Form durable idempotency (`ai-video-durable-*`, `tts-cache`, `production-tts-cache`), budget write-ahead (`production-budget`), cost guards, attempt CAS on a fake PostgREST (`attempt-state`), confirm double-click, provider no-retry rules (`runway`, `veo`, `openai`), output size-fit (`output-delivery`), visual dedupe (`visual-quality`), AUTO_PUBLISH false, auth recovery refusals, PI/production-core ledgers (off path).
- Happy-path or structural: all `*-structural`/`*.source` tests, route CAS/confirm route regex tests, `delivery/policy` (unused module), `visual-qa` (dead module), benchmark families (`ai-video-benchmark-*`, `visual-test-v2-*`), `video-003`/`video-004` plan conformance.
- Absent entirely: any Reel paid-call test; any real-DB concurrency test on quota; any rendered-frame test; any pronunciation contract test; any factual grounding test; any cross-tenant insert test.

---

## 12. Dependency map between blockers

- **RB-06 → RB-02, RB-04, RB-05:** while a client can forge `status`, `created_at`, `render_attempts` and the plan JSON, no quota, lease or review state is trustworthy. Fix the insert surface first.
- **RB-01 → RB-02, RB-03:** a durable provider-call record with a key is the unit that budget holds (RB-02) reserve against and that storage sagas (RB-03) commit; without it RB-02 can only count rows and RB-03 cannot know what was paid.
- **RB-04 → RB-01, RB-03, RB-11:** fencing of Storage/budget writes and a real lease are what make "exactly one owner" true for provider calls, paid objects and the delivered master.
- **RB-07 → RB-10:** display/tts split is what lets a frame-level subtitle check assert "no alias on screen".
- **RB-08 → RB-13:** a mandatory class is the precondition for "same-class fallback" and for BLOCKED_NEEDS_CUSTOMER.
- **RB-10 ↔ RB-11:** composed-frame QA runs on the rendered master before upload; the storage contract decides what the master is (hash, size) and feeds the proxy.
- **RB-12** is the inventory that RB-07/08/09/10 close; **RB-09** is independent of the money path and can proceed in parallel.
- **RB-05** depends on a new state (RB-04/06 for integrity) and is otherwise cheap.

---

## 13. Recommended order P0 → P1

**P0 (money and tenant safety; each alone keeps NOT_READY):**
1. RB-06 insert surface + signed-path check + `isReviewOwner` wiring + redaction (`beforeSend`).
2. RB-01 provider-call record and key on `voice.ts:113`, `openai.ts:134`, `beatoven.ts:83`, `veo.ts:227`; read errors fail closed; restrict the OpenAI retry loop.
3. RB-04 fencing of Storage/budget/script-route writes + lease expiry + `pipeline_version`.
4. RB-02 atomic admission in `quota.ts`/`render/route.ts`.
5. RB-03 hash-scoped paths and hash reconciliation; attempt-scoped master.

**P1 (content contracts and delivery):**
6. RB-08 mandatory class + BLOCKED_NEEDS_CUSTOMER (unblocks RB-13).
7. RB-10 composed-frame QA before `completed` (including the 3072/2304 class) and AI-clip provenance.
8. RB-07 pinned voice contract, dictionary locator, display/tts split, alias lint.
9. RB-13 measured artifact QA, within-class fallback, risk state before `completed`.
10. RB-09 persisted sources and claim validation.
11. RB-11 pre-generation size check, hash in DB, Reel policy.
12. RB-05 review state + static publish ban.
13. RB-12 inventory closure (follows from 6–10).

**P0 prerequisite for all of the above:** run `test:unit` in CI; without it no status can ever reach IMPLEMENTED.

---

## 14. What NOT to build yet

- Not the red team's full state machine (HELD → … → PUBLISHED) as a new table or orchestrator: the repo already has a correct ledger model in migration 0023; the gap is that Generate does not pass through any record at all. Add records at the call sites first.
- Not a parallel "PI V2 engine"; PI V1/V1.1 stays frozen and off path. No new module tree.
- Not a generic job queue / scheduler / sweeper service before the per-call record exists (there would be nothing to sweep).
- Not YouTube publishing, scheduling or public buckets (RB-05 is PARTIAL precisely because none exist).
- Not a factual LLM judge (RB-09) before sources are persisted with hashes; a judge over discarded sources proves nothing.
- Not AI-motion deformation detection (RB-13) before basic measured conformance (ffprobe) and within-class fallback exist.
- Not a content-addressed storage migration for all buckets; attempt-/hash-scoped paths at the three product write sites are enough for RB-03.
- No fixtures or tests created in this phase (mandate).

---

## 15. Complexity (S / M / L / XL, no hours)

| ID | Size | Why |
|---|---|---|
| RB-01 | L | 4 call sites across two branches, read-fallback semantics, a sweeper entry point that does not exist |
| RB-02 | L | atomic admission needs a DB function or lock and a platform counter; plan re-check at run time |
| RB-03 | M | 3 write sites + hash compare; GC can wait |
| RB-04 | M | lease/version columns, 6 call sites, one race test on real Postgres |
| RB-05 | S | one enum migration, one status write, one static test |
| RB-06 | M | one migration (grants/trigger), 3 callers, Sentry hook, route wiring |
| RB-07 | M | request body, plan persistence, cache identity, two caption builders, one lint |
| RB-08 | L | changes the allocation solver and executor semantics; customer-facing blocked state |
| RB-09 | L | persistence of sources, validation, gate on two product paths |
| RB-10 | M | ffmpeg extraction + checks at one call site; provenance on AI clips; credit source |
| RB-11 | M | pre-generation estimate call, hash in DB, Reel policy |
| RB-12 | M | inventory rows 1–7 become checks at two gates |
| RB-13 | L | measured QA, within-class fallback (depends on RB-08), new pre-`completed` state |

---

## 16. Current RELEASE READINESS

**NOT_READY.**

Six blockers are MISSING on the product path (RB-03, RB-07, RB-08, RB-09, RB-10, RB-13); seven are PARTIAL (RB-01, RB-02, RB-04, RB-05, RB-06, RB-11, RB-12); none is IMPLEMENTED. The test suite is not executed by CI. Both questions from the mandate are now answered no for the covered paths, mock-tested and not CI-enforced: a timeout cannot produce two charges at the gated call sites (section 17), and ten jobs cannot read the same voice balance and all start (section 18). No caveats apply to this verdict.

Items outside the repo and therefore UNVERIFIABLE (noted apart, not counted as PASS): Supabase project upload size limit and bucket `public` flags in production, the `music-library` bucket's existence and ACL, GitHub runner concurrency limits, ElevenLabs account dictionary and concurrency behaviour, provider balances, and the production Vercel branch's `/r/[slug]` route (this audit covers HEAD `692e9ec`).

---

## 17. Fase B1 — RB-01 double-charge guard (2026-10-02, after `48ce847`)

**Scope executed:** RB-01 plus the re-pay part of RB-03, on the call sites named in section 4 only. No migration, no new ledger, no provider called (mocks only), VIDEO-004 untouched, PI V1 engine tree unchanged (`src/lib/production-intelligence` tree `6253c14…`).

**Mechanism.** `src/lib/paid-calls/gate.ts` `guardPaidCall()` is a policy wrapper over the frozen engine `executePaidOperation()` and the existing `pi_paid_operations` table (0023), through `src/lib/paid-calls/supabase-ledger-store.ts` (service role; a store error fails closed: no row, no call). Key = `idempotencyKey({projectId: requestId, shotId, provider, model, method, inputFingerprint, attemptOrdinal})`; `render_attempts` is never part of it. Transitions used, all forward-only under the 0023 trigger: RESERVED → SUBMITTED before the HTTP; SUBMITTED → COMMITTED (result_ref) on success; SUBMITTED → RECONCILIATION_REQUIRED on timeout/cut ("uncertain"); SUBMITTED → PROVIDER_JOB_RECORDED when the failure carries a provider job id (resume only, never resubmit; `commitRecordedPaidJob` closes it after a resume); SUBMITTED → REFUNDED (`committed_usd 0`, `result_ref rejected:…`) on a pre-acceptance refusal, with at most one retry on the ordinal-1 key. COMMITTED → the stored result is loaded; unloadable → `PaidResultUnavailableError`, no call. The 0023 schema represents every required state; no migration was needed.

**Call sites now gated (product path):**

| Call site | Gate | Reuse on a later attempt |
|---|---|---|
| Reel voice ×2 (`generate-video.ts`, incl. speed correction) | `gatedVoiceSynthesize` | audio + words stored under `${requestId}/paid/<key>.{mp3,json}`, sha256-checked |
| Reel music (`generate-video.ts`) | `gatedMusicTrack` — only `beatoven` is paid; curated library/fixture pass through | stored as above |
| Reel image (`visual-resource-resolver.ts`) | `guardPaidCall`, `maxRejectedRetries: 0` (openai.ts already retries once) | existing `findExistingGeneratedImage` path; COMMITTED without object → refused |
| Long Form TTS (`production-tts-cache.ts`) | `guardPaidCall` around `synthesizeBeatNarration` | existing COMPLETED cache; COMMITTED + invalid cache → refused (test 6 re-specified) |
| Long Form AI image (`shot-executor.ts resolveAiImage`) | `guardPaidCall`, `maxRejectedRetries: 0` | existing COMPLETED record; refusal → `unavailable` (degrades, never re-pays; reservation released) |
| Long Form AI video submit (`ai-video-durable-provider.ts`) | `guardPaidCall` around `inner.generateVideo`; accepted job id → PROVIDER_JOB_RECORDED; resume paths commit the row | existing COMPLETED/STARTED records |
| Avatar narration, `createAvatar`, `generateVideo` (`avatar/pipeline.ts`) | `gatedVoiceSynthesize` / `guardPaidCall` (`maxRejectedRetries: 0`) | existing single-attempt claim + stored narration |

Pre-acceptance refusals are now typed: `voice.ts` throws `ProviderRejectedError` on a non-2xx answer; `beatoven.ts` marks the compose refusal with `paidCallOutcome: "rejected"`; `GenerativeProviderError` reasons map via `classifyPaidCallError` (`upstream_error`/`rate_limited` → rejected; moderation/budget/config/invalid_request/contract/auth/quota → rejected_final; a `providerJobId` → accepted; anything else → uncertain).

**Tests (mocks, run locally: 1425/1425 pass; `tsc --noEmit` and eslint clean):** `src/lib/paid-calls/gate.test.ts` B1-1/2 (mock charges then cuts → 1 call; same key twice more → still 1, row RECONCILIATION_REQUIRED), B1-3 (refusal retries exactly once, then stops across attempts), B1-3b, B1-4 (rejected_final/uncertain never retry), B1-5 (row SUBMITTED before the HTTP; unwritable ledger → 0 calls), B1-6 (unloadable result refused, not regenerated), B1-7 (accepted job → PROVIDER_JOB_RECORDED → resume → COMMITTED, 1 submit), B1-8 (key ignores attempts), B1-9 (Reel voice attempt 2 reuses with 0 calls; corrupted copy refused), B1-10 (Beatoven gated, library free); `supabase-ledger-store.test.ts` (CAS on a fake PostgREST; missing table fails closed).

**Why RB-01 stays PARTIAL, not IMPLEMENTED:**
1. No CI runs the suite (unchanged).
2. No sweeper: RECONCILIATION_REQUIRED and PROVIDER_JOB_RECORDED rows are only ever resolved by a later attempt's resume path or by hand. No entry point exists in the repo.
3. The idempotency key is local only; no provider receives it (ElevenLabs and OpenAI images have no such header on these endpoints; Runway/Veo not changed).
4. `wrapDurableVideoProvider` still forwards a request without `metadata.shotId` ungated (no safe key), as before.
5. Deps built without a ledger (`ShotExecutionDeps.ledger`, `DurableVideoProviderOptions.ledger`) fall back to an in-process memory ledger; `produce.ts` always passes the Supabase one, but the fallback is a test convenience, not a control.
6. `visual-resource-resolver` with a real provider and no ledger throws (fail closed); `generate-video.ts` always passes one.
7. **Deployment prerequisite:** with real providers, Generate now fails closed if `pi_paid_operations` (migration 0023) is not applied to the production database. Whether 0023 is applied in production is UNVERIFIABLE from the repo (the command-center has an "unavailable (0023 not applied?)" path). Apply 0023 before deploying this change; nothing in this phase applies it.
8. One existing expectation was re-specified to the rule: `production-tts-cache.test.ts` test 6 (corrupt cached audio after a COMMITTED row) now expects refusal, not a new paid synthesis; test 6b keeps the pre-B1 behaviour when the ledger has no row.

**RB-03 (re-pay part only):** a Reel retry no longer re-pays voice, image or music; the storage saga, content-addressed paths, orphan GC and hash reconciliation remain MISSING as in section 4.

---

## 18. Fase B2 — RB-02 atomic capacity hold (2026-10-02, after `33689b8`)

**Scope executed:** RB-02 only, on the worker admission path. No migration, no new table, no provider called (fake port in tests; the real port reads a table), no change to the B1 gate semantics or keys, VIDEO-004 untouched, PI V1 engine tree unchanged.

**Paso 0 (schema).** `0023_production_intelligence.sql:24` constrains `status` to `('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','COMMITTED','REFUNDED','RECONCILIATION_REQUIRED')`. The B1 gate writes SUBMITTED (engine), PROVIDER_JOB_RECORDED (`gate.ts:156,192`), REFUNDED (`:161`), RECONCILIATION_REQUIRED (`:168`) and COMMITTED (engine, `:192`): all in the list; no mismatch. The hold uses RESERVED → COMMITTED | REFUNDED, also in the list and forward under the 0023 trigger.

**Mechanism (`src/lib/paid-calls/capacity-hold.ts`).** One `pi_paid_operations` row per hold (`method = capacity_hold`, key `cap:<provider>:<seq>`, `project_id = requestId`, `reserved_usd` = USD estimate, `result_ref = units:<n>`). Atomicity without read-then-act: holds per provider form a dense sequence; each job lists the holds, computes `max(seq)+1` and INSERTs exactly that primary key. The PK serialises the inserts, so the job that lands sequence n is the only one that saw every hold below n (a hold j < n inserted after its listing would have made it target j). The decision `demand ≤ available − open` is therefore taken on an exact view of prior holds; a 23505 conflict re-lists and retries, bounded (100 rounds, then refuse). Open holds = RESERVED, plus COMMITTED holds created after the balance snapshot (the provider's balance cannot reflect them yet); REFUNDED never counts. All-or-nothing across several demands (rollback to REFUNDED).

**Balance port (`src/lib/paid-calls/capacity-port.ts`).** `ProviderBalancePort.read(provider)` → `{known:true, available, unit, checkedAt}` or `{known:false, reason}`. The production implementation `snapshotBalancePort` reads the newest `pi_capacity_snapshots` row (0023): known only when status is GREEN or YELLOW, `available` is set, reliability is `provider_api` or `manual_entry`, and the row is at most 24 h old. Anything else is UNKNOWN; a read error throws. UNKNOWN and errors both mean zero jobs (fail closed). `fakeBalancePort` is the test double; nothing calls a provider.

**Wiring (`src/lib/video/run-job.ts`).** After the attempt claim and before any pipeline dispatch: `capacityDemandsFor(row, voiceProvider.name)` (voice characters of the narration; none for the fixture provider or recorded avatar audio) → `releaseOpenHoldsForRequest` (frees holds left by fenced-out earlier attempts of the same request) → `acquireCapacityHolds` → refusal throws `CapacityUnavailableError` (customer-safe message, provider/balance/units detail in the log under the same diagnostic code) and the job is marked failed with no paid call. After the job (success or failure after admission) the hold is settled COMMITTED, so it keeps counting until a newer snapshot; it is never released as free.

**Tests (mocks; local run 1433 pass, one unrelated pre-existing ffmpeg loudness test flaked under full-suite load and passes in isolation; `tsc --noEmit` and eslint clean):** `src/lib/paid-calls/capacity-hold.test.ts` B2-1 (balance 3, 10 parallel → exactly 3 acquire, 7 rejected, mock runs 3 times), B2-2 (port throws → 10 rejected, mock 0, no rows), B2-3 (UNKNOWN and a hold-write failure → 0 jobs), B2-4 (COMMITTED-after-snapshot counts, REFUNDED frees, newer snapshot frees), B2-5 (stale hold of the same request released; all-or-nothing rollback), B2-6 (row encoding and CAS settle on a fake PostgREST), B2-7 (snapshot port rules), B2-8 (claim → hold → dispatch order in `run-job.ts`, source-structural).

**Why RB-02 stays PARTIAL, not IMPLEMENTED:**
1. **Deployment prerequisite (fail closed by rule):** with a real voice provider, every Generate job now refuses to start until `pi_capacity_snapshots` holds a GREEN/YELLOW row for `elevenlabs` (manual entry is enough; `pi_provider_accounts` must hold the provider first, foreign key) younger than 24 h. No code in the repo writes snapshots (no monitor, by mandate). Without that row, production Generate stops. Apply 0023 and seed the snapshot before deploying.
2. Only the voice demand is held; image and AI-video demands are not (their per-request USD budget from `production-budget.ts` is unchanged).
3. User and platform USD caps are still not atomic: `billing/quota.ts` monthly count is unchanged (read-then-act) and remains forgeable through the RB-06 insert hole.
4. No sweeper: a hold whose process dies stays RESERVED until the next attempt of the same request releases it; holds of abandoned requests reduce capacity until an operator settles them. Settlement after a failed job is COMMITTED (conservative), so refunds never happen automatically.
5. The command-center "open PI reservations" sum now includes hold rows (RESERVED, `reserved_usd` = USD estimate of the narration) until they settle.
6. No CI runs the suite.

---

## 19. Fase B3 — RB-06 owner-scoped signing (2026-10-02, after `5f6ba9a`)

**Scope executed:** the RB-06 signing site only (`src/lib/storage/signed-url.ts`, `src/app/dashboard/videos/[id]/page.tsx`, `src/app/dashboard/page.tsx`). No migration, no RLS change, bucket stays private, dashboard stays on. B1 gate, B2 hold and VIDEO-004 untouched.

**Test first (red at `5f6ba9a`).** `src/lib/storage/signed-url.test.ts` B3-1 ("user A cannot obtain a signed URL for user B's video_path") failed because no owner-scoped helper existed, and B3-1b failed because both pages called the raw `getSignedVideoUrl(path)` on whatever `video_path` the row carried. That reproduces the static finding: the row lookup was owner-filtered, the path inside the row was not.

**Fix (minimum, server side).** `ownedVideoPath(row, sessionUserId)` returns the path only when `row.user_id === sessionUserId` and the path is under `${row.id}/` with no empty, `.` or `..` segment; `getSignedVideoUrlForRequest(row, sessionUserId, sign)` signs that path or returns null without touching the service role. Both customer pages now sign through it (the detail page also for the Long Form thumbnail; the history page adds `user_id` to its select). A row a user owns can no longer point the service role at another tenant's object or at an owner-only review object (`video-004-thermopylae/...`). The raw helper remains only for the admin-gated fixed path in `/dashboard/admin/p2b-veo`.

**Tests (green after the fix; full suite 1439/1440, the one failure is the pre-existing ffmpeg loudness flake; `tsc --noEmit` and eslint clean):** B3-1 (B's path on A's row, B's row, review object, traversal/prefix tricks → null and zero sign calls; A's own path, attempt-scoped output and thumbnail → signed), B3-1b (pages use only the owner-scoped helper), B3-2 (the helper logs nothing; the pages' only console lines carry DB errors, never a URL, token or signature, so no redaction was added anywhere), B3-3 (the app's own INSERTs bind `user_id` to the session user, create only `pending`/`script_ready` rows and never set `video_path`, `created_at`, `render_attempts`, confirmation or plan columns).

**Why RB-06 stays PARTIAL:**
1. The 0001 insert policy still has no column restriction. A client calling PostgREST directly can set `status`, `created_at`, `render_attempts`, `long_form_confirmed_at` and `long_form_production_plan` on its own row: monthly quota, attempt cap and Long Form budget are still forgeable (RB-02 hold and B1 gate still apply to the spend itself). Closing it needs SQL (column grants or a BEFORE INSERT trigger) — described, not written.
2. `avatars` has the same insert shape (0011).
3. Sentry has no `beforeSend`; raw provider error text still reaches `error_message` for Reel/Avatar.
4. `isReviewOwner` is not wired on this branch's `/r/[slug]` route.
5. No CI runs the suite.

---

## 20. Fase B3.1 — RB-06 column guard, migration 0031 (2026-10-02, after `f7910a5`)

**Paso 0 (path layout).** The only writers of `video_requests.video_path` are the worker (`src/lib/video/run-job.ts:225`, value returned by the pipeline) and the operator recovery script (`scripts/recover-long-form-output.ts:257`). Every value is under `${requestId}/`: Reel `${requestId}/attempt-N/final.mp4` (`generate-video.ts:491` with `artifactPrefix` from `run-job.ts`), Long Form `${requestId}/output/final.mp4` (`output-finalize.ts:33 canonicalOutputPath`, also used by `reconcileExistingOutput` and the recovery script), Avatar `${requestId}/final.mp4` (`avatar/pipeline.ts:448,484`). The VIDEO-004 masters (`video-004-thermopylae/...`) are never written to `video_path`. `ownedVideoPath` (B3) was not loosened or changed.

**Migration `supabase/migrations/0031_video_request_column_guard.sql` (written, NOT applied to production).** Scoped to `public.video_requests` and the `anon`/`authenticated` roles: (1) revokes their table-level INSERT/UPDATE and re-grants both on every current column except `video_path`, `created_at`, `render_attempts`, `long_form_production_plan`, `long_form_confirmed_at` (Postgres cannot revoke one column under a table-level grant; a column added later is not client-writable until its migration grants it); (2) adds one RESTRICTIVE policy for INSERT and one for UPDATE: `user_id = auth.uid() and status in ('pending','script_ready')`. The 0001 policies are not rewritten, there is no trigger, `service_role` is not touched (keeps its grants and BYPASSRLS). Idempotent; manual rollback in the header. Registered in `supabase/migration-manifest.json` (v7) by exact sha256 with `knownProductionApplied: false`.

**Tests.** Real database: `supabase/migrations/verify/09_video_request_column_guard_test.sql` on local Postgres 16 after the stub and all 31 migrations, emulating Supabase's table-level default grants and re-applying 0031 on top. Result: 13 refusals (insert of B's `video_path`, `render_attempts`, plan, confirmation, past `created_at`, status `completed`, status `processing`, another user's `user_id`; update of `video_path`, `render_attempts`, plan; two `anon` inserts), A's `pending`, `script_ready` and default-status inserts succeed, a client status update changes nothing, `service_role` writes `video_path` under `${id}/`, status, attempts, plan and confirmation; re-running 0031 is a no-op. The same script on 0001–0030 fails at its first check ("insert video_path pointing at user B's object — the database accepted it"), so it detects the hole. Verify 01 passes with 0031; verify 07 fails at line 89 on a `yt_video_links` foreign key identically with and without 0031 (pre-existing, unrelated). Unit suite: `src/lib/security/video-request-column-guard.test.ts` pins the migration text, the exclusion list, the restrictive policies, the untouched service role and the manifest hash; `src/lib/storage/signed-url.test.ts` unchanged and green. Full suite 1444/1444; `tsc --noEmit` and eslint clean.

**Why RB-06 stays PARTIAL:**
1. 0031 is not applied to production (requires separate authorization). Until it is, the hole is open in production; the B3 signing fix already denies the cross-tenant read.
2. `avatars` (0011) has the same unrestricted insert shape; not in this phase's scope.
3. Sentry has no `beforeSend`; raw provider error text still reaches `error_message` for Reel/Avatar.
4. `isReviewOwner` is not wired on this branch's `/r/[slug]` route.
5. The real-database verify scripts are run by hand; no CI runs them or the unit suite.

ATOMIVID_PI_V2_REALITY_CHECK_COMPLETE
