/** Video #003 production plan: per-shot production notes layered on the FROZEN storyboard
 * (content/productions/video-003-lake-nyos, freeze ed78405b…). Nothing here changes a shot's
 * duration, narration, method or provider; it only says HOW each frozen shot is sourced:
 * stock search terms, the still-image style bible, image-to-video motion prompts for the ten
 * generative shots chosen by the deterministic plan, diagram specs, music and on-screen text.
 */

/** Authorized freeze. The runner refuses any other package. */
export const AUTHORIZED_FREEZE_HASH = 'ed78405b8726e16aa7e890247085b6a045706f5b333ba06b0d4c1443b9aaed57';
export const AUTHORIZED_ENGINE_TREE = 'fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef';
/** Hard cap authorized for the project (USD) and the exposure ceiling that stops production. */
export const HARD_CAP_USD = 32;
export const EXPOSURE_CEILING_USD = 29.44;
export const PROVIDER_CEILING_USD: Record<string, number> = { elevenlabs: 10, openai: 20, runway: 20, pexels: 0 };

export const PROJECT = 'video-003-lake-nyos';
export const TITLE = 'The Lake That Held Its Breath';
export const CHANNEL = 'EARTHWARD CHRONICLES';

// ---------------- voice ----------------
/** David (Audiobook & Documentary), already on the account since DULCE Part I. */
export const VOICE = { voiceId: 'cCYjmrGZaI86GUJ7F2Nn', publicOwnerId: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', name: 'David - Audiobook & Documentary' };
export const MODEL = 'eleven_multilingual_v2';
export const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.92 };
/** Pronunciation aliases (each alias is ONE token so the alignment keeps the script's word count). */
export const ALIASES: [string, string][] = [['Nyos', 'Nee-oss'], ['Monoun', 'Moh-noon'], ['Kivu', 'Kee-voo'], ['Subum', 'Soo-boom']];
/** COGS of ElevenLabs characters: marginal price of the owner's top-up (USD 5 for 25,000 credits). */
export const XI_USD_PER_CHAR = 5 / 25000;

