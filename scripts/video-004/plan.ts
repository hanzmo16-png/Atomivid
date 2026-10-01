/** Video #004 production plan: per-shot production notes layered on the FROZEN storyboard
 * (content/productions/video-004-thermopylae, freeze 916059ce…). Nothing here changes a shot's
 * duration, narration, method or provider; it only says HOW each frozen shot is sourced:
 * stock search terms, the still-image style bible, image-to-video motion prompts for the fourteen
 * generative shots chosen by the deterministic plan, diagram specs, music and on-screen text.
 */

/** Authorized freeze (commit c227517). The runner refuses any other package. */
export const AUTHORIZED_FREEZE_HASH = '916059ce129bb1bc3095c1397f2805d75b1ff28bccb816f9afb4f33c4fdc443c';
export const AUTHORIZED_ENGINE_TREE = 'fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef';
/** Hard cap authorized for the project (USD): the exposure ceiling that stops production IS the cap. */
export const HARD_CAP_USD = 20;
export const EXPOSURE_CEILING_USD = 20;
export const EXPECTED_USD = 11.23;
export const PROVIDER_CEILING_USD: Record<string, number> = { elevenlabs: 5, openai: 10, runway: 8, pexels: 0 };
export const GENERATIVE_COUNT = 14;

export const PROJECT = 'video-004-thermopylae';
export const TITLE = 'Three Days at the Hot Gates';
export const CHANNEL = 'EARTHWARD CHRONICLES';

// ---------------- voice ----------------
/** David (Audiobook & Documentary), already on the account. */
export const VOICE = { voiceId: 'cCYjmrGZaI86GUJ7F2Nn', publicOwnerId: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', name: 'David - Audiobook & Documentary' };
export const MODEL = 'eleven_multilingual_v2';
export const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.92 };
/** Pronunciation aliases (each alias is ONE token so the alignment keeps the script's word count). */
export const ALIASES: [string, string][] = [
  ['Thermopylae', 'Ther-MOP-ih-lee'], ['Leonidas', 'Lee-ON-ih-dass'], ['Xerxes', 'ZERK-seez'], ['Anopaea', 'An-oh-PEE-ah'], ['Ephialtes', 'Eff-ee-AL-teez'],
  ['Hydarnes', 'Hy-DAR-neez'], ['Demaratus', 'Dem-ah-RAY-tuss'], ['Dienekes', 'Dy-EN-eh-keez'], ['Demophilus', 'Dem-OFF-ih-luss'], ['Thespians', 'THESS-pee-ans'],
  ['Thespiae', 'THESS-pee-ee'], ['Artemisium', 'Ar-teh-MIZZ-ee-um'], ['Plataea', 'Pla-TEE-ah'], ['Marinatos', 'Mar-ee-NAH-toss'], ['Simonides', 'Sy-MON-ih-deez'],
  ['Carneia', 'Car-NAY-ah'], ['Phlius', 'FLY-uss'], ['Tegea', 'TEJ-ee-ah'], ['Mantinea', 'Man-tin-EE-ah'], ['Mycenae', 'My-SEE-nee'], ['Phocians', 'FOH-shans'],
  ['Locrians', 'LOH-kree-ans'], ['Trachis', 'TRAY-kiss'], ['Cissians', 'SISS-ee-ans'], ['Hellespont', 'HELL-ess-pont'],
];
/** COGS of ElevenLabs characters: marginal price of the owner's top-up (USD 5 for 25,000 credits). */
export const XI_USD_PER_CHAR = 5 / 25000;

