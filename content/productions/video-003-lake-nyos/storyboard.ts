/**
 * Video #003 — real storyboard: every shot is an explicit Production Intelligence shot record.
 * Built from SCRIPT.md scene by scene. No placeholder shots. Generic real footage (stock) is used
 * only where a licensable clip plausibly exists (crater lakes, volcanic highlands, night skies,
 * cattle, Kivu/Goma skyline, laboratory/instrument b-roll); anything specific to the event is an
 * AI still or a labelled AI reconstruction (historicalClassification = reconstruction, provenance
 * ai_recreation is attached by the pipeline when generated). No victims are ever depicted.
 */
import { parseShotRecord, type ProductionShotRecord, type ProductionShotRecordInput } from "../../../src/lib/production-core/shot-record";
import { PRODUCTION_POLICY_V1 } from "../../../src/lib/production-core/policy-engine";

type Kind = "stock" | "still" | "parallax" | "ai" | "graphic";
type Row = [scene: string, kind: Kind, seconds: number, purpose: string, visual: string, narration: string, cls?: ProductionShotRecordInput["contract"]["shotClass"], motion?: "none" | "camera_only" | "simple" | "complex", leverage?: "LOW" | "MEDIUM" | "HIGH", risk?: "LOW" | "MEDIUM" | "HIGH", continuity?: string];

const FORBIDDEN = [...PRODUCTION_POLICY_V1.content.forbiddenElementsGlobal, "human bodies or victims", "gore", "identifiable real faces"];

