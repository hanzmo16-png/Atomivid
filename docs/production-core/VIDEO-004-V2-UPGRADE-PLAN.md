# VIDEO-004 Thermopylae — V2 upgrade plan (zero-spend audit)

Status: **THERMOPYLAE_V2_COST_AUTHORIZATION_REQUIRED**. Nothing generated, nothing rendered, nothing spent.
Base: master `d9101587…b8510` (run 36821933646), frozen package 916059ce / commit c227517, cost to date USD 11.3295.
The frozen storyboard is untouched; every change below is an override in `content/productions/video-004-thermopylae/v2/storyboard-delta.json`.

Design principle added for this episode and proposed for the policy: **NARRATION DESCRIBES ACTION → VISUAL SHOWS ACTION.**
Quality per dollar beats lowest absolute cost; a still with a camera move is never the default for action.

## 1. Audit of the 99 shots (from the rendered timeline)

Current master: 736 s. Real motion today = AI clips 91 s + stock 189 s = 280 s (38%); graphics with a soft push-in 160 s (22%); stills with Ken Burns/parallax 296 s (40%).

Classes: KEEP 34 · SOUND_DESIGN_ONLY 19 · ENHANCE_FREE 9 · REPLACE_WITH_GRAPHICS 16 (all animated, USD 0) · REPLACE_WITH_AI_MOTION 21 (13 in scenario B, 8 more in C) · REPLACE_WITH_BETTER_STILL 0 (every approved still is reused as the motion base).

