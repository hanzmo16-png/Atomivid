# V6 impact board — SHOWCASE (same narration, same four files as V4/V5)

> Engineering visual benchmark. FIXTURE_ONLY / TEST_ONLY: synthetic, owned, local material.
> No real people, documents, events or geography. It proves nothing about documentary
> authenticity or Gucci readiness. This board is a reference. Production never reads it; the
> same contract is declared in the fixture's test code.

Assets (SHA-256 identical across BEFORE_V4, V5_SEQUENCE and V6_CINEMATIC):
`fixture-only:district` (CONTEXT), `fixture-only:portrait` (ANCHOR, curated `subject` region),
`fixture-only:gazette` (EVIDENCE, curated `headline`/`date`/`detail`), `fixture-only:schematic`
(GEOGRAPHY, curated SVG with one route and one label).

The difference from V5 is not new material. It is *where the weight falls*:

| V5 | V6 |
|---|---|
| Place in a black field, small slug | **Opening visual statement**: the place full-bleed and held, with the year in large serif |
| Cut to the face on "This is…" | Cut on the word that names the subject; name in serif from the **verified** identity |
| Page WIDE, hard cut to a static DETAIL | Page held (breath), then on the word "headline" a **continuous move** from the page to the headline (the reveal) |

---

## Sequence 1 — "Who, and where" (~16 s)

**Narrative purpose:** place the story, then hand it to its subject.
**What the viewer should understand/feel:** "This is the place. It is quiet. And this is the person it is about."
Feeling: stillness, then a face that matters.

| # | Moment (anchoring quote) | Impact | Role | Scale | Asset | Reason for impact | Reason for treatment | Rhythm | Truth restrictions |
|---|---|---|---|---|---|---|---|---|---|
| 1 | "In the spring of 1995…" | **3** | CONTEXT | WIDE, full-bleed, held | district | Opening visual statement: the first frame must say where and when | The place fills the frame (no small image in black); the year in large serif sits on the image, not alone | Long hold (~9 s) because it is a still and is not shortened | Context only: no person. The year is the narration's (planner), not an archival claim |
| 2 | "…the subject of our test story…" | **3** | ANCHOR | MEDIUM, slow push from the curated subject (≤ 1.08) | portrait | Introducing the protagonist | Cut *on the word* that names the subject, not at the sentence boundary; name in serif from the verified `entityLink` | Holds through the following sentences (one strong visual, several sentences) | Name comes only from the verified identity link, never from planner text |

## Sequence 2 — "What the record says, and where it led" (~24 s)

**Narrative purpose:** show the record, let it breathe, reveal its claim, then the route.
**What the viewer should understand/feel:** "There is a real page. Here is what matters on it. It describes a route."
Feeling: calm inspection, then recognition.

| # | Moment | Impact | Role | Scale | Asset | Reason for impact | Reason for treatment | Rhythm | Truth restrictions |
|---|---|---|---|---|---|---|---|---|---|
| 3 | "Weeks later the gazette printed the story…" | **1** | EVIDENCE | WIDE, full page held in its field | gazette | Breath: the viewer reads it as a whole page | No movement; restraint is the contrast for #4 | Hold (~7 s) | Evidence only for its exact proposition (`fixture-src-1`) |
| 4 | "…headline put the event in plain words…" | **3** | DETAIL of #3 (`headline`) | DETAIL: **continuous move** from the full page to the headline, which becomes dominant; the page is dimmed but its edges stay visible | gazette (same file, `verified_evidence_reuse`) | Evidence reveal: the claim takes the screen | The cut from #3 is invisible (same page, same position) and the move starts on the word "headline" | Move (~45 % of the shot), then holds the headline for reading | Curated region only; never upscaled past the source; never a quote card |
| 5 | "The report traced a single route…" | **2** | GEOGRAPHY | WIDE, curated SVG | schematic | Development: where it led | Draws only the line and label that already exist in the curated SVG | Reveal then hold | No geography is inferred, no troops; curated mark only |

The boundary between S1 and S2 is the only dissolve (short). Everything else is a hard cut.

**No impact rotation:** S1 is 3→3 (two strong moments that belong together), S2 is 1→3→2. **No beauty score:**
every asset first passes the existing truth/license/curation gates, and impact only decides
how a legal asset is presented. **Emotion does not move the camera:** the camera is decided by role.
