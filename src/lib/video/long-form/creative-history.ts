import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreativeHistoryEntry } from "./creative-direction";
import { isLongFormScriptJson } from "./script-json";

export function summarizeCreativeHistory(rows: { topic?: unknown; script_json?: unknown }[]): CreativeHistoryEntry[] {
  return rows.slice(0, 5).flatMap(row => {
    if (!isLongFormScriptJson(row.script_json)) return [];
    const s = row.script_json, d = s.editorial?.creativeDirection;
    const selected = d?.angles?.[d.chosenAngle];
    return [{ topic: s.topic.slice(0, 200), opening: s.beats[0].narration.slice(0, 650),
      ending: s.beats.at(-1)!.narration.slice(-450),
      device: typeof selected?.device === "string" ? selected.device.slice(0, 60) : undefined,
      promise: typeof s.editorial?.storyPlan?.openingPromise === "string" ? s.editorial.storyPlan.openingPromise.slice(0, 250) : undefined,
      structure: s.beats.slice(0, 10).map(b => typeof b.purpose === "string" ? b.purpose.slice(0, 120) : "") }];
  });
}

/** Session client + explicit owner filter; never a cross-customer creative memory.
 * Account scope is intentional: this app has no channel entity on video_requests.
 */
export async function loadCreativeHistory(client: SupabaseClient, authenticatedUserId: string): Promise<CreativeHistoryEntry[]> {
  if (!authenticatedUserId) throw new Error("La memoria creativa requiere una sesión válida.");
  const { data, error } = await client.from("video_requests").select("topic, script_json")
    .eq("user_id", authenticatedUserId).eq("mode", "long_form")
    .order("created_at", { ascending: false }).limit(5);
  if (error) throw new Error("No se pudo consultar tu historial creativo. No se inició la investigación ni la generación.");
  return summarizeCreativeHistory(data ?? []);
}
