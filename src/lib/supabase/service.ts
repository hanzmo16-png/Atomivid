import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Client authenticated with the Supabase service role key. Bypasses Row
 * Level Security — only use it inside trusted server-only code (the video
 * generation pipeline), never in a component or in code reachable from the
 * browser.
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
