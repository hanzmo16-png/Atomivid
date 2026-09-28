# Policy promotion

**Lifecycle.** CANDIDATE → SHADOW → ACTIVE → RETIRED, only through `promotePolicy()` by a **global operator** with a written reason (projects and tenants are rejected). Promoting to ACTIVE retires the previous ACTIVE policy; the DB allows exactly one ACTIVE row and keeps an append-only history.

**Shadow.** `runShadow()` receives the same inputs as the active policy, calls only the pure `decide()`, and returns `activeDecision`, `shadowDecision`, `estimatedDelta`. It has no provider port, no ledger and no spend path (test 9 fails any network call).

**Pinning.** A quoted project is pinned to policy, profile, contract, rate card and memory snapshot versions; `decide()` throws on any mismatch, so a project never changes policy mid-production.

**Memory is informative.** Production Memory is a read-only projection of telemetry keyed by (provider, modelVersion, shotClass, method, rateCardVersion) in a 90-day window. Unknown model versions are marked, never invented or merged. Human-intervened results are counted separately and do not vote.

**Future data-driven gate (documented, not active).** A memory cell may inform a candidate policy only when: n ≥ 50 automatic attempts for (modelVersion, shotClass, method); that model version has been active ≥ 30 days; a shadow run shows ≥ 15 % lower cost per accepted second without a material keep-rate drop (> 2 points). `promotionGate()` evaluates these conditions; even when eligible, promotion stays a human decision. YouTube Analytics never modifies production policy.

**How to test.** Tests 9, 10, 11, 19, 20 in `production-intelligence.test.ts`.