| Shot | Scene | Now | s | Purpose | Class | Scen. | USD | Treatment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V4-001 | S1 | clip | 3.5 | hook: late summer | SOUND_DESIGN_ONLY | - | 0 | wind, gentle surf, one distant shield knock; clip stays |
| V4-002 | S1 | clip | 2.9 | hook: a strip of shore | KEEP | - | 0 | clip stays; surf and steam hiss |
| V4-003 | S1 | stock | 2.5 | hook: no wider than a road | KEEP | - | 0 | stock stays |
| V4-004 | S1 | still | 2.0 | hook: coming down the coast | ENHANCE_FREE | - | 0 | free: faster tilt-up + procedural dust haze overlay (ffmpeg noise/blur composite) + first footstep swell; 2.0 s only |
| V4-005 | S1 | clip | 3.4 | hook: the host | SOUND_DESIGN_ONLY | - | 0 | clip stays; thousands of footsteps rising, horses, carts |
| V4-006 | S1 | still | 6.1 | hook: the Greeks waiting | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion from the approved still: helmets turn a few degrees, cloaks and crests move in wind, dust drifts past; no new figures |
| V4-007 | S1 | still | 3.6 | hook: the pass held | SOUND_DESIGN_ONLY | - | 0 | macro shield rim stays; wood creak + leather + breathing, music dips |
| V4-008 | S1 | stock | 4.3 | hook: the goat path | KEEP | - | 0 | stock stays; wind |
| V4-009 | S1 | clip | 3.9 | hook: the low hill | SOUND_DESIGN_ONLY | - | 0 | clip stays; wind, a single far-off crow, music low |
| V4-010 | S1 | still | 4.3 | hook: around him | SOUND_DESIGN_ONLY | - | 0 | tilt-down stays; silence then low drone |
| V4-011 | S1 | stock | 5.8 | hook: harder story | KEEP | - | 0 | surf stock stays |
| V4-012 | S1 | stock | 7.2 | hook: this is Thermopylae | ENHANCE_FREE | - | 0 | free: animated title (letters track in, thin rule draws) instead of a static card; notice moved off the hook |
| V4-013 | S2 | stock | 7.3 | Marathon | KEEP | - | 0 | Marathon beach stock stays; free inset mini-map pin "Marathon, 490 BC" fades in |
| V4-014 | S2 | still | 5.3 | Persepolis | ENHANCE_FREE | - | 0 | free: slow light sweep (animated gradient mask) across the relief instead of a pan |
| V4-015 | S2 | still | 6.6 | Xerxes | KEEP | - | 0 | ruins still stays (ken burns) |
| V4-016 | S2 | graphic | 10.4 | route map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: route draws Sardis→Hellespont→Doriscus→Athos→Therma→Thermopylae as the words arrive; depot and canal labels appear on "grain" and "canal"; camera follows |
| V4-017 | S2 | clip | 8.2 | the bridges | SOUND_DESIGN_ONLY | - | 0 | bridges clip stays; creaking timber, water, hooves on planks |
| V4-018 | S2 | stock | 7.9 | the sea whipped | KEEP | - | 0 | storm stock stays; whip crack synthesized x3 under "whipped" (optional) |
| V4-019 | S2 | graphic | 13.6 | numbers | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED CHART: Herodotus bar grows with a counter to 2,641,610; modern bar appears on "Modern historians"; fleet bars on "fleet" |
| V4-020 | S2 | still | 4.1 | even the low figure | ENHANCE_FREE | - | 0 | free: smoke/haze drift overlay on the camp still |
| V4-021 | S2 | still | 9.8 | earth and water | ENHANCE_FREE | - | 0 | free: split into two camera moves (push on the bowl, then rack to the jar); water pour sound |
| V4-022 | S3 | stock | 5.3 | not a nation | KEEP | - | 0 | ruins stock stays |
| V4-023 | S3 | graphic | 8.8 | league map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: resisting cities light up one by one, Corinth pulses on "Corinth", submitted cities dim in purple |
| V4-024 | S3 | stock | 2.8 | Sparta | KEEP | - | 0 | Taygetus stock stays |
| V4-025 | S3 | still | 7.2 | the two hundred ships | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion: shipwrights as tiny figures, sea moving, timber dust |
| V4-026 | S3 | graphic | 15.2 | the plan | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: army arrow advances to Thermopylae, fleet arrow to Artemisium, two bronze bars snap in on "block"; "60 km" label on "beside it" |
| V4-027 | S3 | stock | 8.4 | the Carneia | KEEP | - | 0 | temple stock stays; distant festival drums (low) |
| V4-028 | S3 | still | 8.5 | Leonidas | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion of the Leonidas still: cloak and hair in wind, column behind shifts its weight; no face |
| V4-029 | S3 | still | 9.4 | living sons | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion of the boy still: the column walks away down the street; the boy stays |
| V4-030 | S3 | graphic | 21.0 | allies map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP (21 s): each contingent marker pops in with its number as it is named (Tegea, Mantinea, Corinth, Phlius, Mycenae, Thespiae, Thebes, Phocis, Locris); the route line draws north; camera zooms from the Peloponnese to the pass |
| V4-031 | S3 | still | 8.6 | seven thousand | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: the column winds along the road, mules, dust; seen from the ridge |
| V4-032 | S4 | stock | 7.7 | the hot springs | KEEP | - | 0 | hot springs stock stays; hiss |
| V4-033 | S4 | graphic | 5.0 | pass map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: the 480 BC sea fills in against the cliff, the three gates light up in turn, the wall snaps in |
| V4-034 | S4 | still | 8.2 | a cart's width | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion: ground-level dolly along the pass, surf, soldiers walking ahead |
| V4-035 | S4 | stock | 8.0 | the highway | KEEP | - | 0 | highway stock stays |
| V4-036 | S4 | still | 8.0 | the wall | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion: cooking smoke rises behind the wall, figures move, sea lapping |
| V4-037 | S4 | still | 4.6 | hoplites | KEEP | - | 0 | resting hoplites still stays; camp sounds |
| V4-038 | S4 | graphic | 19.4 | hoplite kit | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED KIT (19 s): each item draws/highlights exactly when named: shield → spear → sword → helmet → armour → greaves; the rest dims |
| V4-039 | S4 | still | 10.2 | crimson cloaks | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: Spartan from behind, cloak and braids in the wind, shield still |
| V4-040 | S4 | graphic | 10.2 | phalanx diagram | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED DIAGRAM: ranks fill in one by one on "ranks", shields slide to overlap on "each shield", spears lower on "levelled" |
| V4-041 | S4 | graphic | 7.7 | no flank | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED DIAGRAM: in the open the purple mass flows around the flanks; in the pass it piles up against the front and stops |
| V4-042 | S4 | still | 16.7 | Persian kit | REPLACE_WITH_GRAPHICS | - | 0 | free: keep the flat-lay still as background; animated callout dots and short labels appear on each item as named (felt cap, tunic, scales, trousers, wicker shield, spears, daggers, bows); two camera moves instead of one 16.7 s pan |
| V4-043 | S4 | still | 10.4 | the Immortals | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: the block of Immortals marches at parade pace, wicker shields swaying |
| V4-044 | S4 | still | 8.0 | different war | SOUND_DESIGN_ONLY | - | 0 | equipment still stays; leather, wicker creak, bowstring |
| V4-045 | S5 | stock | 6.0 | Xerxes waits | KEEP | - | 0 | sunset stock stays; camp at dusk ambience |
| V4-046 | S5 | stock | 3.5 | the horseman | KEEP | - | 0 | horseman stock stays; hooves, wind |
| V4-047 | S5 | still | 14.5 | combing hair | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion (risky: hands): men in camp, combing and oiling; keep as C with a strict back-view prompt |
| V4-048 | S5 | still | 7.1 | the Medes | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: the Median column advances along the shore toward the wall |
| V4-049 | S5 | clip | 3.9 | the assault on the wall | SOUND_DESIGN_ONLY | - | 0 | assault clip stays; crowd roar, shield impacts, music drop before contact |
| V4-050 | S5 | still | 4.0 | short spears against long | REPLACE_WITH_AI_MOTION | B | 0.25 | AI motion: low angle, spear hedge sways, wicker shields push, dust |
| V4-051 | S5 | still | 3.3 | only the front | KEEP | - | 0 | from-the-cliff still stays (3.3 s) |
| V4-052 | S5 | still | 10.9 | few soldiers | ENHANCE_FREE | - | 0 | free: dust drift overlay on the empty platform; the king's absence reads better in silence (music out) |
| V4-053 | S5 | clip | 9.7 | feigned flight | SOUND_DESIGN_ONLY | - | 0 | clip stays; shouting crowd rush, then turn |
| V4-054 | S5 | clip | 10.8 | the wheel | SOUND_DESIGN_ONLY | - | 0 | clip stays; impact layer on "wheel", king rising = music stab |
| V4-055 | S5 | still | 14.4 | the shade | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion retry with a materially different prompt (the v1 clip degraded into noise): shadow sweeps across the shields, a sparse flight of arrows |
| V4-056 | S6 | still | 9.4 | relays | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion: fresh contingent files forward past a resting one |
| V4-057 | S6 | still | 10.1 | Ephialtes | ENHANCE_FREE | - | 0 | free: lamp flicker overlay (animated warm vignette) on the camp still |
| V4-058 | S6 | graphic | 10.4 | Anopaea map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: the Anopaea path draws itself over the ridge through the night; Immortals markers climb it; the Phocian marker appears on "posted" |
| V4-059 | S6 | stock | 5.8 | the Phocian post | KEEP | - | 0 | forest ridge stock stays |
| V4-060 | S6 | clip | 7.4 | night march | SOUND_DESIGN_ONLY | - | 0 | night march clip stays; footsteps on leaves, owls, torches |
| V4-061 | S6 | stock | 3.9 | all night | KEEP | - | 0 | moon stock stays |
| V4-062 | S6 | clip | 10.2 | footsteps on leaves | SOUND_DESIGN_ONLY | - | 0 | clip stays; leaves, sudden silence, then arrows |
| V4-063 | S6 | still | 6.8 | the Phocians withdraw | REPLACE_WITH_AI_MOTION | C | 0.50 | AI motion: Phocians withdraw up the hill, arrows fall |
| V4-064 | S6 | stock | 6.3 | down toward the pass | KEEP | - | 0 | descent aerial stock stays |
| V4-065 | S7 | stock | 6.1 | the Greeks knew | KEEP | - | 0 | embers stock stays; running footsteps approaching |
| V4-066 | S7 | still | 6.4 | nobody recorded | SOUND_DESIGN_ONLY | - | 0 | council still stays; silence, wind, embers |
| V4-067 | S7 | still | 6.0 | the allies leave | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: the allied column marches away east along the shore |
| V4-068 | S7 | still | 9.7 | the Thespians | SOUND_DESIGN_ONLY | - | 0 | Thespians still stays (strong frame); surf, no music for 3 s |
| V4-069 | S7 | stock | 7.6 | the oracle | KEEP | - | 0 | Delphi stock stays |
| V4-070 | S7 | graphic | 10.9 | the road south | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: the retreat road draws south while the fleet line draws to Salamis; an hours counter on "hours" |
| V4-071 | S7 | still | 3.3 | mid-morning | REPLACE_WITH_AI_MOTION | B | 0.25 | AI motion: the host forms up, standards moving |
| V4-072 | S7 | still | 3.2 | not behind the wall | KEEP | - | 0 | gap in the wall still stays (3.2 s) |
| V4-073 | S7 | clip | 9.5 | into the open | SOUND_DESIGN_ONLY | - | 0 | hero clip stays; music out, footsteps and breathing only, then impact |
| V4-074 | S7 | still | 4.3 | swords | SOUND_DESIGN_ONLY | - | 0 | broken spear still stays; wood snap |
| V4-075 | S7 | still | 4.7 | Leonidas fell | SOUND_DESIGN_ONLY | - | 0 | helmet still stays; total silence 1.5 s then wind |
| V4-076 | S7 | clip | 6.7 | fought over | SOUND_DESIGN_ONLY | - | 0 | clip stays; crowd heave, metal |
| V4-077 | S7 | still | 3.3 | the rear | REPLACE_WITH_AI_MOTION | B | 0.25 | AI motion: Persian column emerges from the forest onto the shore |
| V4-078 | S7 | clip | 11.4 | the hill | SOUND_DESIGN_ONLY | - | 0 | hill clip stays; distant roar, then quiet |
| V4-079 | S7 | still | 5.0 | buried in arrows | REPLACE_WITH_AI_MOTION | B | 0.25 | AI motion: volleys arc onto the mound (simple prompt, few arrows) |
| V4-080 | S7 | stock | 7.2 | Marinatos | KEEP | - | 0 | trowel stock stays |
| V4-081 | S7 | graphic | 4.8 | arrowheads | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED: the six arrowheads fade in one after another; count ticks up |
| V4-082 | S7 | still | 10.1 | the Thebans | ENHANCE_FREE | - | 0 | free: slower, longer push instead of a pan; the Theban note stays |
| V4-083 | S7 | stock | 11.9 | Xerxes's order | KEEP | - | 0 | waves stock stays; wind only, music low |
| V4-084 | S8 | graphic | 7.1 | Artemisium map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: fleet lines appear, the gulf sightline draws between pass and Artemisium |
| V4-085 | S8 | stock | 5.2 | the storm | KEEP | - | 0 | storm stock stays |
| V4-086 | S8 | stock | 5.1 | withdraw in the night | KEEP | - | 0 | moon sea stock stays; oars |
| V4-087 | S8 | stock | 5.3 | Athens empties | KEEP | - | 0 | Athens aerial stock stays |
| V4-088 | S8 | still | 3.7 | the Acropolis burns | REPLACE_WITH_AI_MOTION | C | 0.25 | AI motion: smoke columns rise from the citadel |
| V4-089 | S8 | still | 6.7 | Salamis | REPLACE_WITH_AI_MOTION | B | 0.50 | AI motion: triremes close in the strait, oars churning |
| V4-090 | S8 | graphic | 2.0 | Plataea map | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED MAP: Xerxes's return line draws to the Hellespont (2 s) |
| V4-091 | S8 | stock | 7.3 | Plataea | KEEP | - | 0 | plain stock stays |
| V4-092 | S8 | stock | 9.4 | did it matter | KEEP | - | 0 | cliffs stock stays |
| V4-093 | S8 | stock | 9.0 | resistance | KEEP | - | 0 | islands stock stays |
| V4-094 | S9 | graphic | 11.9 | the epitaph | REPLACE_WITH_GRAPHICS | - | 0 | ANIMATED CARD: Greek lines fade in, English lines appear with the narration; stone texture breathes |
| V4-095 | S9 | stock | 8.6 | Plutarch | KEEP | - | 0 | manuscript stock stays |
| V4-096 | S9 | stock | 8.5 | bones home | KEEP | - | 0 | olive groves stock stays |
| V4-097 | S9 | stock | 4.6 | the sea has gone | KEEP | - | 0 | plain sunset stock stays |
| V4-098 | S9 | still | 7.8 | still in it | ENHANCE_FREE | - | 0 | free: slow push instead of static framing; wind |
| V4-099 | S9 | graphic | 1.5 | end card | KEEP | - | 0 | end card |

