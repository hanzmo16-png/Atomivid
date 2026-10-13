/**
 * «Una nave entre dos mundos» — AI fiction test sequence authorised by Hans (2026-10-13, spend authorised, no cap).
 * Six beats, eight planned shots (≈55 s), 9:16 (the only aspect the Director render bridge supports). Every shot is a real-motion
 * Veo clip generated from a keyframe; keyframes are built from two reference sheets (ship, creature) so the ship and
 * the creature keep their design across the sequence. Screen direction: the ship always travels LEFT → RIGHT.
 */
export const SHIP =
  "the same sleek futuristic scout ship: elongated arrowhead hull about 30 metres long, matte graphite-grey armour plates " +
  "with a single bright orange stripe along each flank, swept-back twin wings with orange tips, two cyan-blue ion engines at the rear, " +
  "a dark tinted cockpit canopy near the nose, small white navigation lights on the wing tips";
export const CREATURE =
  "the same colossal deep-sea leviathan: hundreds of metres long, eel-like body with dark slate-blue skin and paler belly, " +
  "rows of faint bioluminescent turquoise spots along its flanks, a broad armoured head with four small amber eyes, " +
  "long trailing fin membranes, slow and heavy movement";
export const STYLE =
  "photorealistic cinematic film still, anamorphic lens, natural film grain, high dynamic range, physically accurate lighting, " +
  "vertical 9:16 composition, no text, no logos, no watermark";
// "HUD … ECG line" added after run 8: s06 asked for a heartbeat-like *sound* and Veo drew a glowing ECG trace beside the eye.
export const NEGATIVE = "text, captions, subtitles, logos, watermark, cartoon, low detail, distorted ship, extra wings, morphing ship design, humans, people, HUD, on-screen graphics, user interface overlay, heartbeat monitor, ECG line";

export type RefId = "ship" | "creature";
export type Shot = {
  id: string; beat: number;
  /** narrative line: the Director's anchor (recipe keywords). Not voiced, not shown. */
  text: string;
  /** planned seconds on screen (the Veo clip is 8 s; the Director uses the first `seconds`). */
  seconds: number;
  refs: RefId[];
  keyframe: string;
  motion: string;
  subject: string; action: string; environment: string; shotType: string; camera: string; lighting: string; energy: "low" | "medium" | "high";
  concepts: string[];
};

export const REFS: Record<RefId, string> = {
  ship: `Concept-art reference sheet on a neutral light-grey studio background: ${SHIP}. Show the ship three times: side view, three-quarter front view and top view, same scale, clean even lighting, photoreal materials. No text, no labels.`,
  creature: `Creature design reference sheet on a dark neutral background: ${CREATURE}. Show it twice: full-body side view and a close-up of the head with its four amber eyes. Photoreal skin, underwater lighting feel. No text, no labels.`,
};

export const IDENTITY = { place: "montañas con niebla y cascadas, cañón, océano abierto y abismo marino", palette: "grafito y naranja de la nave; verdes y grises de montaña; azul profundo y turquesa bioluminiscente",
  lighting: "luz natural dorada → luz submarina azul verdosa → oscuridad con haces de luz", tone: "asombro y tensión", arc: "del aire al abismo: vuelo, inmersión, encuentro e intriga",
  recurring: "la misma nave (grafito con franja naranja, motores cian) y la misma criatura (anguila colosal azul pizarra, cuatro ojos ámbar)" };