// ---------------- stills ----------------
export const IMAGE_MAX_USD = 0.30;
export const STYLE = 'Photorealistic documentary cinematography, 16:9 widescreen, natural light, restrained cinematic colour grade, fine film grain, shallow haze. Setting: the volcanic highlands of north-west Cameroon (green grassy hills, crater lakes with steep walls, red laterite soil, thatched and tin-roof villages). Absolutely no text, letters, captions, logos or watermarks. No people in frame unless the description says so; never any bodies, victims, injured people or animals in distress. Single frame, not a collage.';
export const STILL_NOTES: Record<string, string> = {
  'V3-005': 'Wide, empty, quiet; birds as tiny specks; no figures.',
  'V3-004': 'Night: an empty dirt road between thatched huts, wind moving the grass, faint moonlight; nobody, no vehicles.',
  'V3-038': 'Macro: a sealed plain glass bottle of sparkling water, condensation beading, cap on, no label, no bubbles visible, dark background.',
  'V3-039': 'Macro: the same plain glass bottle just opened, a burst of fizz and bubbles rushing up the neck, no label, dark background.',
  'V3-084': 'Sediment core sections laid in a row on a lab table, layered dark and light mud bands, soft daylight, no labels or text.',
  'V3-007': 'Vast scale; valleys recede toward a small lake in the distance.',
  'V3-009': 'Single lantern on a post, fog; nobody present.',
  'V3-011': 'Clean, serene; one ring of ripples centred; soft dawn light.',
  'V3-014': 'True overhead aerial of a round crater lake, blue-green water, steep forested walls, grassy rim.',
  'V3-020': 'Underwater, looking down into darkness; light rays fading; a few tiny bubbles.',
  'V3-021': 'Period 1980s shortwave radio, a notebook and pencil, dim tungsten light, moody.',
  'V3-023': 'Night, thatched huts in mist, warm lantern glow from one doorway; no people.',
  'V3-026': 'Cold ash and charred logs of an abandoned cooking fire outside a hut, early light.',
  'V3-030': 'Stacked official papers and a manual typewriter on a wooden desk, dim light, no readable text.',
  'V3-031': 'Distant volcano with a soft plume at dusk, seen across a plain; calm.',
  'V3-032': 'Three field scientists in 1980s field clothes on a lakeshore with sample cases and instruments, seen from behind or at a distance, faces not visible.',
  'V3-033': 'The crater lake from the rim, water rusty red-brown, morning light; eerie but calm.',
  'V3-036': 'Not a diagram: a photoreal cutaway impression is NOT wanted. Instead: dark fractured volcanic rock with faint wisps of gas rising, abstract, close.',
  'V3-038': 'Macro of a sealed glass bottle of carbonated water, condensation, no bubbles visible, dark background.',
  'V3-046': 'Underwater in darkness: thousands of small bubbles nucleating and rushing upward, dramatic.',
  'V3-047': 'Underwater looking straight up: a towering column of bubbles exploding toward a pale surface.',
  'V3-048': 'Night: a crater lake with a huge surge of dark water and white spray heaving upward from the centre, mist, moonlight; no people.',
  'V3-049': 'Night shoreline: a wave of water and mist rushing up dark volcanic rock; no people.',
  'V3-050': 'Night: a dense low white cloud pouring over a crater rim and down a grassy slope, treetops emerging from it; eerie, no people.',
  'V3-054': 'A highland valley at dawn, clear air, absolute stillness, empty huts far away; serene and sad.',
  'V3-055': 'Close: rust-red lake water with orange foam lapping on dark volcanic shore.',
  'V3-057': 'A crater lake at dusk, glassy, ominous calm, dark sky.',
  'V3-058': 'Scientific instruments, sample bottles and a probe cable on a small boat, daylight; no faces.',
  'V3-065': 'Three white fountains of water rising from rafts on a calm crater lake, seen from the rim, daylight.',
  'V3-072': 'A degassing fountain of white water jetting from a raft at golden hour, spray catching the light.',
  'V3-074': 'Wide aerial of a vast lake at dusk with volcanic mountains and a city on the shore, lights beginning to show.',
  'V3-077': 'Deep dark lake water with faint bubbles, immense scale suggested by fading light, abstract.',
  'V3-086': 'A calm crater lake at dawn, thin mist lifting off the water, green crater walls.',
  'V3-089': 'From a grassy crater rim: the lake below with a white fountain rising from its centre, calm day.',
  'V3-090': 'Close: the fountain spray drifting slowly in sunlight, green crater walls behind.',
  'V3-091': 'High wide aerial of a crater lake with a fountain at its centre inside green highlands.',
  'V3-002': 'Night: a still dark crater lake under stars, mist drifting over the water, steep rim.',
  'V3-008': 'Night, ground level: a low white cloud creeping over grass, faint moonlight; eerie.',
  'V3-043': 'Night: a dark slope above black lake water, loose rock at the edge; still, no motion implied.',
  'V3-064': 'A white jet of water and spray shooting tens of metres into the air from a small raft on a calm crater lake, daylight.',
};

