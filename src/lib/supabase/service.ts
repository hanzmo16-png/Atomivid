import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "./env";

/**
 * Client authenticated with the Supabase service role key. Bypasses Row
 * Level Security — only use it inside trusted server-only code (the video
 * generation pipeline), never in a component or in code reachable from the
 * browser.
 */
export function createServiceClient() {
  return createSupabaseClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