// ---------------- stills ----------------
export const IMAGE_MAX_USD = 0.30;
export const STYLE = 'Photorealistic historical documentary cinematography of 480 BC Greece, 16:9 widescreen, natural light, restrained cinematic colour grade, fine film grain, dust and haze. Historical realism only: Greek hoplites wear bronze Corinthian helmets, bronze or layered-linen body armour, bronze greaves, round wooden shields faced with plain bronze, long thrusting spears, short swords, tunics and cloaks (Spartans in crimson cloaks, long hair); Persian infantry wear soft felt caps, sleeved patterned tunics, trousers, iron scale corselets, tall wicker shields, short spears, large bows and quivers. Nothing like the film 300: no bare chests, no capes-only costumes, no lambda shield emblems, no monsters, no exaggerated muscles, no fantasy armour, no slow-motion poses. No blood, wounds, corpses or injured people or animals. Faces never recognisable (figures distant, turned away, or helmeted). Absolutely no text, letters, captions, logos or watermarks. Single frame, not a collage.';
export const STILL_NOTES: Record<string, string> = {
  // Fallback stills for stock shots whose footage failed review (described here alone):
  'V4-004': 'A long dust cloud rising over a dry coastal plain at dawn, mountains behind, the first marching columns as tiny dark lines on the horizon; no close detail, no people near the camera.',
  'V4-012': 'Sunrise over a calm sea gulf seen from a mountain ridge in Greece; long shadows; steam from springs at the cliff foot far below; no people.',
  'V4-014': 'A carved stone relief of robed figures in procession in the Achaemenid Persian style (long pleated robes, rounded beards, lotus flowers), raking light; reconstruction, not a photograph of a real monument; no people.',
  'V4-015': 'Ruined stone columns and a monumental stairway of an Achaemenid Persian palace at sunset, dry plain beyond; no people.',
  'V4-021': 'A bronze bowl of earth and a clay jar of water set side by side on a stone threshold at a city gate, warm light; no people.',
  'V4-037': 'Three hoplites seen from the side resting at a camp by a low stone wall, shields leaning, helmets pushed back, faces turned away; late light.',
  'V4-044': 'Close on a Persian wicker shield, a short spear and a recurved bow with a quiver laid on a patterned cloth; dust; no people.',
  'V4-061': 'A mountain ridge under the moon at night, stars, dark forested slopes, a faint thread of torchlight along the ridge; no close figures.',
  'V4-063': 'A rocky hilltop among oak trees at dawn with mist below and a few hoplites with raised shields seen from below at distance; arrows in the ground; no faces.',
  'V4-087': 'The Acropolis rock seen from a distance across the Athenian plain at evening, haze, ancient buildings on top, no modern city; no people.',
  'V4-091': 'A long line of hoplites advancing across a wide dry plain at midday, seen from behind and above, mountains beyond, figures small.',
  'V4-098': 'A low grassy hill at the foot of limestone cliffs in Greece at low sun, wild grass moving, the plain beyond; no monument, no text, no people.',
  'V4-001': 'Very wide; the line of shields is a thin bright edge across the gap; figures small; the sea calm; dawn.',
  'V4-002': 'No people at all; the pass empty at sunrise; steam from hot springs at the cliff foot.',
  'V4-005': 'True aerial; columns are long dark lines with dust; no individual detail.',
  'V4-006': 'Backs only; rows of helmet crests and shield rims; the shore empty beyond; mixed cloak colours, a few crimson.',
  'V4-007': 'Macro: the bronze rim of a round shield and an ash spear shaft braced against it; dust; nothing else.',
  'V4-009': 'Dusk; no figures; a ring of planted spears and leaning shields on a small grassy mound; arrows standing in the slope.',
  'V4-010': 'Same mound closer at dusk; a crested bronze helmet set on a planted spear; no bodies, no blood.',
  'V4-017': 'Two parallel lines of lashed ships across a narrow strait; a plank road on top; tiny figures crossing; dawn.',
  'V4-020': 'A vast camp of tents and horse lines on a river plain at evening; figures tiny; cooking smoke.',
  'V4-025': 'Newly built triremes on a beach, raw timber, three rows of oar-ports, no sails raised; tiny figures.',
  'V4-028': 'One hoplite from behind at a city gate at dawn: crimson cloak, helmet under the arm, long grey-streaked hair; a column waiting beyond; no face.',
  'V4-029': 'A small boy from behind at a doorway watching cloaked men leave down a dusty street; early light; no faces.',
  'V4-031': 'A long column of hoplites and pack mules on a dusty mountain road toward a distant sea; seen from a ridge.',
  'V4-034': 'No people: the ancient pass at ground level, sea at left, limestone cliff at right, a cart-width track.',
  'V4-036': 'A low wall of rough limestone blocks across a narrow shore; tiny figures and cooking fires behind it; cliff above.',
  'V4-039': 'One Spartan from behind: crimson cloak, long braided hair, plain unpainted bronze shield face, standing on the shore.',
  'V4-042': 'Flat lay of Persian equipment on a patterned cloth in daylight; no people, no text.',
  'V4-043': 'A dense block of Persian infantry at parade seen from above and behind at distance; felt caps, patterned tunics, tall wicker shields; no faces.',
  'V4-047': 'Spartans in camp seen from behind at mid distance, one combing long hair, one oiling a shield; morning; no faces.',
  'V4-048': 'Median infantry column advancing along a shore toward a low wall, from above and behind at distance; wicker shields up.',
  'V4-049': 'From high on the cliff: a dense column pressing into the narrow shore against a thin line of bronze shields; dust; figures tiny.',
  'V4-050': 'Low angle from the Persian side: a rim of bronze shields and a hedge of long spear points above it; wicker shields in the foreground; dust; no faces.',
  'V4-051': 'From the cliff: the Persian column packed into the narrows with only its first ranks in contact; figures tiny.',
  'V4-052': 'An empty royal viewing platform with a canopy on a hillside at midday; the pass far below in dust; no people.',
  'V4-053': 'From the cliff: the Greek line bending backward along the shore with Persian figures rushing after; dust; figures small.',
  'V4-054': 'From the cliff: the line of shields halted and turned on scattered pursuers; dust; a canopied platform high on the slope.',
  'V4-055': 'From below a line of shield rims: a dense flight of arrows arcing across a bright sky; no faces.',
  'V4-056': 'Second-day shore from above: a fresh contingent filing forward past a resting one; dust hanging; figures small.',
  'V4-057': 'Persian camp at dusk, lamps in a great tent, one cloaked figure led toward it between guards, seen from far behind.',
  'V4-060': 'Night: a long file of small torch flames climbing through dark oak forest; moonlit ridge; figures indistinct.',
  'V4-062': 'First light in an oak forest: mist between trunks, fallen leaves, indistinct shapes of a column emerging at distance.',
  'V4-066': 'A circle of spears and helmets planted around a cold fire at first light; the wall behind; no people.',
  'V4-067': 'A column marching away east along the shore at dawn, seen from behind the wall; backs only.',
  'V4-068': 'A group of hoplites in plain brown cloaks standing by the wall at dawn, seen from behind; shields down.',
  'V4-071': 'From the Greek side at distance: the Persian host forming on the shore in morning light; standards; a platform on the slope.',
  'V4-072': 'The low wall from behind at morning with a gap opened in it and shields passing through; backs only.',
  'V4-073': 'From above: a block of hoplites walking forward past the wall into a wider shore; spears up; the Persian mass ahead; sea beside; figures small.',
  'V4-074': 'A splintered ash spear shaft, a bronze butt-spike and a sword hilt in churned dust; no people.',
  'V4-075': 'A crested bronze helmet on its side in churned dust with the edge of a crimson cloak; nothing else; no blood.',
  'V4-076': 'From the cliff at distance: a knot of figures in dust at the centre of the line, shields raised over one point; nothing distinct.',
  'V4-077': 'A column of Persian infantry emerging from oak forest onto the shore behind the wall; from above; figures small.',
  'V4-078': 'A low mound behind the wall with a tight ring of shields on top; Persian figures gathering around at a standoff; dust settling; no close detail.',
  'V4-079': 'The mound seen from behind Persian archers at distance; volleys of arrows arcing onto it; the ring of shields vanishing in shafts.',
  'V4-082': 'Shields and helmets stacked on the shore at midday, spears laid flat; no people.',
  'V4-088': 'A rocky citadel above a plain at dusk with columns of smoke rising; seen from far across the plain; no people.',
  'V4-089': 'High wide view of a narrow strait: lines of ancient oared warships closing, oars churning; no close detail.',
};

