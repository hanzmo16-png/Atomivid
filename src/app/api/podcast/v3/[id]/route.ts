import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { studioGenerationEnabled } from "@/lib/podcast/v3/studio";
import { listAccountVoices } from "@/lib/podcast/voices";
import { authorizeAction, episodeAction } from "@/lib/podcast/v3/api";
import { STUDIO_COLUMNS, STUDIO_TABLE, type StudioEpisodeRow } from "@/lib/podcast/v3/store";
import { dispatchPodcastJob } from "@/lib/podcast/video-jobs";

const BUCKET = "videos";

async function load(service: ReturnType<typeof createServiceClient>, id: string): Promise<StudioEpisodeRow | "missing" | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await service.from(STUDIO_TABLE).select(STUDIO_COLUMNS).eq("id", id).maybeSingle();
  if (error) return /does not exist|schema cache|42P01|PGRST205/.test(`${error.code} ${error.message}`) ? "missing" : null;
  return data as StudioEpisodeRow | null;
}

/** Estado/progreso del episodio de estudio y enlaces de descarga firmados (solo el dueño). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const { id } = await params;
  const service = createServiceClient();
  const row = await load(service, id);
  const out = await episodeAction(user.id, row, async (p, name) => (await service.storage.from(BUCKET).createSignedUrl(p, 3600, { download: name })).data?.signedUrl ?? null);
  return NextResponse.json(out.body, { status: out.status });
}

/** Autorización explícita del cargo y despacho del trabajo (paso 10 del asistente). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const service = createServiceClient();
  const out = await authorizeAction({
    userId: user.id, viewer: user, voices: () => listAccountVoices(), enabled: studioGenerationEnabled(user), llm: null,
    insert: async () => null, load: (x) => load(service, x),
    authorize: async (x, usd) => { const { data } = await service.from(STUDIO_TABLE).update({ status: "authorized", authorized_usd: usd, authorized_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("id", x).eq("user_id", user.id).in("status", ["draft", "failed"]).select("id"); return (data?.length ?? 0) === 1; },
    dispatch: (x) => dispatchPodcastJob(x, "studio"),
    markStale: async (x, startedBefore) => {
      const at = new Date().toISOString();
      const { data } = await service.from(STUDIO_TABLE).update({ status: "failed", error: "La generación se interrumpió. Lo ya pagado se conserva y se reutiliza al reintentar; no se cobra dos veces.", updated_at: at })
        .eq("id", x).eq("user_id", user.id).eq("status", "generating").or(`run_started_at.is.null,run_started_at.lt.${startedBefore}`).select("id");
      if ((data?.length ?? 0) !== 1) return false;
      await service.from("podcast_studio_operations").update({ state: "uncertain", updated_at: at }).eq("episode_id", x).eq("state", "reserved");
      return true;
    },
  }, id, body);
  return NextResponse.json(out.body, { status: out.status });
}
