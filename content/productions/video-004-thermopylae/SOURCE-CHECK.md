# Video #004 — Final source check before the first paid call (2026-10-01)

Run from a GitHub runner (workflow `video-004-source-check.yml`, run 36815641096-series; this production
environment cannot reach the publishers). Read-only; no provider was called. This file sits outside the
frozen package (freeze 916059ce) so the check could be recorded without re-freezing.

Texts opened: Herodotus Book 7 in Macaulay's translation (Project Gutenberg #2456, full text, 856 KB) and in
Godley's translation at Perseus (chapters 35, 61, 83, 176, 185, 205, 208–213, 215, 217–220, 222–226, 233, 238);
Pausanias 3.14.1 (Perseus and the theoi mirror); Plutarch, *Sayings of Spartans* 225D (LacusCurtius).
Perseus returned 503 for Herodotus 7.228, Thucydides 5.71 and Plutarch; the connection to Xenophon was reset.

| Narrated claim | Passage opened | Result |
| --- | --- | --- |
| Four days' wait; fifth day Medes and Cissians, "take them prisoner"; "many people, few real men" | Hdt 7.210 | PASS |
| Immortals under Hydarnes; shorter spears, no use of numbers in the narrow; feigned flight | Hdt 7.211 | PASS |
| King jumped up three times from the throne | Hdt 7.212 | PASS |
| Day two: relays, Greeks by nation in turn, Phocians on the path | Hdt 7.212 | PASS |
| Ephialtes son of Eurydemus, a Malian (Trachis is the chief town of Malis) | Hdt 7.213 | PASS (qualified: "from Trachis" is the usual modern form; Herodotus says "a Malian") |
| Lamp-lighting departure; all night; oak forest; noise of trodden leaves; arrows; Phocians to the summit | Hdt 7.215, 7.217, 7.218 | PASS |
| Deserters by night, watchers running down at dawn; divided council | Hdt 7.219 | PASS |
| Leonidas sent the allies away; the oracle: city destroyed or king killed | Hdt 7.220 | PASS |
| Thespians stayed willingly under Demophilus son of Diadromes; Thebans stayed (Herodotus: as hostages) | Hdt 7.222 | PASS; the hostage claim is not narrated and the on-screen note says Theban sources differ |
| Libations at sunrise, assault at mid-morning; Greeks advanced into the wider part of the pass | Hdt 7.223 | PASS |
| Spears broken, swords; Leonidas fell | Hdt 7.224 | PASS |
| Struggle over the body, enemy routed four times; withdrawal behind the wall to the hill; hands and teeth; buried in missiles | Hdt 7.225 | PASS |
| Dienekes: arrows hide the sun, fight in the shade | Hdt 7.226 | PASS |
| Thebans surrendered and were branded with the royal marks | Hdt 7.233 | PASS |
| Leonidas's head cut off and his body impaled | Hdt 7.238 | PASS (qualified): Macaulay "cut off his head and crucify him"; Godley "cut off his head and impale it". The Greek ἀνασταυρῶσαι is read either way; the script follows Macaulay and Cartledge ("decapitated and crucified"). Herodotus's remark that Persians honour brave enemies is in the same chapter. |
| Three hundred lashes for the Hellespont; bridge overseers beheaded | Hdt 7.35 | PASS |
| Persian kit: tiaras, sleeved tunics, iron scales like fish, trousers, wicker shields, short spears, large bows, daggers | Hdt 7.61 | PASS |
| Immortals: ten thousand, replaced at once | Hdt 7.83 | PASS |
| Pass fifty feet at its narrowest, a single cart-way at Alpeni and the Phoenix; hot springs; the Phocian wall | Hdt 7.176 | PASS |
| 2,641,610 fighting men | Hdt 7.185 | PASS |
| Three hundred, all with living sons; Carneia; Olympic festival | Hdt 7.205–206 | PASS |
| Mounted scout; exercising and combing hair; Demaratus's explanation | Hdt 7.208–209 | PASS |
| Contingents (Tegea 500, Mantinea 500, Corinth 400, Phlius 200, Mycenae 80, Thespiae 700, Thebes 400, Phocis 1,000, Opuntian Locrians) | Hdt 7.202–203 (Macaulay) | PASS |
| Leonidas's bones brought from Thermopylae forty years after the battle; annual contest | Pausanias 3.14.1 | PASS |
| "Come and take them" is Plutarch, not Herodotus | Plutarch, Sayings of Spartans, Leonidas 11 (225D) | PASS |
| Simonides epitaph wording | Hdt 7.228 | NOT RE-OPENED (Perseus 503); the Greek text and the standard translation are as given in RESEARCH.md F5; a human should open 7.228 before publication |
| Shield coverage of the neighbour (Thuc. 5.71), crimson cloaks (Xen. Lac. Pol. 11.3) | not reachable in this run | NOT RE-OPENED; both are standard and cited in VERIFICATION.md |

Result: no narrated sentence contradicts the primary text. Production proceeds to narration.