// ---------------- generative motion (ONLY the ten shots selected by the frozen plan) ----------------
export const MOTION_PROMPTS: Record<string, string> = {
  'V3-002': 'Static camera. Mist drifts slowly across the dark lake surface, stars glimmer faintly, water almost still. Quiet, eerie, photoreal.',
  'V3-008': 'Camera at ground level, static. A low white cloud creeps forward over the grass toward the camera, tendrils of fog curling, faint moonlight. Slow, menacing, photoreal.',
  'V3-046': 'Underwater, static camera. Bubbles nucleate on dark water and multiply, rushing upward faster and faster. Dramatic, photoreal.',
  'V3-047': 'Underwater, looking up. A column of bubbles erupts upward toward the pale surface, turbulent water. Powerful, photoreal.',
  'V3-048': 'Static wide camera at night. The centre of the lake heaves upward into a surge of dark water and white spray, mist spreading outward. Slow motion feel, photoreal, no people.',
  'V3-049': 'Static camera on the night shore. A wave of water and mist rushes up the dark volcanic rock toward the camera. Photoreal, no people.',
  'V3-050': 'Slow aerial push forward. A dense white cloud pours over the crater rim and flows down the grassy slope, treetops emerging as it passes. Eerie, continuous motion, photoreal.',
  'V3-051': 'Slow aerial drift at night. A pale cloud fills the valley floors between dark hills, flowing slowly downhill. Photoreal.',
  'V3-064': 'Static camera. A white jet of water bursts tens of metres into the air from the raft and keeps fountaining, spray drifting in the wind. Daylight, photoreal.',
  'V3-091': 'Slow aerial pull back and up from the crater lake and its fountain, revealing green highlands. Smooth, cinematic, photoreal.',
};
/** Runway accepts 5 or 10 s; the clip must cover the frozen shot. */
export const clipSecondsFor = (shotSeconds: number): 5 | 10 => (shotSeconds <= 5 ? 5 : 10);
export const SEC_USD = 0.05;

// ---------------- stock (Pexels, free; licensed under the Pexels License) ----------------
export const STOCK_QUERIES: Record<string, string[]> = {
  'V3-001': ['aerial misty mountains night', 'foggy valley night aerial', 'mountain village lights night aerial'],
  'V3-003': ['cows night pasture dark', 'cattle at dusk silhouette fog', 'cows standing fog evening field'],
  'V3-004': ['foggy night street empty', 'dark rural night fog trees', 'empty village night lamp fog'],
  'V3-006': ['cows lying in field morning mist', 'cattle resting field fog', 'cows resting at dawn'],
  'V3-010': ['calm crater lake sunrise reflection', 'mountain lake mirror sunrise', 'still lake dawn reflection'],
  'V3-012': ['aerial volcanic mountains africa', 'aerial green mountains clouds shadows', 'aerial highlands cloud shadows'],
  'V3-017': ['calm mountain lake gentle breeze', 'mountain lake reflection calm', 'serene lake mountains'],
  'V3-018': ['cattle grazing green hills', 'cows grazing highland slope', 'herd grazing hills africa'],
  'V3-019': ['african village green valley thatched roofs', 'rural village hills africa', 'tin roof village valley'],
  'V3-021': ['vintage radio close up dim', 'old radio dial wooden table', 'retro radio notebook desk'],
  'V3-024': ['empty room sunbeam dust', 'abandoned house interior light rays', 'sunlight window dust empty'],
  'V3-026': ['extinguished campfire ashes', 'burnt out fire ashes smoke morning', 'cold campfire embers'],
  'V3-027': ['cattle lying in grass mist', 'cows resting in fog field', 'cattle in misty meadow'],
  'V3-030': ['typewriter documents dim light', 'old typewriter close up', 'vintage papers desk lamp'],
  'V3-031': ['volcano plume dusk', 'distant volcano smoke', 'volcano eruption far away'],
  'V3-032': ['scientists field sampling lake shore', 'geologist field work samples', 'researchers collecting water samples'],
  'V3-038': ['glass bottle soda water condensation', 'mineral water bottle close up', 'sparkling water bottle dark background'],
  'V3-039': ['soda bottle opening bubbles close up', 'opening sparkling water bottle fizz', 'bottle cap open carbonation'],
  'V3-042': ['lake at night still water', 'dark lake night calm', 'mountain lake night'],
  'V3-044': ['heavy rain on lake surface', 'tropical rain lake', 'rain falling on dark water'],
  'V3-057': ['still lake dusk reflection calm', 'lake twilight glassy', 'calm lake evening landscape'],
  'V3-058': ['scientific instruments boat lake', 'water sampling bottles boat', 'research equipment on boat'],
  'V3-060': ['large pipe lakeshore engineering', 'pipeline on shore construction', 'engineering pipe water'],
  'V3-070': ['concrete dam wall', 'concrete spillway dam', 'retaining wall concrete slope'],
  'V3-071': ['water monitoring buoy sensor', 'data buoy lake', 'scientific buoy water'],
  'V3-073': ['crater lakes aerial forest', 'twin crater lakes aerial', 'volcanic lakes aerial'],
  'V3-074': ['city on lake shore aerial dusk', 'lakeside city aerial mountains', 'lake city aerial evening'],
  'V3-079': ['african city street evening traffic', 'busy city street africa evening', 'lakeside city evening'],
  'V3-080': ['scientists boat instruments lake', 'researchers deploying equipment boat', 'water sampling boat'],
  'V3-082': ['offshore platform dusk lights', 'gas platform lake', 'industrial platform at dusk'],
  'V3-084': ['drill core samples geology', 'core sample box rock', 'geological survey samples table'],
  'V3-085': ['city lights reflected water night', 'lakeside city night reflection', 'city skyline water night'],
  'V3-087': ['scientist writing field notebook', 'researcher taking notes outdoors', 'writing in notebook field'],
  'V3-092': ['aerial green hills golden hour', 'aerial tropical highlands sunset', 'green mountains golden hour aerial'],
};

