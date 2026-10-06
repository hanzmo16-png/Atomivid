# Documentary editorial engine v1 — 2026-10-06

## Purpose and scope

Hans requested self-service long-form videos with progressive storytelling instead of repeated suspense promises. This implements the gate in the existing documentary form, not an external assistant workflow. It does not generate or publish any of the three pending films during rollout. Existing scripts without editorial metadata remain compatible; approved DULCE I and Thermopylae assets are untouched. Shorts and podcast generation are outside this first integration.

## Execution

1. Authenticated eligible owner/customer submits topic, language, duration (default seven minutes), optional references and open questions.
2. One native Anthropic web search obtains cited excerpts. User-supplied references are hints, never evidence merely because a URL exists. At least two unique retrieved source URLs must also have native cited excerpts; uncited model prose is discarded. This is excerpt-based research, not a claim of full-document review or independent corroboration. Unsupported or incomplete research stops.
3. Writer outputs the central question, opening promise, first answer, ending and each block's new information/consequence/tension before the draft. Documentary claims retain sourced/inference/unverified distinctions and links to source IDs.
4. A separate critic call sees all narration and the retrieved excerpts. It checks semantic repetitions, meaningful callbacks, new information, unsupported factual claims, an early reward and the ending's delivery. Literal quotes and zero-based block indices are checked in code. Each block must be covered. No made-up retention score controls acceptance.
5. One combined rewrite allowance covers both duration and editorial problems. The rewritten draft gets a fresh critic call. Persistent blockers stop before the video request is created. No indefinite rewrite loops or uncertain paid retries.
6. Approved beats, source references and the editorial report are stored in script_json. The report hashes authored narration, claims and visual directions. Confirmation, render admission and worker admission reject modified or invalid reports. Legacy metadata-free scripts are not retroactively rejected.
7. The configuration page shows the narrative plan and retrieved references. Voice, images and motion remain behind the existing production-plan confirmation, quotas, spending and supplier controls.

## Costs and recovery

- Three provider requests for research + clean draft + critic; at most five with one rewrite/review. SDK retries are zero. Failed/uncertain calls retain the durable ledger's existing behavior.
- Owner/input/version-scoped paid keys and full parameter fingerprints reuse committed results on replay. No new retry key is silently minted for the same form or uncertain operation.
- Research uses web_search_20250305 with max_uses=1, parallel tool calls disabled and a 4,000-token output limit. No continuation of pause_turn, no second search, no structured-output format incompatible with citations.
- Only the configured claude-sonnet-5 research model has an admitted context reservation. Other research models fail closed until their context/cost configuration is verified. Writer/critic retain the existing model environment precedence.
- The native search price ($0.01/search) is included in actual ledger accounting using server_tool_use.web_search_requests. Missing usage retains the reservation rather than recording a free call.
- Search tokens are not bounded by the HTTP request text. A conservative two-context (2 × 1M input tokens) plus two output allowances reservation is used. With the current $2/$10 token rates, this is **$4.09 reserved**, not a promise of actual cost. The existing period-admission ledger may count this reservation conservatively even after a cheaper committed result; no cap was raised to accommodate it.
- Unchanged: $40/day and $300/month globally, $20/day and $150/month per provider, two workers, $500 reserve, no transfers/autorecharges, panel-only alerts, manual balance accounting without expiry, API balance freshness five minutes, clip quotas and existing provider-call quotas.

## Validation and practical limits

Local validation uses simulated writers, critics, native citation responses and provider failures. It proves orchestration, literal evidence binding, coverage, correction bounds, source rejection, cost arithmetic and admission behavior. It does **not** prove the live model consistently spots every weak passage or improve measured retention; the first real self-service draft still needs content evaluation. No supplier API calls, paid voice/image/video generation or render launches were made while implementing/testing this change.

Executed: TypeScript, 1,327 unit tests and 73 spending-control tests, all passing. Dedicated editorial suite: 46 passing tests and registered in CI. Test fixtures include three differently worded promises about restricted levels, a substantive callback that must remain allowed, unsupported source IDs, invented review quotes, incomplete reviews, an unresolved ending, edited approved scripts, research tool failure, truncation, missing citations and duplicate sources.

The existing server-action budget is 300 seconds. Five slow model calls can still exhaust it; committed stages are durable, uncertain stages must reconcile and never silently replay. Failed editorial drafts are retained in the paid result store but this version does not add a failed-draft editing UI. Automated factual/editorial review is fallible; actual audience retention must be measured after publishing.

## Primary API references used

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/models/sonnet-5/overview
