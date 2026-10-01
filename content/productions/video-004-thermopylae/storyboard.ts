/**
 * Video #004 — Thermopylae storyboard: every shot is an explicit Production Intelligence shot record.
 * Built from SCRIPT.md scene by scene. No placeholder shots and nothing reused from any earlier production.
 *
 * Visual rules for this title (see RESEARCH.md §F and the long-form visual bible):
 * - Historical realism only: period hoplite kit (aspis, dory, xiphos, bronze helmet, bronze or linen cuirass,
 *   greaves, crimson cloak), Persian kit as Herodotus 7.61 describes it (felt tiara, trousers, sleeved tunic,
 *   scale armour, wicker shield, short spear, bow). No lambda blazons, no bare-chested warriors, no capes-only
 *   costumes, no monsters, no exaggerated physiques, no fantasy armour, no film imitation.
 * - Combat is shown where the sources describe it, as distant massed figures in dust and at the level of
 *   equipment (shield rims, spear points, arrows). No blood, no wounds, no corpses, no identifiable faces.
 * - Specific evidence (the Kolonos arrowheads, the Simonides epitaph, the modern site, museum objects, reliefs)
 *   is never AI: it is stock, a photograph, or a deterministic graphic.
 * - Maps, diagrams and the timeline are DETERMINISTIC graphics (SVG), never generated.
 * Shot classes are honest about generative risk: a frame dominated by several near figures is multi_human
 * (still-motion only under the frozen profile); distant massed figures inside a landscape frame are landscape;
 * one figure is single_human; equipment details are object.
 */
import { parseShotRecord, type ProductionShotRecord, type ProductionShotRecordInput } from "../../../src/lib/production-core/shot-record";
import { PRODUCTION_POLICY_V1 } from "../../../src/lib/production-core/policy-engine";

type Kind = "stock" | "still" | "parallax" | "ai" | "graphic";
type Cls = ProductionShotRecordInput["contract"]["shotClass"];
type Motion = "none" | "camera_only" | "simple" | "complex";
type Lev = "LOW" | "MEDIUM" | "HIGH";
/** scene, kind, narrative purpose (unique where a pause is declared), visual intent, narration (exact script sentence), class, motion, leverage, risk, continuity group, hero. */
type Row = [scene: string, kind: Kind, purpose: string, visual: string, narration: string, cls?: Cls, motion?: Motion, leverage?: Lev, risk?: Lev, continuity?: string, hero?: true];

export const FORBIDDEN = [
  ...PRODUCTION_POLICY_V1.content.forbiddenElementsGlobal,
  "blood, wounds, gore or corpses", "identifiable real faces", "lambda shield blazon", "bare-chested or cape-only warriors",
  "fantasy or film-style armour", "monsters or giants", "exaggerated musculature", "modern objects or clothing", "flags or heraldry",
];

/** Intentional picture-only beats (seconds added on top of narration + tail), keyed by narrative purpose. */
export const PAUSES: Record<string, number> = {
  "hook: late summer": 0.5, "hook: this is Thermopylae": 2, "hook: the pass held": 0.5, "the sea whipped": 1, "earth and water": 1,
  "living sons": 1, "the hot springs": 0.5, "the Immortals": 1, "different war": 1.5, "combing hair": 0.5, "few soldiers": 1,
  "the assault on the wall": 1.5, "the shade": 2, "Ephialtes": 1, "all night": 1.5, "footsteps on leaves": 1.5,
  "the Greeks knew": 1, "nobody recorded": 1.5, "into the open": 1, "swords": 1, "Leonidas fell": 2, "the hill": 1.5,
  "arrowheads": 2, "the Acropolis burns": 1, "did it matter": 1.5, "the epitaph": 2.5, "the sea has gone": 1.5, "still in it": 3,
};

/** words / 2.5 (150 wpm) + 0.5 s sentence tail + declared pause, rounded up to 0.5 s, minimum 2.5 s. */
export const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
export const secondsFor = (narration: string, purpose: string) => Math.max(2.5, Math.ceil((words(narration) / 2.5 + 0.5 + (PAUSES[purpose] ?? 0)) * 2) / 2);