/** scene, kind, seconds, narrative purpose, visual intent, narration intent, class, motion, leverage, risk, continuity group */
export const ROWS: Row[] = [
  // S1 HOOK 0:00–0:38 — fast rhythm, motion from second 0
  ["S1", "stock", 3, "hook: night highlands", "aerial night over mist-filled tropical highland valleys, faint village lights", "On the night of August 21st, 1986", "landscape", "simple"],
  ["S1", "ai", 4, "hook: the lake at night", "still dark crater lake under stars, mist drifting over the water, steep rim", "in the highlands of Cameroon, a valley went quiet", "landscape", "simple", "HIGH", "LOW", "lake-night"],
  ["S1", "stock", 3, "hook: silence", "cattle standing still in a dark pasture, breath in cold air", "No fire. No explosion.", "creature", "simple"],
  ["S1", "stock", 3, "hook: silence", "empty dirt road between huts at night, no movement, wind in grass", "No storm.", "landscape", "simple"],
  ["S1", "parallax", 4, "hook: morning aftermath", "dawn light over an empty valley of scattered huts, no people, birds", "By morning, more than seventeen hundred people were dead", "landscape", "camera_only"],
  ["S1", "stock", 3, "hook: cattle", "cattle lying in a field at dawn, seen from a distance, mist", "along with thousands of cattle", "creature", "simple"],
  ["S1", "ai", 4, "hook: distance", "wide shot of green highland valleys receding toward a distant crater lake, morning haze", "in villages up to twenty-five kilometres from a small, beautiful lake", "landscape", "camera_only", "MEDIUM", "LOW"],
  ["S1", "ai", 5, "hook: the invisible killer", "low white cloud creeping over grass in darkness, seen from ground level, faint moonlight", "The killer had no colour and no smell.", "landscape", "complex", "HIGH", "LOW", "gas-cloud"],
  ["S1", "still", 4, "hook: nobody knew", "empty village square with a single lantern, dawn, fog", "For days, nobody could say what it was.", "landscape", "camera_only"],
  ["S1", "ai", 5, "title", "calm crater lake surface at sunrise, a single ring of ripples expanding", "the night it finally exhaled", "landscape", "simple", "HIGH", "LOW", "lake-day"],
  // S2 THE LAKE 0:38–1:45
  ["S2", "stock", 8, "geography", "aerial over volcanic mountains of West Africa, cloud shadows moving", "Lake Nyos sits in a volcanic crater in north-west Cameroon", "landscape", "simple"],
  ["S2", "graphic", 6, "map", "map of West Africa with the Cameroon Volcanic Line drawn as a chain from the Gulf of Guinea to the interior, Nyos marked", "a chain of volcanoes geologists call the Cameroon Volcanic Line", "map", "none"],
  ["S2", "ai", 7, "scale", "aerial of a round crater lake about a kilometre across, steep walls, green rim", "It is not large. About a kilometre across.", "landscape", "camera_only", "MEDIUM", "LOW", "lake-day"],
  ["S2", "graphic", 7, "depth", "cross-section diagram: crater bowl, water 200 m deep, natural dam of volcanic rock on the north side", "But it is deep — around two hundred metres", "graphic", "none"],
  ["S2", "parallax", 7, "the dam", "close view of a narrow ridge of loose grey-brown volcanic rock holding back the lake", "on one side, a natural dam of loose volcanic rock", "landscape", "camera_only"],
  ["S2", "stock", 7, "calm", "calm mountain lake reflecting sky, gentle breeze", "From the rim it looks like any calm mountain lake.", "landscape", "simple"],
  ["S2", "stock", 7, "life on the slopes", "cattle grazing on green highland slopes, herders in the distance", "Farmers kept cattle on the slopes.", "creature", "simple"],
  ["S2", "stock", 7, "villages", "thatched and tin-roof village in a green valley below a crater rim, afternoon", "Villages sat in the valleys below.", "landscape", "camera_only"],
  ["S2", "ai", 8, "foreshadow", "slow descent into dark lake water, light fading, tiny bubbles", "Nothing about the surface suggested what was dissolved underneath.", "other", "complex", "HIGH", "LOW", "underwater"],
  // S3 THE MYSTERY 1:45–3:10
  ["S3", "stock", 7, "confusion", "1980s-style radio and notebook on a wooden table, dim room", "The first reports were confusing.", "object", "camera_only"],
  ["S3", "ai", 7, "rumble", "night valley, treetops shaking slightly, birds bursting from trees", "Survivors described a rumbling sound", "landscape", "complex", "MEDIUM", "LOW", "night-valley"],
  ["S3", "still", 6, "smell", "mist drifting between dark huts, lantern glow", "then a smell like rotten eggs, then a strange warmth", "landscape", "camera_only"],
  ["S3", "stock", 7, "silence", "dawn light through an open doorway onto an empty room, dust in the air", "Some woke a day and a half later, surrounded by silence.", "corridor", "camera_only"],
  ["S3", "still", 8, "Subum", "quiet village lane at first light, mist, no people", "One man from the village of Subum said he woke around midnight", "landscape", "camera_only"],
  ["S3", "still", 7, "no wounds", "abandoned cooking fire gone cold outside a hut, morning", "There were no burns. No wounds.", "object", "camera_only"],
  ["S3", "stock", 6, "animals", "cattle lying in grass, wide, distant, mist", "Animals lay where they had stood.", "creature", "simple"],
  ["S3", "graphic", 6, "Monoun map", "map: Lake Nyos and Lake Monoun about 100 km apart in western Cameroon", "Two years earlier, at Lake Monoun, a hundred kilometres to the south", "map", "none"],
  ["S3", "still", 7, "Monoun", "small dark crater lake surrounded by forest, overcast", "thirty-seven people had died the same way", "landscape", "camera_only"],
  ["S3", "stock", 6, "suspicion", "official documents and a typewriter, dim light", "Poison was suspected. Sabotage was suspected.", "object", "camera_only"],
  ["S3", "stock", 6, "volcano suspected", "distant volcano with a plume at dusk", "A volcanic eruption was suspected.", "landscape", "simple"],
  ["S3", "ai", 8, "the red lake", "crater lake seen from the rim, water rusty red-brown instead of blue, morning light", "But the lake was still there. Only its colour had changed.", "landscape", "camera_only", "HIGH", "LOW", "lake-red"],
  ["S3", "parallax", 7, "red water close", "close view of rust-red water lapping on dark volcanic shore", "The clear water had turned a rusty red.", "landscape", "camera_only", undefined, undefined, "lake-red"],
  // S4 THE SCIENCE 3:10–5:15
  ["S4", "ai", 7, "under the surface", "camera sinks below the surface of a dark lake, light rays fading", "The answer was under the surface.", "other", "complex", "HIGH", "LOW", "underwater"],
  ["S4", "graphic", 7, "CO2 source", "diagram: magma chamber deep below the crater, CO2 seeping up through fractured rock into the lake bed", "Beneath the crater, volcanic activity releases carbon dioxide.", "graphic", "none"],
  ["S4", "ai", 7, "seep", "tiny gas bubbles rising from a dark sandy lake bed in near-darkness", "It seeps upward through the lake bed and dissolves into the deepest water.", "other", "complex", "MEDIUM", "LOW", "underwater"],
  ["S4", "stock", 6, "soda bottle", "close-up of a sealed carbonated bottle, condensation, no bubbles visible", "Under pressure, water can hold enormous amounts of gas", "object", "simple"],
  ["S4", "stock", 5, "soda opened", "bottle opened, sudden fizz of bubbles", "like a sealed bottle of soda.", "object", "simple"],
  ["S4", "graphic", 8, "stratification", "layered cross-section of the lake: warm surface layer, cold dense CO2-rich bottom layer, no mixing", "Lake Nyos is also stratified. The bottom layer, cold and heavy with gas, almost never mixes", "graphic", "none"],
  ["S4", "parallax", 6, "charging", "the crater lake at dusk, water darkening, seasons passing in the light on the crater walls", "year after year, the gas kept accumulating. The lake was charging.", "landscape", "camera_only", undefined, undefined, "lake-day"],
  ["S4", "ai", 7, "trigger 1", "night, a slope of rock and soil sliding into dark lake water, splash", "A landslide into the lake", "landscape", "complex", "HIGH", "MEDIUM", "night-valley"],
  ["S4", "stock", 6, "trigger 2", "heavy tropical rain on a dark lake surface", "or a slug of cold rainwater sinking through the layers", "landscape", "simple"],
  ["S4", "graphic", 6, "lift", "diagram: parcel of deep water displaced upward, pressure dropping", "any of these could have lifted gas-rich water just far enough.", "graphic", "none"],
  ["S4", "ai", 7, "bubbles form", "in dark water, bubbles nucleating and multiplying, rushing upward", "As it rose, the pressure dropped. Bubbles formed.", "other", "complex", "HIGH", "LOW", "underwater"],
  ["S4", "ai", 7, "runaway", "underwater view looking up: a column of bubbles exploding toward the surface", "In seconds, the process ran away.", "other", "complex", "HIGH", "LOW", "underwater"],
  ["S4", "ai", 8, "the eruption", "night crater lake, a surge of dark water and white spray heaving upward from the centre, mist", "The lake erupted — not lava, but gas.", "landscape", "complex", "HIGH", "MEDIUM", "lake-night"],
  ["S4", "ai", 7, "surge on shore", "night shoreline, wave of water and mist rushing up dark volcanic rock", "Shoreline damage suggests a surge of water tens of metres high.", "landscape", "complex", "HIGH", "MEDIUM", "lake-night"],
  ["S4", "ai", 8, "the invisible flood", "dense low white cloud pouring over the crater rim and down a grassy slope at night, treetops emerging", "settled back onto the lake and poured over the crater rim like an invisible flood", "landscape", "complex", "HIGH", "LOW", "gas-cloud"],
  ["S4", "ai", 7, "down the valleys", "aerial night view of a pale cloud filling valley floors between dark hills", "tens of metres thick, flowing downhill at up to fifty kilometres an hour", "landscape", "complex", "HIGH", "LOW", "gas-cloud"],
  ["S4", "still", 7, "it filled the valleys", "dark village huts half-hidden in a low ground fog, moonlight", "It filled the valleys. It displaced the air.", "landscape", "camera_only", undefined, undefined, "gas-cloud"],
  ["S4", "still", 7, "silence", "same valley at dawn, clear air, absolute stillness", "And it left, the way it came, in silence.", "landscape", "camera_only"],
  ["S4", "parallax", 8, "iron", "close view of rust-red lake water with orange foam at the shore", "The red colour was iron from the deep water, oxidizing at the surface", "landscape", "camera_only", undefined, undefined, "lake-red"],
  // S5 THE FIX 5:15–7:10
  ["S5", "still", 7, "recharge", "lake at dusk, glassy, ominous calm", "The disturbing part was not the eruption. It was the recharge.", "landscape", "camera_only", undefined, undefined, "lake-day"],
  ["S5", "stock", 7, "measurements", "scientific instruments and sample bottles on a small boat", "Measurements showed the gas was building up again.", "object", "simple"],
  ["S5", "graphic", 6, "rising again", "diagram: gas concentration curve climbing again toward a danger line", "Unless something changed, Nyos would exhale a second time.", "graphic", "none"],
  ["S5", "stock", 6, "a pipe", "a long pale pipe lying on a lakeshore, engineers' gear beside it", "The solution was a pipe.", "object", "camera_only"],
  ["S5", "ai", 8, "lowering", "raft on a crater lake, a pipe descending into dark water, ripples", "engineers lowered a pipe from a raft to the bottom of the lake", "object", "complex", "MEDIUM", "MEDIUM", "raft"],
  ["S5", "graphic", 7, "self-sustaining", "diagram: water rising in the pipe, bubbles forming, column accelerating, fountain at top", "Gas-rich water rising in the pipe begins to fizz; the bubbles lift the column", "graphic", "none"],
  ["S5", "ai", 8, "the fountain", "white jet of water and spray shooting tens of metres into the air from a small raft on a calm crater lake, daylight", "A fountain shot into the air — a controlled, permanent exhale", "landscape", "complex", "HIGH", "LOW", "fountain"],
  ["S5", "parallax", 7, "fountain detail", "close view of the fountain's white plume against green crater walls", "driven by the lake's own pressure", "landscape", "camera_only", undefined, undefined, "fountain"],
  ["S5", "still", 7, "three pipes", "three fountains on a crater lake seen from the rim", "Two more pipes followed in 2011.", "landscape", "camera_only", undefined, undefined, "fountain"],
  ["S5", "graphic", 7, "steady state", "diagram: gas in equals gas out, concentration curve flattening", "By 2019, the gas leaving through the pipes balanced the gas seeping in.", "graphic", "none"],
  ["S5", "parallax", 7, "the dam again", "narrow ridge of weak volcanic rock with the lake behind it, erosion scars", "The weak natural dam was another problem", "landscape", "camera_only"],
  ["S5", "graphic", 6, "flood path", "map: flood path from Nyos northward across the border toward Nigeria, about 100 km", "a flood a hundred kilometres downstream", "map", "none"],
  ["S5", "still", 7, "reinforced", "concrete cap and grouted slope on a rocky ridge above a lake", "It has since been reinforced with grouting and a concrete cap.", "object", "camera_only"],
  ["S5", "stock", 7, "monitoring", "data logger and sensor buoy on calm water", "The lake is monitored.", "object", "simple"],
  ["S5", "ai", 7, "fountain runs", "the degassing fountain at golden hour, spray catching light", "The fountain still runs.", "landscape", "complex", "MEDIUM", "LOW", "fountain"],
  // S6 KIVU 7:10–9:05
  ["S6", "still", 6, "small lakes", "two small crater lakes seen from above, forest around them", "Nyos and Monoun are small.", "landscape", "camera_only"],
  ["S6", "stock", 8, "Kivu", "wide aerial of a vast lake with mountains and a city on the shore at dusk", "There is a third lake. Lake Kivu", "landscape", "simple"],
  ["S6", "graphic", 6, "Kivu map", "map: Lake Kivu between Rwanda and the Democratic Republic of the Congo, Goma and Gisenyi marked", "on the border of Rwanda and the Democratic Republic of the Congo", "map", "none"],
  ["S6", "parallax", 7, "scale", "aerial: a tiny crater lake in the foreground and a vast inland sea stretching to the horizon behind mountains", "is roughly three thousand times bigger.", "landscape", "camera_only"],
  ["S6", "ai", 8, "deep water", "dark deep lake water with faint bubbles, immense scale suggested by fading light", "Its deep water holds around three hundred cubic kilometres of dissolved carbon dioxide", "other", "complex", "MEDIUM", "LOW", "underwater"],
  ["S6", "graphic", 7, "gas volumes", "diagram: 300 km³ CO2 and 60 km³ methane as stacked volumes", "and sixty cubic kilometres of methane", "graphic", "none"],
  ["S6", "stock", 8, "two million", "busy lakeside city streets and shoreline, evening", "Around two million people live on its shores.", "multi_human", "simple"],
  ["S6", "stock", 7, "measured", "scientists deploying instruments from a boat on a large lake", "Here, the science is measured carefully", "multi_human", "simple"],
  ["S6", "graphic", 7, "steady", "diagram: Kivu gas concentration flat over recent decades, labelled 'close to steady state'", "the gas is close to a steady state, and there is no sign that an eruption is imminent", "graphic", "none"],
  ["S6", "stock", 8, "KivuWatt", "offshore gas extraction platform on a lake at dusk, lights on", "Rwanda extracts methane from the deep water to generate electricity", "object", "simple"],
  ["S6", "graphic", 6, "fraction", "diagram: small slice removed from a large volume of gas", "at present rates only a small fraction of the gas.", "graphic", "none"],
  ["S6", "stock", 7, "sediment", "sediment core sections laid on a table, layered mud", "Sediment studies suggest Kivu may have erupted thousands of years ago.", "object", "camera_only"],
  ["S6", "stock", 8, "city at night", "lakeside city lights reflected on dark water at night", "Nobody wants to learn what that looked like with cities on the shore.", "landscape", "simple"],
  // S7 ENDING 9:05–10:05
  ["S7", "ai", 8, "a lake like a volcano", "calm crater lake at dawn, thin mist lifting off the water", "Lake Nyos taught the world that a lake can behave like a volcano", "landscape", "simple", "HIGH", "LOW", "lake-day"],
  ["S7", "graphic", 6, "same physics", "diagram: the eruption bubble column and the pipe fountain side by side, same mechanism", "the same physics that made it deadly could be used to make it safe.", "graphic", "none"],
  ["S7", "stock", 7, "patience", "scientist writing in a field notebook beside instruments", "A pipe, a fountain, and the patience to keep measuring.", "single_human", "simple"],
  ["S7", "ai", 8, "the rim", "view from a grassy crater rim: the lake below, a white fountain rising from its centre, calm day", "you can stand on the crater rim and watch a jet of white water rise from the middle of the lake.", "landscape", "complex", "HIGH", "LOW", "fountain"],
  ["S7", "parallax", 8, "breathing out", "the fountain's spray drifting slowly in sunlight, crater walls behind", "It is the lake breathing out — slowly, on purpose", "landscape", "camera_only", undefined, undefined, "fountain"],
  ["S7", "ai", 8, "closing", "wide aerial pulling away from the crater lake and its fountain into the green highlands", "so that it never has to do it all at once again.", "landscape", "simple", "HIGH", "LOW", "lake-day"],
  ["S7", "graphic", 1.5, "end card", "end card: title and channel name on black, no other text", "(end)", "graphic", "none"],
];