## 2. Exact lists

- **KEEP (as is):** V4-002, V4-003, V4-008, V4-011, V4-013, V4-015, V4-018, V4-022, V4-024, V4-027, V4-032, V4-035, V4-037, V4-045, V4-046, V4-051, V4-059, V4-061, V4-064, V4-065, V4-069, V4-072, V4-080, V4-083, V4-085, V4-086, V4-087, V4-091, V4-092, V4-093, V4-095, V4-096, V4-097, V4-099
- **SOUND_DESIGN_ONLY (picture kept, new audio layer):** V4-001, V4-005, V4-007, V4-009, V4-010, V4-017, V4-044, V4-049, V4-053, V4-054, V4-060, V4-062, V4-066, V4-068, V4-073, V4-074, V4-075, V4-076, V4-078
- **ENHANCE_FREE:** V4-004, V4-012, V4-014, V4-020, V4-021, V4-052, V4-057, V4-082, V4-098
- **REPLACE_WITH_GRAPHICS (animated, USD 0):** V4-016, V4-019, V4-023, V4-026, V4-030, V4-033, V4-038, V4-040, V4-041, V4-042, V4-058, V4-070, V4-081, V4-084, V4-090, V4-094
- **REPLACE_WITH_AI_MOTION, scenario B (13 clips):** V4-006, V4-028, V4-031, V4-039, V4-043, V4-048, V4-050, V4-055, V4-067, V4-071, V4-077, V4-079, V4-089
- **REPLACE_WITH_AI_MOTION, scenario C adds (8 clips):** V4-025, V4-029, V4-034, V4-036, V4-047, V4-056, V4-063, V4-088