export const ROWS: Row[] = [
  // S1 · HOOK — motion from second 0 (AI clip), eight cuts in the first thirty seconds.
  ["S1", "ai", "hook: late summer", "dawn, low wide view along a narrow shore between a limestone cliff and a calm sea; a single unbroken line of round bronze-faced shields and levelled spear points fills the gap, seen from the sea side at distance, dust drifting, figures small and faceless, crimson cloaks", "Late summer, 480 BC.", "landscape", "complex", "HIGH", "LOW", "shield-wall"],
  ["S1", "ai", "hook: a strip of shore", "ground-level view along the ancient pass at sunrise: sea lapping on the left, sheer limestone cliff on the right, steam from springs at the cliff foot, no people", "A strip of shore between a mountain and the sea,", "landscape", "simple", "HIGH", "LOW", "pass-day"],
  ["S1", "stock", "hook: no wider than a road", "a narrow track squeezed between a sea cliff and the water, Mediterranean, morning, no people", "in places no wider than a road.", "landscape", "simple"],
  ["S1", "stock", "hook: coming down the coast", "a long dust cloud rising over a dry coastal plain at dawn, mountains behind", "Coming down the coast toward it:", "landscape", "simple"],
  ["S1", "ai", "hook: the host", "high aerial along a coastal plain at dawn: endless columns of distant marching figures, horses and carts raising a long dust cloud toward mountains, sea on the left, no readable detail", "the largest invasion force Greece had ever seen.", "landscape", "complex", "HIGH", "LOW", "persian-host"],
  ["S1", "parallax", "hook: the Greeks waiting", "from behind the Greek line looking out of the pass: rows of helmeted men seen from the back, shields on arms, a few crimson cloaks among brown and grey, the empty shore beyond, morning light", "Waiting inside it: about seven thousand Greeks, and three hundred of them from Sparta.", "multi_human", "camera_only"],
  ["S1", "still", "hook: the pass held", "close on a bronze shield rim and a spear shaft braced against it, dust in the air, no face", "For two days, the pass held.", "object", "camera_only"],
  ["S1", "stock", "hook: the goat path", "steep rocky mountain path through scrub and oak, early light, no people", "Then a goat path through the mountains changed everything.", "landscape", "simple"],
  ["S1", "ai", "hook: the low hill", "dusk, a low grassy mound at the foot of a cliff, a ring of upright spears and shields silhouetted on top, arrows standing in the slope, no figures visible", "By the third afternoon, a king of Sparta was dead,", "landscape", "complex", "HIGH", "LOW", "kolonos"],
  ["S1", "parallax", "hook: around him", "the same mound closer at dusk: a crested helmet set on a planted spear at the summit, shields leaning in a ring, arrows thick in the turf, no bodies", "and the men who had stayed with him lay around him on a low hill.", "object", "camera_only", undefined, undefined, "kolonos"],
  ["S1", "stock", "hook: harder story", "waves breaking on dark rocks under a mountain, slow", "It is a harder story than the legend. And a better one.", "landscape", "simple"],
  ["S1", "stock", "hook: this is Thermopylae", "sunrise over a sea gulf seen from a mountain ridge in Greece, long shadows, no people", "This is Thermopylae.", "landscape", "simple"],
  // S2 · THE KING OF KINGS
  ["S2", "stock", "Marathon", "aerial of a flat coastal plain with a long sandy beach and low hills, Greece, late afternoon", "Ten years earlier, a Persian army had landed at Marathon, north of Athens, and been thrown back into the sea.", "landscape", "simple"],
  ["S2", "stock", "Persepolis", "stone relief carvings of robed figures in procession at Persepolis, raking light", "The Great King, Darius, planned to return. He died first.", "object", "camera_only"],
  ["S2", "stock", "Xerxes", "the ruined columns and stairways of Persepolis at sunset, slow aerial", "His son Xerxes inherited the empire, the grudge, and the preparations.", "landscape", "simple"],
  ["S2", "graphic", "route map", "map of the Aegean: the Persian land route from the Hellespont through Thrace and Macedonia to Thermopylae, grain depots marked, the Athos canal cut", "For years the Persians stockpiled grain along the route, dug a canal through the neck of Mount Athos so the fleet could avoid the cape that had wrecked ships before,", "map", "none"],
  ["S2", "ai", "the bridges", "wide view of a narrow strait at dawn: two lines of ships lashed side by side spanning the water, a road of planks, brushwood and earth laid over them with wicker screens at the sides, a column of tiny figures and animals crossing, hills on both shores", "and bridged the Hellespont, the strait between Asia and Europe, with two floating roads built on hundreds of ships.", "landscape", "complex", "HIGH", "LOW", "hellespont"],
  ["S2", "stock", "the sea whipped", "storm waves in a strait, grey water, spray, wind", "Herodotus says that when a storm broke the first bridges, Xerxes had the sea whipped.", "landscape", "simple"],
  ["S2", "graphic", "numbers", "bar graphic: Herodotus 2.6 million fighting men and 1,207 warships against modern estimates of 100,000–300,000 men and several hundred ships", "How big was the army? Herodotus counted more than two million fighting men. Modern historians think somewhere between a hundred thousand and three hundred thousand, with a fleet of several hundred warships.", "graphic", "none"],
  ["S2", "parallax", "even the low figure", "a vast camp of tents and horse lines filling a river plain at evening, cooking smoke, seen from a hillside, figures tiny", "Even the low figure was larger than anything Greece had faced.", "landscape", "camera_only", undefined, undefined, "persian-host"],
  ["S2", "stock", "earth and water", "a clay jar being filled with water from a stone spring, hands only, warm light", "Heralds went ahead demanding earth and water: the sign of submission. Many northern cities gave it.", "object", "camera_only"],
  // S3 · THE GREEKS
  ["S3", "stock", "not a nation", "hilltop ruins of a small ancient Greek acropolis above olive groves, afternoon", "The Greeks were not a nation. They were hundreds of quarrelling cities.", "landscape", "simple"],
  ["S3", "graphic", "league map", "map of Greece: the cities that resisted marked, Corinth highlighted, the cities that submitted shaded", "In 481, the ones that chose to resist met at Corinth and agreed, barely, to fight together.", "map", "none"],
  ["S3", "stock", "Sparta", "the Taygetus mountain range above the Eurotas valley near Sparta, snow on the peaks", "Sparta would lead on land.", "landscape", "simple"],
  ["S3", "parallax", "the two hundred ships", "a row of newly built triremes drawn up on a beach, fresh timber, three banks of oar-ports, men as small distant figures working on hulls, morning haze", "Athens, which had just built two hundred warships with silver from its mines, would carry the fight at sea.", "landscape", "camera_only", undefined, undefined, "fleet"],
  ["S3", "graphic", "the plan", "map: Thermopylae and Artemisium 60 km apart, the land road and the sea channel, both blocked", "The plan was simple. Block the land road into central Greece at Thermopylae, and block the sea beside it at Artemisium, so the two Persian forces could not support each other.", "map", "none"],
  ["S3", "stock", "the Carneia", "columns of a Doric temple against an evening sky, Greece, slow", "But the timing was bad. Sparta was keeping the festival of the Carneia, and the Olympic truce was in force.", "landscape", "simple"],
  ["S3", "parallax", "Leonidas", "a single hoplite seen from behind at a city gate at dawn, crimson cloak, bronze helmet carried under the arm, long grey-streaked hair, a column waiting beyond", "So Sparta sent an advance guard: one of its two kings, Leonidas, with three hundred full citizens,", "single_human", "camera_only"],
  ["S3", "still", "living sons", "a small boy's hand on a doorway post watching a column of cloaked men leave down a dusty street, seen from behind, early light", "each chosen, Herodotus says, because he had a living son. Leonidas was probably about sixty.", "single_human", "camera_only"],
  ["S3", "graphic", "allies map", "map of the Peloponnese and central Greece: Tegea, Mantinea, Corinth, Phlius, Mycenae, Thespiae, Thebes, Phocis, Locris, with contingent sizes", "On the road north, the allies joined: men from Tegea and Mantinea, Corinth, Phlius, Mycenae, seven hundred from Thespiae, four hundred from Thebes, and the Phocians and Locrians, whose land lay just beyond the pass.", "map", "none"],
  ["S3", "parallax", "seven thousand", "a long column of hoplites and pack mules winding along a dusty mountain road toward the sea, seen from a ridge, figures small, cloaks of mixed colours", "Roughly seven thousand men, with their helot servants. They were told the main army would follow after the festival.", "landscape", "camera_only", undefined, undefined, "greek-column"],
  // S4 · THE HOT GATES
  ["S4", "stock", "the hot springs", "steaming sulphur hot spring water flowing over orange-stained rock at the foot of a cliff", "Thermopylae means the Hot Gates. Sulphur springs still steam out of the cliff.", "landscape", "simple"],
  ["S4", "graphic", "pass map", "map of the pass: the 480 BC coastline against the cliff, the west, middle and east gates, the Phocian wall, the Anopaea path, the modern coastline and highway", "In 480 BC the sea came right up to the foot of the mountain.", "map", "none"],
  ["S4", "parallax", "a cart's width", "ground-level view along the ancient pass: sea lapping at the left, sheer limestone cliff at the right, a track barely wide enough for a cart, morning, no people", "The pass ran for several kilometres between cliff and water, and at its narrowest points it was barely a cart's width.", "landscape", "camera_only", undefined, undefined, "pass-day"],
  ["S4", "stock", "the highway", "aerial of the Thermopylae plain today: a highway on flat farmland with the cliffs on one side and the sea far off", "Today the river silt has pushed the coast several kilometres away, and the ancient shoreline is a highway.", "landscape", "simple"],
  ["S4", "parallax", "the wall", "a low rebuilt wall of rough limestone blocks across a narrow shore, hoplites camped behind it as small figures, cooking fires, cliff above", "Across the middle of the pass stood an old wall the Phocians had built. The Greeks rebuilt it and camped behind it.", "landscape", "camera_only", undefined, undefined, "wall"],
  ["S4", "stock", "hoplites", "an ancient Greek black-figure vase showing armed hoplites, museum display, slow pan", "The men who held it were hoplites: citizen infantry.", "object", "camera_only"],
  ["S4", "graphic", "hoplite kit", "labelled diagram of hoplite equipment: aspis about 90 cm, dory 2–2.5 m with iron head and bronze butt-spike, xiphos, bronze helmet, bronze or linen cuirass, greaves", "Each carried a round shield almost a metre across, wood faced with bronze; a spear of two metres or more, with an iron head and a bronze spike at the butt; a short sword; a bronze helmet; body armour of bronze or layered linen; and greaves.", "graphic", "none"],
  ["S4", "parallax", "crimson cloaks", "a Spartan hoplite from behind, crimson cloak, long braided hair under the helmet rim, plain unpainted bronze shield face, standing on the shore", "Spartans fought in crimson cloaks and wore their hair long. The famous lambda on the shield comes later; in 480 it did not exist.", "single_human", "camera_only"],
  ["S4", "graphic", "phalanx diagram", "top-down diagram of a phalanx eight ranks deep, overlapping shields each covering the man on the left, spears levelled from the first ranks", "They fought in a phalanx: ranks of men standing shoulder to shoulder, each shield covering the man on his left, spears levelled over the rim.", "graphic", "none"],
  ["S4", "graphic", "no flank", "diagram: a phalanx in open ground outflanked by a wider force, versus the same phalanx in a corridor between cliff and sea with no flank", "In the open, numbers could flank a phalanx. In a corridor a few metres wide, there was no flank.", "graphic", "none"],
  ["S4", "parallax", "Persian kit", "a Persian infantryman's equipment laid out on a patterned cloth in daylight: soft felt cap, sleeved tunic, trousers, a corselet of small iron scales, a tall wicker shield, a short spear, a large bow with quiver, a dagger; no people, no text", "The Persian infantry, as Herodotus describes them, wore felt caps, trousers and sleeved tunics, with scale armour under the cloth. They carried wicker shields, short spears, daggers, and above all bows.", "object", "camera_only"],
  ["S4", "parallax", "the Immortals", "a dense block of Persian infantry at parade, seen from above and behind at distance: felt caps, patterned sleeved tunics, tall wicker shields, bows, spears, no faces", "Their best were the ten thousand the Greeks called the Immortals, because every man who fell was replaced at once.", "landscape", "camera_only", undefined, undefined, "immortals"],
  ["S4", "stock", "different war", "carved stone relief of a file of ancient Persian spearmen with bows and quivers, Persepolis, raking light", "They were brave, professional, and equipped for a different kind of war.", "object", "camera_only"],
  // S5 · THE FIRST DAY
  ["S5", "stock", "Xerxes waits", "sunset over a wide river plain and distant mountains in Greece, slow drift", "Xerxes camped in the plain and waited four days, expecting the Greeks to run.", "landscape", "simple"],
  ["S5", "stock", "the horseman", "a lone rider on horseback on a hill ridge at dawn, silhouette, slow", "A horseman sent to look at them came back puzzled.", "single_human", "simple"],
  ["S5", "still", "combing hair", "Spartan hoplites in a camp seen from behind at mid distance, one combing long hair, another oiling a shield, no faces, morning", "The Spartans were exercising and combing their hair. A Spartan exile at the king's court, Demaratus, explained: that is what they do when they are about to risk their lives.", "multi_human", "camera_only"],
  ["S5", "parallax", "the Medes", "a column of Median infantry in felt caps and sleeved tunics advancing along the shore toward the wall, seen from above and behind at distance, wicker shields up, no faces", "On the fifth day Xerxes sent in the Medes and Cissians, with orders to take the Greeks alive.", "landscape", "camera_only", undefined, undefined, "immortals"],
  ["S5", "ai", "the assault on the wall", "from high on the cliff: a dense column of Persian infantry pressing into the narrow shore against a thin line of bronze shields in front of a low wall, dust, spear points glinting, figures tiny, sea beside", "They attacked the wall for hours.", "landscape", "complex", "HIGH", "LOW", "battle-wide"],
  ["S5", "parallax", "short spears against long", "low angle from the Persian side: a rim of bronze shields and a hedge of long spear points above it, wicker shields in the foreground, dust, no faces", "Short spears against long ones, wicker against bronze,", "multi_human", "camera_only", undefined, undefined, "shield-wall"],
  ["S5", "still", "only the front", "from the cliff: the Persian column packed into the narrow shore, only its first few ranks touching the Greek line, the rest waiting in dust behind, figures tiny", "in a space where only the front of the column could fight.", "landscape", "camera_only", undefined, undefined, "battle-wide"],
  ["S5", "still", "few soldiers", "an empty royal viewing platform on a hillside at midday, a canopy, the pass far below in dust", "Herodotus says they made it clear to everyone, and to the king above all, that he had many men but few soldiers.", "landscape", "camera_only"],
  ["S5", "ai", "feigned flight", "seen from the cliff: the block of Immortals advances along the shore into the dust; the Greek line breaks backward and a rush of Persian figures follows, figures small", "Then he sent the Immortals. They did no better. The Spartans, fighting in front, would turn and feign flight,", "landscape", "complex", "HIGH", "LOW", "battle-wide"],
  ["S5", "ai", "the wheel", "seen from the cliff: the retreating line of shields halts, wheels and closes again on the scattered pursuers in the dust, figures small, sea beside; high on the slope a canopied platform", "draw the pursuers into a rush, then wheel and cut them down. Three times that day, Herodotus says, the king leapt up from his seat in fear for his army.", "landscape", "complex", "HIGH", "LOW", "battle-wide"],
  ["S5", "ai", "the shade", "from below the rim of a line of shields: a dense flight of arrows arcing across a bright sky and dimming it, shafts thudding into shields, the line falling into shadow, no faces", "Before the battle, a Spartan named Dienekes was told that Persian arrows would hide the sun. Good, he said: then we will fight in the shade.", "landscape", "complex", "HIGH", "LOW", "arrows"],
  // S6 · THE PATH
  ["S6", "parallax", "relays", "the shore in front of the wall at midday on the second day, dust hanging, a fresh contingent of hoplites filing forward past a resting one, seen from above, figures small", "The second day went the same way. The Persians attacked in relays; the Greeks rotated city by city, so fresh men always held the line.", "landscape", "camera_only", undefined, undefined, "wall"],
  ["S6", "still", "Ephialtes", "a Persian camp at dusk, lamps lit in a great tent, a single cloaked figure led toward it between guards, seen from far behind", "And then, that evening, a local man came to the king's tent. His name was Ephialtes, from Trachis.", "landscape", "camera_only"],
  ["S6", "graphic", "Anopaea map", "map: the Anopaea path from the Asopus gorge up over the ridge of Kallidromo and down to the east gate behind the wall; the Phocian post marked", "He knew a path. The Anopaea: a mountain track that climbed behind the pass, over the ridge, and came down beyond the Greek wall.", "map", "none"],
  ["S6", "stock", "the Phocian post", "a mountain ridge of oak forest and limestone at evening, mist in the gullies", "Leonidas knew it too. He had posted the thousand Phocians there to guard it.", "landscape", "simple"],
  ["S6", "ai", "night march", "a long file of small torch flames climbing through dark oak forest on a mountainside at night, moonlight on the ridge, figures indistinct", "At lamp-lighting time, Hydarnes led the Immortals out of the camp and up into the oak forest.", "landscape", "complex", "HIGH", "LOW", "anopaea"],
  ["S6", "stock", "all night", "a mountain ridge under the moon at night, stars, slow", "They marched all night.", "landscape", "simple"],
  ["S6", "ai", "footsteps on leaves", "first light in an oak forest, mist between the trunks, fallen leaves stirring, indistinct shapes of a great column emerging through the mist at distance, no faces", "At first light the Phocians heard footsteps on fallen leaves, and looked up at thousands of men already on top of them.", "landscape", "complex", "HIGH", "LOW", "anopaea"],
  ["S6", "stock", "the Phocians withdraw", "a rocky hilltop among oak trees at dawn, mist below, slow", "Arrows came down. The Phocians pulled back to a hilltop to make a stand.", "landscape", "simple"],
  ["S6", "stock", "down toward the pass", "mountain slopes descending through forest toward a sea gulf at dawn, aerial", "The Persians ignored them and kept moving, down toward the pass.", "landscape", "simple"],
  // S7 · THE THIRD DAY
  ["S7", "stock", "the Greeks knew", "embers of a campfire on a dark beach before dawn, slow", "Before dawn, lookouts came running down the mountain. The Greeks knew.", "object", "camera_only"],
  ["S7", "still", "nobody recorded", "a circle of spears and helmets planted in the ground around a cold fire at first light, the wall behind, no people", "They held a council. What was said, nobody recorded.", "object", "camera_only"],
  ["S7", "parallax", "the allies leave", "a column of hoplites marching away east along the shore at dawn, seen from behind the wall, backs to camera", "Herodotus says Leonidas sent the allies away and kept the Spartans.", "landscape", "camera_only", undefined, undefined, "wall"],
  ["S7", "still", "the Thespians", "a group of hoplites in plain brown cloaks standing together on the shore beside the wall, seen from behind, shields down, dawn", "The seven hundred Thespians, under Demophilus, refused to leave. The four hundred Thebans also stayed.", "multi_human", "camera_only"],
  ["S7", "stock", "the oracle", "the ruins of the sanctuary at Delphi on the mountainside, morning light", "Why stay? Herodotus points to an oracle: Sparta would lose a king, or lose the city.", "landscape", "simple"],
  ["S7", "graphic", "the road south", "map: the retreat road from Thermopylae south to Boeotia, the Greek fleet at Artemisium, the hours a rearguard buys", "Modern historians point at the road: somebody had to hold the pass long enough for the rest to get clear, and for the fleet at Artemisium to learn what had happened.", "map", "none"],
  ["S7", "parallax", "mid-morning", "from the Greek side at distance: the Persian host forming up on the shore in morning light, standards, the king's platform on the slope", "At mid-morning, Xerxes attacked from the front.", "landscape", "camera_only", undefined, undefined, "persian-host"],
  ["S7", "parallax", "not behind the wall", "the low wall seen from behind at morning, a gap opened in it, shields passing through, figures seen from the back", "This time the Greeks did not wait behind the wall.", "multi_human", "camera_only", undefined, undefined, "wall"],
  ["S7", "ai", "into the open", "from above: a block of hoplites walking forward out past the wall into a wider stretch of shore, spears up, dust beginning, the Persian mass ahead, figures small, sea beside", "They came out into the wider part of the pass, where more of them could fight at once, knowing the men on the path would soon arrive behind them.", "landscape", "complex", "HIGH", "LOW", "battle-wide", true],
  ["S7", "parallax", "swords", "a splintered ash spear shaft and a bronze butt-spike lying in churned dust, a short sword's hilt beside it, no people", "The spears broke. They fought with swords.", "object", "camera_only"],
  ["S7", "still", "Leonidas fell", "a crested bronze helmet lying on its side in churned dust, a crimson cloak edge beside it, nothing else, midday light", "Leonidas fell.", "object", "camera_only"],
  ["S7", "ai", "fought over", "seen from the cliff at distance: a knot of figures in dust at the centre of the line surges forward and back, shields over one point, nothing distinct, sea glittering beside", "Four times the two sides fought over his body, and four times the Greeks dragged it back.", "landscape", "complex", "HIGH", "LOW", "battle-wide"],
  ["S7", "parallax", "the rear", "a column of Persian infantry emerging from the oak forest onto the shore behind the wall, seen from above, morning, figures small", "Then the Immortals came down the mountain into the Greeks' rear.", "landscape", "camera_only", undefined, undefined, "anopaea"],
  ["S7", "ai", "the hill", "a low mound behind the wall with a tight ring of shields forming on its top, seen from a distance, Persian figures gathering around it at a standoff, dust settling, no close detail", "The survivors withdrew behind the wall to a low mound and formed up on it, with swords, with hands, with teeth, Herodotus says.", "landscape", "complex", "HIGH", "LOW", "kolonos"],
  ["S7", "parallax", "buried in arrows", "the mound seen from behind the Persian archers at distance, volleys of arrows arcing onto it against a bright sky, the ring of shields vanishing in shafts", "The Persians did not close with them. They buried the hill in arrows.", "landscape", "camera_only", undefined, undefined, "arrows"],
  ["S7", "stock", "Marinatos", "an archaeological trench with string lines and a trowel in dry Mediterranean soil, hands only", "In 1939, a Greek archaeologist, Spyridon Marinatos, dug into that mound.", "object", "camera_only"],
  ["S7", "graphic", "arrowheads", "graphic: drawn outlines of trilobate bronze arrowheads of the Persian type found on the Kolonos hill, with the 1939 excavation note", "He found hundreds of Persian bronze arrowheads.", "graphic", "none"],
  ["S7", "still", "the Thebans", "shields and helmets stacked on the shore at midday, spears laid flat, no people", "According to Herodotus, the Thebans surrendered and were branded. The Thespians died with the Spartans. Their names are rarely remembered.", "object", "camera_only"],
  ["S7", "stock", "Xerxes's order", "storm light over sea cliffs at evening, long shadows, slow", "Xerxes ordered Leonidas's head cut off and his body impaled, which Herodotus notes was unlike the Persians, who usually honoured brave enemies.", "landscape", "simple"],
  // S8 · AFTER
  ["S8", "graphic", "Artemisium map", "map: the Artemisium channel off northern Euboea and the pass across the gulf, the two fleets", "The same three days, the fleets had been fighting off Artemisium, in sight of the pass.", "map", "none"],
  ["S8", "stock", "the storm", "storm clouds and heavy seas off a rocky Greek coast", "A storm had already wrecked many Persian ships. The battle was a draw.", "landscape", "simple"],
  ["S8", "stock", "withdraw in the night", "moonlight on a calm sea at night from a dark shore, slow", "When the news came from Thermopylae, the Greek fleet withdrew in the night.", "landscape", "simple"],
  ["S8", "stock", "Athens empties", "the Acropolis of Athens seen from a distance today, evening haze", "The Persians marched south. Athens emptied its people onto the islands,", "landscape", "simple"],
  ["S8", "parallax", "the Acropolis burns", "a rocky citadel above a plain at dusk with columns of smoke rising from it, seen from far across the plain, no people", "and the Acropolis burned.", "landscape", "camera_only", undefined, undefined, "athens"],
  ["S8", "parallax", "Salamis", "high wide view of a narrow strait between an island and the mainland: lines of triremes closing, oars churning, some ships turning sideways, no close detail", "Then, in the narrow strait of Salamis, the Greek fleet destroyed Xerxes's.", "landscape", "camera_only", undefined, undefined, "fleet"],
  ["S8", "graphic", "Plataea map", "map: Xerxes's return to the Hellespont, Mardonius wintering in Thessaly, Plataea in 479 BC", "The king went home.", "map", "none"],
  ["S8", "stock", "Plataea", "a wide dry plain between mountains in central Greece at midday, slow aerial", "The army he left behind was broken the next summer at Plataea, by a Greek line with the Spartans at its heart.", "landscape", "simple"],
  ["S8", "stock", "did it matter", "the Thermopylae cliffs today above the plain, afternoon, slow aerial", "So, did Thermopylae matter? Three days did not stop the invasion. The pass fell.", "landscape", "simple"],
  ["S8", "stock", "resistance", "aerial over Greek islands and sea at golden hour", "But the retreat was orderly, the fleet survived, and every city in Greece now knew what resistance looked like.", "landscape", "simple"],
  // S9 · THE STONE
  ["S9", "graphic", "the epitaph", "card: the Simonides epitaph in Greek and English on a plain stone-coloured ground, source Herodotus 7.228", "Simonides wrote the lines later carved at the pass: \"Stranger, go tell the Spartans that here, obedient to their laws, we lie.\"", "graphic", "none"],
  ["S9", "stock", "Plutarch", "an ancient manuscript page under glass in a museum, close, slow", "The famous answer, \"Come and take them\", does not appear in Herodotus. It was written down by Plutarch, five centuries later.", "object", "camera_only"],
  ["S9", "stock", "bones home", "olive groves and the Eurotas valley near Sparta at evening with Taygetus behind", "About forty years after the battle, Leonidas's bones were carried home to Sparta, and games were held there in his name every year.", "landscape", "simple"],
  ["S9", "stock", "the sea has gone", "wide aerial of the Thermopylae plain at sunset: the highway, farmland, the cliffs, the sea a line far away", "The sea has gone. The gates are quiet.", "landscape", "simple"],
  ["S9", "stock", "still in it", "the Kolonos mound at Thermopylae today with its inscription slab, low sun, slow push in", "But the low hill is still where it was, and the arrowheads were still in it.", "landscape", "simple"],
  ["S9", "graphic", "end card", "end card: title and channel name on black, no other text", "(end)", "graphic", "none"],
];

