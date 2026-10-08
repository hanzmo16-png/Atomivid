# GUCCI_40S_STORYBOARD (V6 · cinematic opening, 40 s)

> Status: **NOT RENDERED.** The zero-cost preflight blocked the run before any paid call (see `REMAINING_BLOCKERS`).
> This storyboard is the plan to execute once the blockers are cleared. Spend so far: USD 0.00.

Rule: NARRATIVE TRUTH > CINEMATIC IMPACT > COST > SPEED. Nothing generated may represent Maurizio Gucci,
the murder, weapons, victims, perpetrators or documents. Every generated environment carries the visible
"Recreación IA" label.

| Time | Moment | Narration (draft) | V5 role | V6 impact | Material | Provenance | Treatment |
|---|---|---|---|---|---|---|---|
| 0–7 s | HOOK | "Milan, March 1995. A city that gets up early and a street where nothing seems out of place." | CONTEXT (empty-street atmosphere) | 3 | 8 s generated clip: empty Milan street at dawn, wet asphalt, 1990s facades, **no people** | `ai_recreation`, "Recreación IA" label | Real camera movement in the clip; "1995 / MILÁN" in serif as the opening statement |
| 7–14 s | PROTAGONIST | "Maurizio Gucci, the last of the family to run the brand that bore his name." | ANCHOR | 3 | Verified portrait of Maurizio Gucci (≥1280 px, PD/CC0/CC BY or licensed) | `archival_documentary` + visible credit | Slow push from the curated `subject` region (≤1.08); name in serif **only** from the verified link |
| 14–22 s | TENSION | "Every morning he walked the same few metres to his office on Via Palestro." | CONTEXT (place) | 2 | 8 s generated clip: 1990s Milan office building facade, entrance, **no people** — or a legal photo of the real building | `ai_recreation` (labelled) or legal archive | Slow lateral move; never an extra standing in for Maurizio |
| 22–31 s | REVEAL | "On 27 March 1995 four shots changed that walk forever." | EVIDENCE → DETAIL `headline` | 1 → 3 | Authentic front page of 28 March 1995 with a curated `headline` region | Licensed archive (newspaper or agency) | Full page held, then a continuous move to the headline (≤1:1 resolution, page edges visible) |
| 31–40 s | NARRATIVE HOOK | "Who would want to end the life of the man who had just lost everything? The answer was closer than anyone imagined." | TRANSITION (directed abstention) or ANCHOR at impact 1 | 3 | Black field with type: "27 · III · 1995" (serif) + the question; or the portrait held | Text written for the documentary (no archival claim) | Hard cut; hold; music up |

## Estimated cost (USD 5.00 cap)

| Item | Unit (repo) | Quantity | Maximum |
|---|---|---|---|
| Generated video (Veo, 1080p, 8 s clips) | 0.12 USD/s (`VEO_DEFAULT_COST_USD_PER_SECOND`) | 2 clips × 8 s | 1.92 |
| Narration (ElevenLabs) | 0.10 USD / 1,000 characters | ~600 characters | 0.06 |
| Music (Beatoven) | `BEATOVEN_ESTIMATED_COST_USD` (default 0) | 1 track | ~0.00 (confirm the real rate) |
| Render | local Remotion | 1 | 0.00 |
| **Total** | | | **≈ 1.98, no automatic retries** |

Budget is not the blocker; credentials, network, curation and executability are.

## REMAINING_BLOCKERS (zero-cost preflight, 2026-10-08)

1. **No provider credentials in this environment.** `VEO_API_KEY`/`GOOGLE_API_KEY`, `ELEVENLABS_API_KEY` and `BEATOVEN_API_KEY` are absent. A real clip, narration or music cannot be produced from here.
2. **No access to the payment gates.** `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` are absent. The ledger, reservations and spend cap live in Supabase, so a paid call cannot go through the existing gates (bypassing them is forbidden).
3. **No verified portrait of Maurizio Gucci.** No curated registry contains one, and Wikimedia Commons is blocked by this environment's network policy (`commons.wikimedia.org` → 403). Approval also requires a curator authenticated in `/dashboard/admin/curation/[requestId]` with `ASSET_CURATOR_EMAILS` configured; Claude cannot self-approve.
4. **No authentic headline with usable rights.** The front pages of March 1995 are protected; they need a licence (archive/agency) with a contractual reference and a curated `headline` region. They will not be invented.
5. **V6 cannot run on the real worker.** `EXECUTABLE_PLAN_VERSIONS` = 1–4, and V6 is only on branch `claude/hola-sn3dxy` (`bf67cff`), not in production. Enabling it needs an explicit, isolated activation; no merge or deploy is authorized.

## To execute (in order)

1. Add the provider and Supabase credentials as environment secrets (never in the chat).
2. Allow `commons.wikimedia.org` and `upload.wikimedia.org` in the network policy (free searches).
3. Configure `ASSET_CURATOR_EMAILS` and approve, one by one, the Maurizio portrait and the licensed 1995 front page with its `headline` region.
4. Authorize an isolated V6 run (local or a test route) that uses the existing ledger and gates. Then: one production of ≤ USD 5, no automatic retries.