## 3. Animated maps and graphics (USD 0)

All 16 graphics become word-synchronised animations rendered by the existing pipeline: `graphics.ts` gains a `frame(kind, t, cues)` variant that returns the SVG for time *t*; `render.ts` renders one PNG per frame (30 fps, sharp) driven by the slot's narration word timings (already in the narration records) and concatenates them with FFmpeg. No new library, no API. Estimated runner time: ~12 min for ~4,800 frames.

| Shot | Map / graphic | Animation (synchronised to the exact words) |
| --- | --- | --- |
| V4-016 | Persian route | Route line draws Sardis → Hellespont → Doriscus → Athos → Therma → Thermopylae; purple army markers advance along it; "grain depots" pins appear on *stockpiled grain*, the canal cut appears on *canal*; camera pans with the head of the column; Thermopylae pulses red as the markers approach |
| V4-019 | Numbers | Herodotus bar grows with a live counter to 2,641,610 on *two million*; modern bar and range appear on *Modern historians*; fleet bars on *fleet* |
| V4-023 | League | Resisting cities light up one by one; Corinth pulses on *Corinth*; submitted cities dim purple on *barely* |
| V4-026 | The plan | Army arrow advances to Thermopylae on *land road*, fleet arrow to Artemisium on *sea beside it*; bronze "block" bars snap in on each *Block*; "60 km" label on *support each other* |
| V4-030 | Allies (21 s) | Each contingent marker pops in with its number exactly when named (Tegea, Mantinea, Corinth, Phlius, Mycenae, Thespiae 700, Thebes 400, Phocis, Locris); the muster line draws north; camera zooms from the Peloponnese to the pass on *beyond the pass* |
| V4-033 | The pass | The 480 BC sea floods in against the cliff on *came right up*; west/middle/east gates light in turn; the wall snaps in |
| V4-038 | Hoplite kit (19 s) | Each item draws in and the rest dims exactly as named: shield → spear (head, butt-spike) → sword → helmet → armour → greaves |
| V4-040 | Phalanx | Ranks fill in on *ranks*, shields slide to overlap on *each shield*, spears lower on *levelled* |
| V4-041 | No flank | In the open the purple mass flows around both flanks on *flank*; in the corridor it piles against the front and stops on *no flank* |
| V4-042 | Persian kit (still) | Still kept as background; callout dots and labels appear as each item is named; two camera moves instead of a 16.7 s pan |
| V4-058 | Anopaea | Path draws over the ridge through a night palette; Immortal markers climb it; Phocian marker appears on *posted* |
| V4-070 | Road south | Retreat road draws south on *get clear*; fleet line draws to Salamis on *Artemisium*; an hours counter on *long enough* |
| V4-081 | Arrowheads | Heads fade in one after another; counter ticks on *hundreds* |
| V4-084 | Artemisium | Fleet lines appear; sightline draws across the gulf on *in sight of the pass* |
| V4-090 | Plataea (2 s) | Return line draws to the Hellespont on *went home* |
| V4-094 | Epitaph | Greek lines fade in first; English appears with the narration; stone texture breathes |

