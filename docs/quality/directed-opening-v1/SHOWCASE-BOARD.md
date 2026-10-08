# SHOWCASE board — Directed Opening V1

> Engineering visual benchmark. FIXTURE_ONLY / TEST_ONLY material: synthetic, owned and
> local, with no real people, brands, documents, events or geography. This is a
> reference for the proof only. Production never reads it: the same sequence
> contract is declared in the fixture's test code, and any planner can declare it
> the same way.

Four assets (identical bytes in BEFORE and AFTER):

| Fixture | File | Size |
|---|---|---|
| ANCHOR | `fixture-only:portrait` (fictional face, "Fixture Person") | 2400×1600 |
| CONTEXT | `fixture-only:district` (synthetic, unnamed street facade) | 2400×1600 |
| DOCUMENT | `fixture-only:gazette` (synthetic page; curated `headline`/`date`/`detail` regions) | 1800×2400 |
| GEOGRAPHY | `fixture-only:schematic` (curated SVG: one `route` path + one `route-label`) | 1920×1080 |

---

## Sequence 1 — "Who, and where" (~16 s)

**PURPOSE:** place the story before introducing its subject.

**WHAT THE VIEWER SHOULD UNDERSTAND/FEEL:** "This happened in a quiet, closed
place, and this is the person it is about." The viewer should feel stillness first
and then a face.

**ROLE ORDER:** CONTEXT → ANCHOR

| # | Role | Scale | Asset | Narrative reason for the scale |
|---|---|---|---|---|
| 1 | CONTEXT | **WIDE**, image held inside a black field | `fixture-only:district` | Establish the place. A held wide frame says "here" without movement pretending to be action. |
| 2 | ANCHOR | **MEDIUM**, slow off-centre push (≤ 1.08, origin on the curated `subject` region) | `fixture-only:portrait` | Introduce the person. The hard cut WIDE → MEDIUM *is* the move from place to person. |

No DETAIL in this sequence: nothing in the narration points at a specific region
of either image, so none is manufactured. Sequence slug: **1995** (serif) /
FIXTURE DISTRICT (sans).

## Sequence 2 — "What the record says, and where it led" (~22 s)

**PURPOSE:** show the record, make its claim legible, then show the route it describes.

**WHAT THE VIEWER SHOULD UNDERSTAND/FEEL:** "There is a written record, *this* is
what it says, and it describes a route from A to B." The feeling is recognition,
then clarity.

**ROLE ORDER:** EVIDENCE → DETAIL (of the same page) → GEOGRAPHY

| # | Role | Scale | Asset | Narrative reason for the scale |
|---|---|---|---|---|
| 3 | EVIDENCE | **WIDE**, the full page in a black field | `fixture-only:gazette` | The viewer must first see that it is a whole document (masthead, columns, edges). |
| 4 | DETAIL (of #3, region `headline`) | **DETAIL**: the curated headline takes the frame, the rest of the page is dimmed but its edges stay visible | `fixture-only:gazette` (same file; `verified_evidence_reuse`) | The narration says "its headline put the event in plain words". The hard cut WIDE → DETAIL is the reveal. |
| 5 | GEOGRAPHY | **WIDE**, the curated SVG revealing its single route line, then its label | `fixture-only:schematic` | "The report traced a single route": draw only the line that already exists in the curated SVG. |

The boundary between the two sequences is the only dissolve (short). Every other
change is a hard cut.

## What this board does NOT do

- It is not a WIDE→MEDIUM→DETAIL rotation. S1 has no DETAIL and S2 has no MEDIUM, because neither narration asks for it.
- No new asset appears in AFTER. BEFORE renders the same script, the same four files and the same narration timing through the current v4 path.
- No region comes from OCR, a model, a filename or alt text. `headline` and `subject` are curated fixture metadata.
