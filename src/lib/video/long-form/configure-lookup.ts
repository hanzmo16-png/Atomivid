import type { SupabaseClient } from "@supabase/supabase-js";
import { isLongFormScriptJson, type LongFormScriptJson } from "./script-json";

export type ConfigurableRequest = { id: string; mode: string; topic: string; status: string; duration_seconds: number | null; script_json: LongFormScriptJson; long_form_confirmed_at: string | null };
export type ConfigureLookup =
  | { kind: "not_found"; reason: "no_access" | "invalid_id" | "missing" | "not_long_form" }
  | { kind: "redirect"; to: string }
  | { kind: "ok"; data: ConfigurableRequest };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every outcome of /dashboard/long-form/configure/[id]. The id is a
 * video_requests.id (a documentary job links with its request_id), read with
 * the caller's own session and owner filter. Reading never confirms production. */
export async function lookupConfigurableRequest(client: SupabaseClient, user: { id: string }, id: string, hasAccess: boolean): Promise<ConfigureLookup> {
  if (!hasAccess) return { kind: "not_found", reason: "no_access" };
  if (!UUID.test(id)) return { kind: "not_found", reason: "invalid_id" };
  const { data } = await client.from("video_requests")
    .select("id, mode, topic, status, duration_seconds, script_json, long_form_confirmed_at")
    .eq("id", id).eq("user_id", user.id).maybeSingle<Omit<ConfigurableRequest, "script_json"> & { script_json: unknown }>();
  if (!data) return { kind: "not_found", reason: "missing" };
  if (data.mode !== "long_form") return { kind: "not_found", reason: "not_long_form" };
  if (data.long_form_confirmed_at) return { kind: "redirect", to: `/dashboard/videos/${id}` };
  if (data.status !== "script_ready" || !isLongFormScriptJson(data.script_json)) return { kind: "redirect", to: "/dashboard" };
  return { kind: "ok", data: data as ConfigurableRequest };
}