Result: a viewer can follow the strategy on the map (two Persian arms, two Greek blocks, the path that turned the position) without reading anything that is not being said.

## 4. Sound design plan by sequence (target USD 0)

Narration and the music bed stay. A new SFX stem is added under the existing sidechain. Two sources, in order: (1) **procedural** sounds synthesised in FFmpeg (filtered noise, pulses, sweeps: wind, sea, fire crackle, footstep mass, leather/wood creaks, arrow whoosh, impact thuds, crowd roar bed); (2) **CC0 recordings** from Freesound through its free API (needs a free API key in the repo secrets; no cost) for the few sounds procedural audio does poorly: metal-on-metal, horses, individual war cries. Nothing from paid libraries.

| Sequence | Design (dynamic, not a wall) |
| --- | --- |
| S1 hook 0:00–0:50 | Wind + gentle surf under the shield wall; one distant shield knock at second 0; footstep mass swells under *Coming down the coast* and peaks on the host; cloth and leather on the Greeks; silence drop (music −6 dB, no SFX) on *the pass held*; crow and wind on the hill; surf returns under the title |
| S2 the king | Camp and horse ambience on the plain; timber creak, water and hooves on the bridges; three whip cracks under *whipped*; crowd murmur under the numbers chart |
| S3 the Greeks | Marble wind in the ruins; shipyard adze/saw under the triremes; distant drums under the Carneia; a single horse snort at the gate; marching column with mule bells; sound builds toward the pass |
| S4 the gates | Spring hiss; surf against the cliff; camp fires behind the wall; leather and bronze when the kit is named (one accent per item, timed to the animation); wicker creak and bowstring on the Persian kit; the Immortals' step in unison |
| S5 day one | Dusk camp; hooves for the scout; comb and oil, quiet; music drops for 1.5 s before the assault, then crowd roar + shield impacts; spear hedge rattle; silence on the empty platform; feigned flight = shouting rush, then the turn = one impact hit and the music stab on *leapt up*; arrows = whoosh bed and shaft impacts, then quiet under *the shade* |
| S6 the path | Relays = shields set down; lamplit camp, tent canvas; night march = leaves, breathing, owls, torches; the moon = almost nothing; dawn = leaves crushed, sudden silence, then arrows; retreat uphill |
| S7 day three | Running footsteps toward the embers; silence at the council (wind + embers only); allies' column fading east; surf under the Thespians with the music out for 3 s; host forming = drums and standards; **into the open = music out, footsteps and breathing only, then the impact** on the first spear contact; wood snap on the broken spears; 1.5 s of total silence on the fallen helmet; heave and metal over the body; Persians emerging from the forest; the hill = distant roar then quiet; arrows = sparse whoosh; trowel scrape; branding iron hiss avoided (no gore), wind on the Theban note; wind only over the king's order |
| S8 after | Oars and sea; storm; night oars; distant city; smoke crackle; Salamis = oar strokes in rhythm then a hull impact; plain wind; islands wind |
| S9 the stone | Wind only, then nothing but the narration on the epitaph; quiet page turn; olive leaves; evening insects; wind on the hill; silence into the end card |

