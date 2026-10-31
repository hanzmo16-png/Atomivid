import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { studioUser } from "@/lib/podcast/auth";
import { libraryAction, type LibraryKind } from "@/lib/podcast/library";
import { STUDIO_TABLE } from "@/lib/podcast/v3/store";

const TABLE: Record<LibraryKind, string> = { studio: STUDIO_TABLE, v2: "podcast_episodes" };
const missingColumn = (e: { code?: string; message?: string }) => /archived_at|42703|PGRST204/.test(`${e.code} ${e.message}`);

/** Archivar / restaurar un episodio de Podcast del dueño (solo marca archived_at; no borra archivos, enlaces ni costos). */
export async function POST(request: Request) {
  const user = await studioUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const out = await libraryAction(user.id, await request.json().catch(() => null), {
    load: async (kind, id) => {
      const cols = kind === "v2" ? "user_id,status,video_status,archived_at" : "user_id,status,archived_at";
      const { data, error } = await service.from(TABLE[kind]).select(cols).eq("id", id).eq("user_id", user.id).maybeSingle();
      if (error) return missingColumn(error) ? "sin_columna" : null;
      return data as unknown as { user_id: string; status: string; video_status?: string | null } | null;
    },
    setArchived: async (kind, id, at) => {
      const { data } = await service.from(TABLE[kind]).update({ archived_at: at }).eq("id", id).eq("user_id", user.id).select("id");
      return (data?.length ?? 0) === 1;
    },
  });
  return NextResponse.json(out.body, { status: out.status });
}
