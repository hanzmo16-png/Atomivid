# YouTube Long Form — pilot readiness (Grok, 2026-10-26)

USD 0. No merge, no deploy, no migrations, no production Supabase, no flag or secret changes, no ledger writes, no paid provider calls. This branch does not touch PR branches #199, #221, #222, #223, or #225.

**Verdict: NO-GO for a paid run on https://atomicvid.app today.** A simulation and an unmerged branch are not a production pilot.

## Answers

| Question | Answer |
| --- | --- |
| Ready for Hans to run it himself? | No. |
| What blocks today? | Production tip `762714e` can still spend voice/images and then stop without an MP4. Confirm on that tip ignores script spend, conservative prices, music, and the render worst case. The worker refuse-before-spend lives only on draft #223. The confirm alignment in this PR is not deployed. |
| Steps to unblock? | Hans merges #223, then merges this draft (or resolves the small overlap in `confirm-production.ts` in favor of the shared formula). He signs in with an account that already sees «YouTube / Documental», checks ElevenLabs and image supply, chooses «Proveedor actual», and confirms only if Configurar shows the worker subtotal inside USD 12. |
| Budget for the first real documentary? | 10 or 15 minutes, «Proveedor actual», balanced or economical. At list prices and USD 0 of script already spent, the measured subtotals are about **USD 8.74 (10 min balanced)** and **USD 9.29 (15 min balanced)**, including the USD 5.94 render worst case. Add the real script/research spend shown on the screen. Do not start if that line says the subtotal exceeds USD 12. |
| Quality and money risks? | Default plan is v3 (archive + capped AI images), not Cinematic V6 identity. Dated-event and editorial gates exist; generic stock can still illustrate a scene that is not a dated fact. Money risk if #223 is not merged: a plan confirmed before this gate, or any path that skips confirm, can still pay and stall. Contingency on a 30 min balanced list-price plan is clipped (proposed USD 12.77, authorized USD 12). |
| What must Hans authorize? | Merge of #223. Merge of this draft. His own login on an account that can open the YouTube flow. Provider balances (ElevenLabs; OpenAI if the plan uses AI images; Pexels). Recraft only if its supply is already green — otherwise «Proveedor actual». He must not raise `LONG_FORM_MAX_TOTAL_USD` from this note. A higher ceiling is his decision only after a real plan shows a subtotal above 12. |

## 1. Real module state and blockers