// ---------------- graphics (internal, free) ----------------
export type GraphicKind = 'map-cvl' | 'cross-section' | 'map-monoun' | 'co2-source' | 'stratification' | 'lift' | 'curve-rising' | 'siphon' | 'curve-steady' | 'map-flood' | 'map-kivu' | 'volumes' | 'curve-flat' | 'fraction' | 'same-physics' | 'end-card';
export const GRAPHICS: Record<string, GraphicKind> = {
  'V3-013': 'map-cvl', 'V3-015': 'cross-section', 'V3-028': 'map-monoun', 'V3-036': 'co2-source', 'V3-040': 'stratification', 'V3-045': 'lift',
  'V3-059': 'curve-rising', 'V3-062': 'siphon', 'V3-066': 'curve-steady', 'V3-069': 'map-flood', 'V3-075': 'map-kivu', 'V3-078': 'volumes',
  'V3-081': 'curve-flat', 'V3-083': 'fraction', 'V3-088': 'same-physics', 'V3-093': 'end-card',
};

// ---------------- music (licensed library, bucket music-library) ----------------
/** Sections by scene: [trackId, fromScene, toSceneExclusive]. Crossfades handled by the renderer. */
export const MUSIC: [string, string, string | null][] = [
  ['elevenlabs-tension-1', 'S1', 'S3'],
  ['elevenlabs-tension-2', 'S3', 'S5'],
  ['elevenlabs-reflective-1', 'S5', 'S6'],
  ['elevenlabs-minimal-1', 'S6', 'S7'],
  ['elevenlabs-inspirational-2', 'S7', null],
];
/** Music ducks to near silence on these shots (seconds after the shot start, duration). */
export const MUSIC_DROPS: Record<string, [number, number]> = { 'V3-048': [0, 4], 'V3-054': [0, 3] };
/** Synthesized low rumble cues (no SFX library exists in the account): shot id → seconds. */
export const RUMBLE_CUES: Record<string, number> = { 'V3-022': 3, 'V3-048': 4 };

// ---------------- on-screen text ----------------
export const ON_SCREEN_NOTICE = 'Imagery of the 1986 event is reconstruction and illustrative footage';
export const END_CARD_LINES = [TITLE, CHANNEL];
export const CREDITS = 'Sources: Kling et al. 1987 (Science) · Baxter et al. 1989 (BMJ) · Kling et al. 2005 (PNAS) · Kusakabe et al. 2019 · Bärenbold et al. 2020 · Nature 2021. Stock footage: Pexels.';