// ---------------- generative motion (ONLY the fourteen shots selected by the frozen plan) ----------------
export const MOTION_PROMPTS: Record<string, string> = {
  'V4-001': 'Static wide camera at dawn. The line of shields holds still; spear points sway slightly; dust drifts across the gap; the sea moves gently. Photoreal, documentary, no new figures appear.',
  'V4-002': 'Slow forward dolly along the empty pass at sunrise. Waves lap the shore on the left; steam drifts from the cliff foot. No people. Photoreal.',
  'V4-005': 'Slow aerial drift forward. The distant columns inch along the plain; the dust cloud rolls slowly; horses and carts move in the lines. No close detail, photoreal.',
  'V4-009': 'Static camera at dusk. Wind moves the grass on the mound; a few arrows quiver; smoke drifts; the light fades slightly. No figures. Photoreal, quiet.',
  'V4-017': 'Slow aerial push toward the bridges. The column of tiny figures and animals moves across the plank road; water moves under the lashed ships. Photoreal.',
  'V4-049': 'Static high camera on the cliff. The dense column surges forward into the narrow shore and presses against the shield line; dust rises; spear points glint. Figures stay tiny; no close detail. Photoreal.',
  'V4-053': 'Static high camera on the cliff. The thin line of shields steps backward along the shore and a crowd of Persian figures rushes after it; dust rises. Figures tiny. Photoreal.',
  'V4-054': 'Static high camera on the cliff. The retreating line stops, turns and closes forward on the scattered pursuers; dust billows. Figures tiny, photoreal, no close detail.',
  'V4-055': 'Static low camera under the shield rims. A dense flight of arrows arcs across the sky and darkens it; shafts thud into shields. No faces. Photoreal.',
  'V4-060': 'Static night camera. The file of torch flames flickers and moves slowly up the forested slope; moonlight on the ridge. Photoreal.',
  'V4-062': 'Static camera in the misty oak forest at first light. Mist drifts between the trunks; indistinct figures of a column move through it at distance. Photoreal, no faces.',
  'V4-073': 'Slow aerial drift forward. The block of hoplites walks steadily out past the wall into the wider shore; spears sway; dust begins to rise; the Persian mass ahead stirs. Figures small, photoreal.',
  'V4-076': 'Static high camera at distance. The knot of figures in the dust heaves forward and back; shields rise and fall over one point; dust thickens. Nothing distinct, photoreal.',
  'V4-078': 'Static camera at distance. The ring of shields on the mound tightens; Persian figures gather around at a standoff; dust settles. No close detail, photoreal.',
};
/** One simplified retry (frozen policy R08: a materially different attempt after provider_no_output / semantic failure), rev v2. */
export const CLIP_RETRY: Record<string, string> = {
  'V4-076': 'Static high camera at distance. Dust slowly drifts and thickens over the crowd of tiny figures on the shore; shields glint as the mass sways gently; the sea glitters. Calm, photoreal, no close detail.',
};
/** Runway accepts 5 or 10 s; the clip must cover the frozen shot (slowed up to 1.5x at render). */
export const clipSecondsFor = (shotSeconds: number): 5 | 10 => (shotSeconds <= 5 ? 5 : 10);
export const SEC_USD = 0.05;