Production tip verified locally: `claude/atomivid-mvp-setup-0079jv` @ `762714e2` («Merge PR #198…»). Open PR heads were read from GitHub, not from stale SHAs.

The self-serve path is **YouTube / Documental** → `/dashboard/long-form/new` → research/script job → editorial approval → `/dashboard/long-form/configure/[id]` → confirm → render → play/download on the video page.

| Step | State on `762714e` | Class |
| --- | --- | --- |
| Module visibility | The card is shown only when `canAccessLongFormBeta` is true (avatar-prep access or the internal production owner). `LONG_FORM_ENABLED` + allowlist gate dry-run / `assertLongFormAccess`, not this card. Flag default is off. | P0 to *run*, owned by Hans’s account and env. Not a code defect to patch here. |
| Research / script / editorial | Present. Editorial approval is required before confirm. JSON repair from #195 is already on this tip. | Not a new P0. |
| Truth / sources | v3 blocks a calendar-dated passage illustrated as generic stock (`dated-event-preflight`) before spend. Sources render when the script stored them. v3 is not an identity/evidence engine. | P1 quality residual. #223’s extra dated-card commit `71e409f` was reverted on #223 itself (`23c2596`). |
| Editor / visual plan | Configure recomputes the plan on the server. The browser cannot submit a plan or a price. | Working. |
| Visual providers | «Proveedor actual» (OpenAI images) and «Imágenes IA con Recraft». Recraft is offered only when `recraftAllowedFor` is true, and supply is still checked. The picker **defaults to Recraft** when the account may use it. | Pilot should switch to «Proveedor actual» unless Recraft supply is green. |
| Recraft when supply is unset | Preflight marks the provider Insuficiente and the confirm button stays disabled. «Proveedor actual» remains selectable. | Not a silent spend. |
| ElevenLabs | Plan pins `elevenlabs`. Voice picker writes `reel_voice_id` in the same conditional update as confirm. | Working on this tip. |
| Music / mix / transitions / sync | Curated library is USD 0. Beatoven with an empty `BEATOVEN_ESTIMATED_COST_USD` is an unverified price: this PR refuses confirm. Narration length vs provider end-time is a #223 fix (`20ffb537`), not on production. | P0 timing fix is #223, not redone here. |
| Image / video processing | Shot executor, stock selection, BT.709 color (`1f8d420` on #223 only). | P1 color on #223. |
| Long-doc waits | Timeouts for TTS, Pexels, downloads, music poll, upload are #223 (`9a93ae9`). 30 min form/workflow limits are already on this tip (`thirty-minutes.test.ts`). | P0 timeouts are #223. |
| Render / storage | Render is a separate route after confirm. Output ceiling and bitrate fit are on this tip. A job with no terminal state is #223 (`e66bdae`). | P0 terminal-state is #223. |
| Play / download | `LongFormResult` uses a `<video controls>` plus `asDownloadUrl(..., "atomicvid-video.mp4")` with `download`. Samsung behavior was not re-run on a device in this session. | Existing. Phone configure overflow is P1 (below). |
| Budget gate | **P0.** Confirm compared `estimatedProviderCostUsd` to USD 12. The worker builds script-spent + conservative voice/images/video + music + render (USD 5.94) and, on this tip, **clips** the ceiling (`request-budget.ts`). A plan can confirm and then pay until the clipped ceiling stops it. #223 refuses that clip inside `authorizeRequestBudget` but confirm there still uses provider estimate + render, not script spent + conservative prices. | Fixed on this branch at confirm/configure. Worker clip remains until #223 merges. |

HeyGen #225 is not on this path. Security code `09891f0aad262b19a69f9c810d0a393fded104f5` was left alone. Later docs HEAD `44a34680283d` is docs-only. No Long Form blocker traced to HeyGen.

In-repo protocol: `src/lib/orchestrator/protocol.ts` is Drive protocol v2. `docs/ORCHESTRATOR.md` mentions protocol v3; the v3/v3.1 text is not in this checkout. `AGENTS.md` is the Next.js agent pointer. No protocol was invented.

## 2. Fixed vs pending

### Fixed on this branch

- **P0 — confirm and the configure screen use the worker stage total.** `previewWorkerAuthorization` builds the same stages as `produce.ts` (research 0, script = ledger spend, style 0, conservative voice/images/video, music, render worst case) and runs them through `pilotBudgetEnvelope`. If the subtotal exceeds `LONG_FORM_MAX_TOTAL_USD`, confirm returns 409 and writes nothing. Contingency may be clipped; the stages may not. The screen shows script already spent, render worst case, subtotal, contingency ceiling, and the ceiling that would be authorized, before «Confirmar y generar video».
- **P1 — Recraft controls no longer force the configure form wider than the phone.** Same four classes as #219 (`fieldset min-w-0`; file input and both `<select>`s `w-full min-w-0 max-w-full`) in `ReelImageSourcePicker.tsx`, which Long Form configure reuses. #219’s branch was not modified.

`authorizeRequestBudget` was **not** changed. That refuse-before-spend patch already exists on #223 (`6d6d7d78`). Copying it would rewrite #223’s fix. Until #223 is merged, a plan that was confirmed earlier, or a CLI/worker entry that skips this confirm, can still clip and stall.

### Pending (do not treat as done)

| Item | Class | Where it already lives |
| --- | --- | --- |
| Worker refuses a new authorization whose stages do not fit, instead of clipping and spending | P0 | #223 `request-budget.ts` @ `6d6d7d78`, HEAD `23c25962` |
| Provider timeouts; narration timed by real audio length; no job left without a terminal state; BT.709; wax-tablet false friend | P0/P1 | #223, same HEAD. Not ported. |
| Recraft mobile as its own PR | P1 | #219 @ `fe09ab5`. The CSS is also on this branch so a phone configure is not blocked if #219 merges later or not. |
| Cinematic identity, no generic people, evidence vs recreation | P1 quality | v6 / verified-asset gates. Default product plan is v3. Not a free one-line fix. Not changed. |
| Music level, burned-in subs, black frames, repetitive shots | P2 unless a failing test shows up on a real render | Not reproduced in this USD 0 pass. #224’s cierre run is the standing evidence for the integrated tree. |
| Podcast Studio 3.0, O1–O9, A-1–A-3b, ledger, flags, deploy | Out of scope | — |

## 3. PRs and SHAs

| PR | Role | SHA | Base |
| --- | --- | --- | --- |
| This draft | Confirm/configure formula + Recraft phone CSS | `0170dc4a5ccdf067a081aa3995091fac45a7becf` on `cursor/longform-confirm-budget-0fc3` | `claude/atomivid-mvp-setup-0079jv` @ `762714e2` |
| [#223](https://github.com/hanzmo16-png/Atomivid/pull/223) | Claude Long Form technical close. Do not redo. | `23c25962ff0ea4457d051e1c53e446481ea987c4` | #207 @ `d8b203d665e62602cec5cb72620f03b5630edd12` |
| [#224](https://github.com/hanzmo16-png/Atomivid/pull/224) | Integrated verification train. Do not merge. | `91da24bed1a536a6592bbae5fe59f4561d5fb9fd` | — |
| [#225](https://github.com/hanzmo16-png/Atomivid/pull/225) | HeyGen. No further work. | Security `09891f0aad262b19a69f9c810d0a393fded104f5`. Docs HEAD `44a34680283d3638fa3666d2b68eaf733a1878b5` | production tip |
| [#219](https://github.com/hanzmo16-png/Atomivid/pull/219) | Recraft mobile CSS, same classes as this branch | `fe09ab5dc0d1d3cd2f43aaba7fca1b108cbbef47` | production tip |

## 4. CI

Reused. Not re-run.

- #224 `longform-e2e-cierre` success at `91da24b`: https://github.com/hanzmo16-png/Atomivid/actions/runs/40367026127 — reported result **62 PASS / 0 FAIL / 2 NP**. This branch does not contain that harness; the suite was not repeated.
- #223 at `23c25962`: rescate https://github.com/hanzmo16-png/Atomivid/actions/runs/40367040986 , reel-budget https://github.com/hanzmo16-png/Atomivid/actions/runs/40359559487 , E2E fixture evidence https://github.com/hanzmo16-png/Atomivid/actions/runs/40367023658 . Checks on the PR are success. Still a draft. Not a production deploy.
- #225 security SHA `09891f0` was already green (upload). Current docs HEAD `44a3468` run https://github.com/hanzmo16-png/Atomivid/actions/runs/40390613381 — typecheck, regression, rescate, evidence success; `e2e` was still pending at survey time and is out of scope.
- This draft’s CI starts when the branch is pushed. Link goes in the PR. Local focused run is in section 5.

## 5. Full path (simulation, USD 0)

Not a new end-to-end MP4. The integrated UI→MP4 evidence stays the #224 run above. This session added tests only for the formula change.

Local, `node --import tsx --test` on:

- `src/lib/video/long-form/worker-budget-preview.test.ts`
- `src/lib/video/long-form/confirm-production.test.ts`
- `src/lib/video/long-form/production-preflight.test.ts`
- `src/lib/video/long-form/confirm-production-route.test.ts`
- `src/lib/video/long-form/request-budget.test.ts` (side effect: clipping behavior of the worker is unchanged)

**30 passed, 0 failed** on the budget/confirm/request-budget set; preflight and route structural tests passed in the same session (32 including preflight/route, then 30 on the rerun that swapped in `request-budget.test.ts`).

What those tests show:

- A plan whose provider estimate fits under USD 12 is refused when script already spent + render push the worker subtotal over the ceiling. Zero conditional updates.
- Contingency alone may be clipped. Stages that do not fit are not authorized.
- Beatoven without a verified price is not authorized.
- An observed image bill above the list price raises the image stage (10 images at USD 0.20 → USD 2.00).
- Existing confirm cases (CAS, editorial, dated-event 409, Recraft and voice written in the same update) still pass. The 180 s fixture still confirms under the default ceiling.
- `request-budget.ts` still clips. That is #223’s change, left in place on #223 only.

Negative cases covered by these tests plus the unchanged worker tests: unverified price, subtotal over the ceiling, bad/missing script scope fails closed (confirm 409, no update). Double charge on retry and durable auth are the existing `request-budget` create-only behavior; this PR does not weaken them. Render is still a second request after confirm (`ConfigureProduction` posts confirm, then `/render`). Paid assets are not discarded by this patch.

No provider-down or worker-interrupt drill was re-executed here. Those sit in #223/#224. Samsung download was not emulated in this session; the download control is the existing `LongFormResult` link.

## 6. Budget table, 10–30 min

Refreshed because confirm on this branch no longer uses provider-estimate alone. Prices are the code’s list prices: ElevenLabs USD 0.10 / 1k characters, OpenAI image USD 0.05 inside `LONG_FORM_MAX_IMAGE_USD` = 2, curated music USD 0, render worst case **3 × 330 min × USD 0.006 = 5.94**, contingency 20%, ceiling USD 12, script spend USD 0. Script is a word-budget fixture (`narrationWordBudget`, token «claro»), not a billed documentary. **AI-video clips allocated: 0** (eligibility did not schedule Veo/Runway on this fixture, with the flag on or off). Archive footage USD 0.

| Minutes | Strategy | Voice | Images | Video | Render | Subtotal | With 20% contingency | Authorized at USD 12 | Fits? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | economical | 0.90 | 0 | 0 | 5.94 | 6.84 | 8.21 | 8.21 | Yes, full contingency |
| 10 | balanced | 0.90 | 1.90 | 0 | 5.94 | 8.74 | 10.49 | 10.49 | Yes, full contingency |
| 10 | cinematic | 0.90 | 2.00 | 0 | 5.94 | 8.84 | 10.61 | 10.61 | Yes, full contingency |
| 15 | economical | 1.35 | 0 | 0 | 5.94 | 7.29 | 8.75 | 8.75 | Yes |
| 15 | balanced / cinematic | 1.35 | 2.00 | 0 | 5.94 | 9.29 | 11.15 | 11.15 | Yes |
| 20 | economical | 1.80 | 0 | 0 | 5.94 | 7.75 | 9.30 | 9.30 | Yes |
| 20 | balanced / cinematic | 1.80 | 2.00 | 0 | 5.94 | 9.75 | 11.70 | 11.70 | Yes |
| 30 | economical | 2.70 | 0 | 0 | 5.94 | 8.64 | 10.37 | 10.37 | Yes |
| 30 | balanced / cinematic | 2.70 | 2.00 | 0 | 5.94 | 10.64 | 12.77 | **12.00** | Stages fit; contingency clipped |

Claude’s offline matrix (uploads, #223 @ `23c2596`) is stricter in the «alto / worst case» rows (about USD 12.17–14.36 ideal, about USD 18–21 worst). That band is what you get once script spend, observed bills, or real AI-video clips are added. It was not reproduced as a list-price archive plan on this fixture, and it was not thrown away. Example this formula **refuses**: the same 30 min balanced plan plus USD 2 already spent on the script → subtotal about USD 12.64 > 12. #223’s confirm (provider estimate + render ≈ USD 10.64) would still have allowed it. That is the hole this PR closes at confirm time.

`LONG_FORM_MAX_TOTAL_USD` was not raised. USD 12 is enough for the list-price rows above. It is not enough for a plan whose screen subtotal is higher. The correct ceiling is that subtotal (plus contingency only if Hans wants the buffer). Reporting it is not permission to change the env.

Per provider, unchanged rates: ElevenLabs voice; OpenAI or Recraft images (Recraft unit USD 0.040 including one style creation, still inside the image dollar cap); Pexels USD 0; curated music USD 0; Beatoven blocked until `BEATOVEN_ESTIMATED_COST_USD` is a real number; render USD 5.94 worst case, outside the ledger, subtracted from the provider room.

## 7. Quality

Hierarchy used: veracity, then quality, then consistency, then cost, then speed. Nothing was cheapened to stay inside USD 12. Plans that do not fit are refused instead of being silently thinned.

Not claimed from this session: narration locked to each image, historical identity, no repeated shots, music level, full words, no black frames, burned-in subtitles on a new master. Those need a real or fixture render. #224’s 62/0/2 run is the evidence that the integrated tree can finish a simulated 16:9 MP4. Default v3 will still use illustrative stock when the script is not a blocked dated event. Identity and «no generic person» are the v6 / verified-asset gates, which stop before spend when evidence is missing. They are not the default account.

#223 still holds the reproducible timing, color, timeout, and false-friend fixes. They are pending Hans’s merge, not reimplemented here.

## 8. Dependencies to activate a pilot

1. Merge #223 so the worker refuses an over-ceiling authorization before any provider call. Without it, this confirm gate only protects plans confirmed through the UI after this PR is deployed.
2. Merge this draft so Configurar and confirm use that same formula, and so the phone image picker does not overflow.
3. Hans’s account must already pass `canAccessLongFormBeta` (internal owner or avatar-prep beta). This session did not read or set production env.
4. ElevenLabs characters and, if the plan uses AI images, OpenAI (or Recraft with a green supply snapshot). Pexels for archive. Curated music needs no Beatoven price.
5. No migration from this PR. No new flag. No change to the USD 12 env.

## 9. First run from Hans’s account

1. Open https://atomicvid.app and sign in with the account that already sees **YouTube / Documental** under New. If the card is missing, stop. Access is not something this PR turns on.
2. New documentary, **10 or 15 minutes**, one concrete topic. Wait until the script job finishes and the editorial review is approved. If it fails, do not confirm a half script.
3. On Configurar, set images to **Proveedor actual (como hasta ahora)** unless Recraft’s row says Suficiente. Pick the ElevenLabs voice.
4. Read **Subtotal que el worker exige**, **Guion ya gastado**, and **Render (peor caso)**. The provider-only estimate is not the budget.
5. Press **Confirmar y generar video** only when the subtotal fits and the button is enabled. If the page names a subtotal above USD 12, pick economical or a shorter duration. Do not raise the ceiling to force it.
6. After it finishes, play the video on the result page and use **Descargar video**. Check picture, voice, and music before a second paid run.

## 10. GO / NO-GO

**NO-GO** for a paid Long Form on production today.

Residual risks after both drafts merge and Hans deploys them:

- Observed image prices or a long script bill can still push a 20–30 min plan over USD 12. The screen will refuse it. That refusal is the control, not a bug.
- 30 min balanced at list prices authorizes USD 12 with contingency clipped from USD 12.77. A bill that lands in the missing buffer stops later work. #223’s worker then stops before the next paid call; it does not refund what already succeeded.
- AI-video clips were USD 0 in this table. A real cinematic plan that schedules Veo (about USD 0.96 per 8 s clip) or Runway (USD 0.05/s, reserved as 10 s) can cross USD 12. Believe the subtotal on that plan.
- v3 stock is illustrative. It is not a warrant that a named person or a piece of evidence is the real one.
- This report’s tests did not render a new 1920×1080 master.

---

Coordinator one-liner: **NO-GO on atomicvid.app until Hans merges #223 and this draft; first paid doc 10–15 min, Proveedor actual, only if the on-screen worker subtotal is under USD 12.**