const KIND: Record<Kind, { assetType: ProductionShotRecordInput["assetType"]; sourceProvider: ProductionShotRecordInput["sourceProvider"]; cameraBehavior: ProductionShotRecordInput["cameraBehavior"]; historical: ProductionShotRecordInput["historicalClassification"]; stockAvailable: boolean }> = {
  stock: { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", historical: "real_documented", stockAvailable: true },
  still: { assetType: "ken_burns_image", sourceProvider: "openai", cameraBehavior: "ken_burns", historical: "reconstruction", stockAvailable: false },
  parallax: { assetType: "ken_burns_image", sourceProvider: "openai", cameraBehavior: "parallax", historical: "reconstruction", stockAvailable: false },
  ai: { assetType: "ai_video", sourceProvider: "runway", cameraBehavior: "generated", historical: "reconstruction", stockAvailable: false },
  graphic: { assetType: "diagram", sourceProvider: "internal", cameraBehavior: "static", historical: "reconstruction", stockAvailable: false },
};

export const secondsOf = (row: Row) => (row[2] === "end card" ? 1.5 : secondsFor(row[4], row[2]));

export function video004ShotRecords(opts: { includeGraphics?: boolean } = {}): ProductionShotRecord[] {
  const rows = opts.includeGraphics === false ? ROWS.filter((r) => r[1] !== "graphic") : ROWS;
  return rows.map((row, i) => {
    const [scene, kind, purpose, visual, narration, cls, motion, leverage, risk, continuity, hero] = row;
    const k = KIND[kind];
    const isGraphic = kind === "graphic";
    const seconds = secondsOf(row);
    return parseShotRecord({
      contract: {
        shotId: `V4-${String(i + 1).padStart(3, "0")}`, shotClass: cls ?? (isGraphic ? "graphic" : "landscape"), narrationIntent: narration, visualIntent: visual,
        forbiddenElements: FORBIDDEN, continuityGroup: continuity ?? null,
        motionRequirement: motion ?? (kind === "stock" ? "simple" : isGraphic ? "none" : "camera_only"),
        motionLeverage: leverage ?? (kind === "ai" ? "HIGH" : "LOW"), riskClass: risk ?? "LOW",
        desiredDuration: seconds, maxGeneratedDuration: kind === "ai" ? (hero ? 10 : Math.min(10, seconds)) : 0,
        qualityTier: hero ? "hero" : kind === "ai" ? "standard" : "economy",
        stockAvailable: k.stockAvailable,
      },
      sceneId: scene, blockId: scene, timelineOrder: i, narrativePurpose: purpose, assetType: k.assetType, sourceProvider: k.sourceProvider,
      durationTargetSec: seconds, minVisibleSec: Math.min(2.5, seconds), cameraBehavior: k.cameraBehavior, transitionIn: "cut",
      historicalClassification: k.historical, subtitleInteraction: isGraphic ? "avoid_lower_third" : "normal",
    });
  });
}

export const VIDEO_004 = {
  projectId: "video-004-thermopylae", title: "Three Days at the Hot Gates", channel: "EARTHWARD CHRONICLES", language: "en",
  targetSeconds: ROWS.reduce((t, r) => t + secondsOf(r), 0),
  narrationWords: ROWS.slice(0, -1).reduce((t, r) => t + words(r[4]), 0),
};