// ---------------- stock (Pexels, free; licensed under the Pexels License) ----------------
export const STOCK_QUERIES: Record<string, string[]> = {
  'V4-003': ['narrow coastal cliff path sea', 'cliff path above sea mediterranean', 'rocky coast trail sea'],
  'V4-004': ['sandstorm desert horizon', 'dust storm approaching plain', 'haboob dust wall'],
  'V4-008': ['rocky mountain path greece', 'mountain trail rocks scrub morning', 'steep rocky hiking path'],
  'V4-011': ['waves crashing dark rocks mountain', 'sea waves rocks slow motion', 'waves breaking cliffs'],
  'V4-012': ['sunrise over sea aerial', 'golden sunrise ocean mountains', 'dawn sea horizon drone'],
  'V4-013': ['aerial coastal plain beach greece', 'aerial long sandy beach low hills', 'coastal plain aerial afternoon'],
  'V4-014': ['persepolis', 'persepolis iran ruins', 'apadana persepolis relief'],
  'V4-015': ['persepolis columns', 'iran ancient ruins columns', 'pasargadae'],
  'V4-018': ['storm waves strait grey sea', 'stormy sea spray wind', 'rough sea storm waves'],
  'V4-021': ['pouring water clay jug', 'clay pot water pour hands', 'ceramic jug water'],
  'V4-022': ['ancient greek ruins hilltop olive groves', 'greek acropolis ruins hill', 'ancient ruins greece afternoon'],
  'V4-024': ['taygetus mountains sparta', 'snow mountains greece valley', 'mountain range greece snow peaks'],
  'V4-027': ['doric temple columns sunset', 'greek temple columns evening sky', 'ancient greek temple dusk'],
  'V4-032': ['hot spring steam rock sulphur', 'thermal spring steam flowing rock', 'sulfur hot spring stream'],
  'V4-035': ['thermopylae aerial highway', 'highway farmland cliffs aerial greece', 'aerial road plain mountains greece'],
  'V4-037': ['ancient greek vase', 'greek amphora museum', 'ancient greek pottery'],
  'V4-044': ['persepolis soldiers', 'persepolis guards', 'achaemenid relief'],
  'V4-045': ['sunset river plain mountains greece', 'sunset wide plain distant mountains', 'golden sunset valley mountains'],
  'V4-046': ['horse rider hill silhouette dawn', 'lone horseman ridge sunrise', 'rider on horseback hill silhouette'],
  'V4-059': ['oak forest mountain ridge evening mist', 'mountain forest ridge mist', 'misty mountain forest evening'],
  'V4-061': ['full moon mountains night', 'moonlit mountain ridge', 'night mountain silhouette moon stars'],
  'V4-063': ['rocky hill oak trees', 'hilltop rocks morning mist', 'mountain forest rocks dawn'],
  'V4-064': ['aerial forest mountain slope sea dawn', 'aerial mountains descending to sea', 'forest mountains sea aerial morning'],
  'V4-065': ['campfire embers night beach', 'glowing embers dark', 'campfire embers close up night'],
  'V4-069': ['delphi ruins greece', 'delphi sanctuary ruins morning', 'ancient delphi temple'],
  'V4-080': ['archaeological excavation trowel', 'archaeology dig trench hands', 'archaeologist excavating soil'],
  'V4-083': ['storm light sea cliffs evening', 'dramatic clouds sea cliffs sunset', 'cliffs stormy sky evening'],
  'V4-085': ['storm clouds rough sea rocky coast', 'stormy sea rocky coast greece', 'dark storm clouds over sea'],
  'V4-086': ['moonlight calm sea night', 'moon reflection sea night', 'calm sea moonlight'],
  'V4-087': ['acropolis athens aerial', 'parthenon aerial sunset', 'athens acropolis drone'],
  'V4-091': ['plain fields aerial greece', 'farmland plain mountains drone', 'wide valley fields aerial'],
  'V4-092': ['thermopylae cliffs aerial', 'limestone cliffs plain aerial greece', 'mountain cliffs above plain aerial'],
  'V4-093': ['aerial greek islands golden hour', 'greece islands sea aerial sunset', 'aegean sea islands aerial'],
  'V4-095': ['ancient manuscript museum glass', 'old manuscript page close up', 'ancient parchment manuscript'],
  'V4-096': ['olive groves valley mountains evening greece', 'olive trees valley sunset mountains', 'sparta valley olive groves'],
  'V4-097': ['thermopylae plain sunset aerial', 'aerial plain highway sunset cliffs', 'farmland sunset aerial mountains sea'],
  'V4-098': ['thermopylae', 'leonidas monument', 'greek war memorial statue'],
};