const KIND: Record<Kind, { assetType: ProductionShotRecordInput["assetType"]; sourceProvider: ProductionShotRecordInput["sourceProvider"]; cameraBehavior: ProductionShotRecordInput["cameraBehavior"]; historical: ProductionShotRecordInput["historicalClassification"]; stockAvailable: boolean }> = {
  stock: { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", historical: "real_documented", stockAvailable: true },
  still: { assetType: "ken_burns_image", sourceProvider: "openai", cameraBehavior: "ken_burns", historical: "reconstruction", stockAvailable: false },
  parallax: { assetType: "ken_burns_image", sourceProvider: "openai", cameraBehavior: "parallax", historical: "reconstruction", stockAvailable: false },
  ai: { assetType: "ai_video", sourceProvider: "runway", cameraBehavior: "generated", historical: "reconstruction", stockAvailable: false },
  graphic: { assetType: "diagram", sourceProvider: "internal", cameraBehavior: "static", historical: "reconstruction", stockAvailable: false },
};

export function video003ShotRecords(opts: { includeGraphics?: boolean } = {}): ProductionShotRecord[] {
  const rows = opts.includeGraphics === false ? ROWS.filter((r) => r[1] !== "graphic") : ROWS;
  return rows.map((row, i) => {
    const [scene, kind, seconds, purpose, visual, narration, cls, motion, leverage, risk, continuity] = row;
    const k = KIND[kind];
    const isGraphic = kind === "graphic";
    return parseShotRecord({
      contract: {
        shotId: `V3-${String(i + 1).padStart(3, "0")}`, shotClass: cls ?? (isGraphic ? "graphic" : "landscape"), narrationIntent: narration, visualIntent: visual,
        forbiddenElements: FORBIDDEN, continuityGroup: continuity ?? null,
        motionRequirement: motion ?? (kind === "stock" ? "simple" : isGraphic ? "none" : "camera_only"),
        motionLeverage: leverage ?? (kind === "ai" ? "HIGH" : "LOW"), riskClass: risk ?? "LOW",
        desiredDuration: seconds, maxGeneratedDuration: kind === "ai" ? Math.min(10, seconds) : 0, qualityTier: kind === "ai" && (leverage ?? "HIGH") === "HIGH" ? "standard" : "economy",
        stockAvailable: k.stockAvailable,
      },
      sceneId: scene, blockId: scene, timelineOrder: i, narrativePurpose: purpose, assetType: k.assetType, sourceProvider: k.sourceProvider,
      durationTargetSec: seconds, minVisibleSec: Math.min(2.5, seconds), cameraBehavior: k.cameraBehavior, transitionIn: i === 0 ? "cut" : "cut",
      historicalClassification: k.historical, subtitleInteraction: isGraphic ? "avoid_lower_third" : "normal",
    });
  });
}

export const VIDEO_003 = { projectId: "video-003-lake-nyos", title: "The Lake That Held Its Breath", channel: "EARTHWARD CHRONICLES", language: "en", targetSeconds: 605, narrationWords: 1010 };