export const SHOTS: Shot[] = [
  { id: "s01", beat: 1, seconds: 7, refs: ["ship"], energy: "medium",
    text: "Una nave cruza un mundo de montañas gigantes, niebla y cascadas.",
    subject: "futuristic scout ship", action: "flies left to right, tiny against colossal mountains", environment: "giant misty mountains with waterfalls", shotType: "extreme wide establishing shot", camera: "slow crane up and push forward", lighting: "golden morning light through clouds",
    concepts: ["futuristic ship over giant mountains", "misty waterfalls landscape"],
    keyframe: `Extreme wide shot of gigantic jagged mountains wrapped in mist with several enormous waterfalls; ${SHIP} appears tiny in the lower left third, flying toward the right. Golden morning light breaking through the clouds. The scale of the landscape dwarfs the ship.`,
    motion: "The camera slowly cranes up and pushes forward, revealing more of the colossal mountains and waterfalls while the small ship flies steadily from left to right with its engines glowing; mist drifts, water falls continuously. Deep wind and distant waterfall roar." },
  { id: "s02", beat: 2, seconds: 7, refs: ["ship"], energy: "high",
    text: "Maniobra entre paredes de roca y emerge sobre un océano inmenso.",
    subject: "futuristic scout ship", action: "banks between canyon walls and bursts out over the ocean, left to right", environment: "narrow rock canyon opening to an immense ocean", shotType: "tracking shot", camera: "fast lateral follow, then pull back", lighting: "sunlight from above, bright ocean ahead",
    concepts: ["ship maneuvering in canyon", "ship emerging over ocean"],
    keyframe: `Dynamic tracking shot inside a narrow canyon of towering wet rock walls. ${SHIP} banks hard while flying toward the RIGHT side of the frame: its pointed nose and dark canopy face RIGHT, toward a gap in the canyon on the right edge where an immense bright ocean is visible; its two cyan engines glow on the LEFT end of the hull, pointing back toward the left edge. Sunlight from above.`,
    motion: "The ship weaves between the canyon walls from left to right, the camera follows close with a fast lateral move, then the ship bursts out of the canyon over the endless ocean and the camera pulls back to reveal the vast sea, keeping the same left-to-right direction. Engine roar echoing off rock, then wind over the sea." },
  { id: "s03", beat: 3, seconds: 7.5, refs: ["ship"], energy: "high",
    text: "Desciende y se hunde en el mar: impacto, espuma y burbujas.",
    subject: "futuristic scout ship", action: "dives and plunges into the ocean, continuing underwater", environment: "open ocean surface and just below it", shotType: "wide shot at water level", camera: "follows the ship down through the surface", lighting: "sunset surface light shifting to blue-green underwater",
    concepts: ["ship diving into the ocean", "splash and bubbles underwater"],
    keyframe: `Low wide shot just above the ocean surface: ${SHIP} diving steeply toward the water from the upper left, nose down, engines glowing cyan, waves below, warm late-afternoon light.`,
    motion: "The ship dives and slams into the ocean, a huge white splash erupts; the camera follows it through the surface into the water: dense bubbles, foam, and the light shifts from bright surface glare to deep blue-green as the ship descends. Thunderous impact, splash, then muffled underwater rumble and bubbles." },
  { id: "s04", beat: 4, seconds: 7, refs: ["ship", "creature"], energy: "low",
    text: "Sus luces recorren la oscuridad; una sombra gigantesca pasa a lo lejos.",
    subject: "the ship's lights and a distant giant shadow", action: "lights sweep the dark while a huge silhouette crosses far away", environment: "dark deep sea with drifting particles over a rocky floor", shotType: "wide dark underwater shot", camera: "slow, almost static", lighting: "white headlight beams in near darkness",
    concepts: ["ship headlights in deep sea", "giant shadow in the distance"],
    keyframe: `Dark deep-sea wide shot: ${SHIP} in the right foreground gliding with its white headlights cutting beams through suspended particles over a rocky sea floor; far in the murky background the immense dark silhouette of ${CREATURE} is barely visible.`,
    motion: "The ship glides slowly left to right, its light beams sweeping across rocks and drifting particles; far in the background the enormous dark shape slowly crosses from right to left, half hidden in the murk. Low pressure hum, a distant sonar ping and a deep far-off groan." },
  { id: "s05", beat: 5, seconds: 7, refs: ["ship", "creature"], energy: "medium",
    text: "Aparece una criatura colosal.",
    subject: "colossal leviathan and the tiny ship", action: "the creature slides out of the darkness past the tiny ship", environment: "dark open water", shotType: "wide scale composition", camera: "contained, almost static", lighting: "ship lights on a patch of the creature's skin, turquoise bioluminescence",
    concepts: ["colossal sea creature", "tiny ship scale contrast"],
    keyframe: `Wide scale composition in dark water: ${CREATURE} fills most of the frame, its head and bioluminescent flank emerging from the darkness above; ${SHIP} tiny in the lower right, its lights illuminating a small patch of the creature's skin.`,
    motion: "The creature moves slowly and heavily, its body sliding past in the darkness; the tiny ship holds still, lights trembling; contained, almost static camera. Deep resonant creature call." },
  { id: "s06", beat: 5, seconds: 5.5, refs: ["creature"], energy: "low",
    text: "Su mirada se posa en la nave.",
    subject: "one amber eye of the creature", action: "the eye opens and focuses, the ship's lights reflected in it", environment: "close to the creature's head", shotType: "extreme close-up", camera: "static", lighting: "raking light, reflections",
    concepts: ["giant amber eye close up", "ship lights reflected in eye"],
    keyframe: `Extreme close-up of the head of ${CREATURE}: one of its four amber eyes, wet textured skin, turquoise bioluminescent spots, two small white lights of a ship reflected in the eye.`,
    motion: "The amber eye slowly opens wider and its pupil contracts, focusing; the skin ripples; particles drift. Sound: a deep, slow underwater rumble and the creature's low breathing; no on-screen graphics." },
  { id: "s07", beat: 6, seconds: 6.5, refs: ["ship", "creature"], energy: "high",
    text: "La criatura se lanza; la nave esquiva.",
    subject: "the creature's open maw and the ship", action: "the creature lunges, the ship veers away to the right", environment: "turbulent dark water", shotType: "dynamic medium shot", camera: "stable, the action moves", lighting: "engine glow and bubbles lit cyan",
    concepts: ["sea monster lunging", "ship dodging underwater"],
    keyframe: `Dynamic dark underwater shot: the huge open maw of ${CREATURE} surging toward the camera from the left; ${SHIP} in the right foreground veering sharply away to the right, engines flaring cyan, bubbles trailing.`,
    motion: "The creature lunges forward, the ship banks hard and escapes to the right at the last instant, leaving a trail of bubbles; turbulent water. Roar, engine surge, rushing water." },
  { id: "s08", beat: 6, seconds: 7.5, refs: ["ship", "creature"], energy: "low",
    text: "En la oscuridad, algo más despierta.",
    subject: "the tiny ship surrounded by distant lights", action: "dozens of turquoise lights of other giant creatures appear around the ship", environment: "pitch-dark deep water", shotType: "final wide shot", camera: "very slow push-in", lighting: "near darkness, turquoise points of light",
    concepts: ["ship alone in dark abyss", "many glowing creature lights"],
    keyframe: `Haunting final wide shot: ${SHIP} hovering small in the center of the frame in pitch-dark water, its lights on; behind and around it, dozens of faint turquoise bioluminescent spots of other giant creatures are appearing in the darkness.`,
    motion: "Very slow push-in toward the small ship as more and more turquoise lights appear around it in the darkness, revealing that it is surrounded. Near silence, then a distant deep call." },
];