Mix rules: SFX stem ducked by narration like the bed; peaks never above −6 dBTP before mastering; at least four intentional silences (second 0, *the pass held*, the fallen helmet, the epitaph).

## 5. First 60 seconds: specific improvements

| Time | Now | V2 |
| --- | --- | --- |
| 0:00–0:04 | AI clip + the long on-screen notice across the hook | Notice moved to the title slot (0:43) in a smaller lower line; the hook opens clean; wind + one shield knock |
| 0:09–0:11 | 2 s dust still, tilt-up | Faster tilt + procedural dust haze; footstep swell begins (free) |
| 0:15–0:21 | 6.1 s still of the waiting Greeks, push-in | **AI motion** of the same still: crests and cloaks in wind, helmets turn (B) |
| 0:21–0:24 | Shield-rim macro | Kept; wood creak and breathing; music dips (free) |
| 0:29–0:37 | Hill clip + helmet-on-spear tilt | Kept; crow, wind, low drone (free) |
| 0:37–0:50 | Waves + 7.2 s sunrise with a static title | Animated title reveal; the notice sits under it; surf under (free) |
| 0:50–1:00 | Marathon beach 7.3 s | Mini-map pin "Marathon, 490 BC" fades in (free) |
| 1:00–2:00 | 12 s of two relief/ruin stills, a static route map 10 s, a static chart 14 s, 10 s on a bowl of earth | Light sweep on the relief; **animated route map** with the army advancing; **animated numbers**; the bowl split into two moves with the water pour; the camp still gets a smoke drift |

