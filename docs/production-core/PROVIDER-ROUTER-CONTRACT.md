# Provider Router — contract only (no automatic selection yet)

Pipeline per shot, each step a pure function with an auditable output:

```
SHOT CONTRACT            ProductionShotRecord.contract (PI shot contract, unchanged)
   ↓
QUALITY FLOOR            floorMethod(contract, profile) — cheapest method that satisfies the contract
   ↓
ELIGIBLE PROVIDERS       PRODUCTION_POLICY_V1.providerEligibility[assetType]  (+ per-provider ceilings)
   ↓
CAPACITY                 canAcceptJob([{provider, estimated, worstCase}], adapters, ceilings, ctx) — UNKNOWN never accepts silently
   ↓
EXPECTED COST            costOf(rateCard, method) → CostLedger.estimateShot / reserve (worst case reserved)
   ↓
PROVIDER SELECTION       ProviderRouter.select(input) → { provider, model, method, reasons[], decisionHash }   ← FUTURE
   ↓
GENERATION               executePaidOperation(ledger, op, port) — idempotent key, write-ahead, resume, never resubmit
   ↓
FINAL CUT QA             runFinalCut(edl) → EDITORIAL_QA_PASS | REPAIR_REQUIRED | FAIL | HUMAN_REVIEW_REQUIRED
   ↓
FALLBACK / ESCALATION    decide() fallback rules (R07–R09), AUTO_FIX / SMART_REPAIR (gated) / ESCALATE
```

## Router interface (to implement later; nothing selects automatically today)
```ts
type RouterInput = { record: ProductionShotRecord; floor: Method; eligible: ProviderId[]; capacity: Record<ProviderId, ProviderCapacityState>; expectedCostUsd: Record<ProviderId, number>; policy: ProductionPolicy };
type RouterDecision = { provider: ProviderId; model: string; method: Method; reasons: string[]; decisionHash: string; fallbackChain: ProviderId[] };
interface ProviderRouter { routerVersion: string; select(i: RouterInput): RouterDecision }
```
- Providers are registered by id with a capability descriptor `{ id, media: ("still"|"video"|"voice")[], models, rateCardEntries, capacityAdapter }`; adding one never touches the router core.
- Initial registry: `runway` (I2V), `veo` (I2V), `openai` (stills), `elevenlabs` (voice). Any future provider joins through the same descriptor; no vendor-specific branch in the router.
- Selection is deterministic and explained (`reasons[]`, `decisionHash`) and pinned per project like every PI decision; a router version change never applies to a project mid-production.
- Budget is a ceiling: the router can pick a cheaper provider, never a paid upgrade without an `upgradeReason` (C14/C15).
- UNKNOWN capacity requires explicit operator acceptance (C9); the router never assumes GREEN.
