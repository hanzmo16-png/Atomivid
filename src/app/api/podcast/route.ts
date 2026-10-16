import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { createEpisode } from "@/lib/podcast/server";
import { handleCreateEpisode } from "@/lib/podcast/route-handlers";

/** Creates a draft (no paid call): validates the script and the voice against the account's voices. */
export async function POST(request: Request) {
  const user = await podcastUser();
  return handleCreateEpisode(request, { user: async () => user, service: createServiceClient, createEpisode });
}