Net effect in the first minute: motion in 54 of 60 s (today 36 of 60 s), one still over 5 s instead of three.

## 6. Scenarios (no execution)

| | A — Free optimisation | B — Efficient cinematic | C — Premium cinematic |
| --- | --- | --- | --- |
| AI motion clips (new) | 0 | 13 | 21 |
| AI motion cost | 0 | 5.50 | 9.25 |
| Retry allowance (15%, frozen policy: one materially different attempt) | 0 | 0.82 | 1.39 |
| Still replacements | 0 | 0 | 0.14 (2 heroic recompositions: V4-047, V4-034) |
| Sound design | 0 | 0 | 0 |
| Animated graphics (16) | 0 | 0 | 0 |
| **Additional cost** | **0.00** | **6.32** | **10.78** |
| **Projected total** | **11.33** | **17.65** | **22.11** |
| Significant motion after upgrade | 455 s (62%) | 549 s (75%) | 616 s (84%) |
| Longest still run | 16.7 s → 8.5 s | 8.5 s | 6.4 s |

What the viewer actually sees:
- **A:** every map and diagram moves with the words (the strategy becomes legible), the title and hook are cleaner, the whole film gains a sound layer with real dynamics, and the stills that remain get varied moves. The battle beats keep today's 13 clips. It still has 13 action sentences on photographs (the waiting Greeks, Leonidas at the gate, the column marching north, the Spartan on the shore, the Immortals, the Medes, the spear hedge, the shade, the allies leaving, the host forming, the Persians emerging, the arrows on the mound, Salamis).
- **B:** those 13 action sentences move. Every "army advances / column marches / formation forms / arrows fall / fleet closes" line now shows the action; the king and the Spartan breathe in wind instead of being frozen. Cost USD 6.32, inside your USD 15–18 target. Recommended.
- **C:** B plus eight atmospheric moments (shipyard, the boy at the door, the pass track, smoke behind the wall, the camp, relays, the Phocians uphill, the burning Acropolis) and two recomposed stills. More motion in quieter beats, diminishing returns per dollar, and it crosses USD 20.

## 7. Assets reused and assets needed

Reused (USD 11.33 already paid): all 9 narration files and word timings; all 54 approved stills (13 or 21 of them become motion bases at no extra cost); 13 approved clips; 29 stock clips; the music bed and sections; subtitles; the timeline; research, script and freeze; the 1080p master as reference.
New: 13 (B) or 21 (C) Runway clips; 16 animated graphic frame sequences (free); one procedural SFX stem plus optional CC0 recordings (free); a re-render of the master (free). Engine note: the frozen PI V1.1 profile caps generated motion at 76 s for this runtime; B and C exceed it, so the delta runs as operator-authorised exceptions in the video-004 production scripts, logged in the ledger as such, until the WARFARE policy below exists.

## 8. Order of work once a scenario is authorised

1. Build the animated-graphics renderer and the SFX stem (free) and prove them in a draft render.
2. Generate the authorised clips (reserve-before-call, cap enforced), review them temporally, retry only under the frozen rule.
3. Re-render, QA (17 technical checks + the new motion-share and silence-placement checks), review sheets, new review proxy.