// ---------------- graphics (internal, free) ----------------
export type GraphicKind = 'map-route' | 'numbers' | 'map-league' | 'map-plan' | 'map-allies' | 'map-pass' | 'hoplite-kit' | 'phalanx' | 'no-flank' | 'map-anopaea' | 'map-road-south' | 'arrowheads' | 'map-artemisium' | 'map-plataea' | 'epitaph' | 'end-card';
export const GRAPHICS: Record<string, GraphicKind> = {
  'V4-016': 'map-route', 'V4-019': 'numbers', 'V4-023': 'map-league', 'V4-026': 'map-plan', 'V4-030': 'map-allies', 'V4-033': 'map-pass', 'V4-038': 'hoplite-kit', 'V4-040': 'phalanx',
  'V4-041': 'no-flank', 'V4-058': 'map-anopaea', 'V4-070': 'map-road-south', 'V4-081': 'arrowheads', 'V4-084': 'map-artemisium', 'V4-090': 'map-plataea', 'V4-094': 'epitaph', 'V4-099': 'end-card',
};

// ---------------- music (licensed library, bucket music-library) ----------------
/** Sections by scene: [trackId, fromScene, toSceneExclusive]. Crossfades handled by the renderer. */
export const MUSIC: [string, string, string | null][] = [
  ['elevenlabs-tension-1', 'S1', 'S2'],
  ['elevenlabs-reflective-1', 'S2', 'S4'],
  ['elevenlabs-minimal-1', 'S4', 'S5'],
  ['elevenlabs-cinematic-1', 'S5', 'S7'],
  ['elevenlabs-tension-2', 'S7', 'S8'],
  ['elevenlabs-inspirational-2', 'S8', null],
];
/** Music ducks to near silence on these shots (seconds after the shot start, duration). */
export const MUSIC_DROPS: Record<string, [number, number]> = { 'V4-075': [0, 3], 'V4-094': [0, 4] };
/** Synthesized low rumble cues (no SFX library exists in the account): shot id → seconds. */
export const RUMBLE_CUES: Record<string, number> = { 'V4-005': 3, 'V4-049': 3, 'V4-073': 4 };

// ---------------- on-screen text ----------------
export const ON_SCREEN_NOTICE = 'Battle imagery is reconstruction; maps and figures follow Herodotus and modern estimates';
export const ON_SCREEN_NOTES: Record<string, string> = { 'the Thebans': "Herodotus's account · Theban sources differ" };
export const END_CARD_LINES = [TITLE, CHANNEL];
export const CREDITS = 'Sources: Herodotus, Histories 7.175–239 · Thucydides 5.71 · Xenophon, Lac. Pol. 11 · Plutarch, Apophth. Lac. 225D · Pausanias 3.14.1 · Marinatos 1951 · Kraft et al. 1987 · Cartledge 2006 · Lazenby 1993. Stock footage: Pexels.';
