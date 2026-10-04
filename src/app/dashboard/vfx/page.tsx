import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { directorActor } from "@/lib/production-intelligence/vfx-director/access";
import { ownedJob } from "@/lib/production-intelligence/vfx-director/jobs";
import { supabaseJobStore, supabaseDispatchLedger } from "@/lib/production-intelligence/vfx-director/store";
import { executionConfig, executionView } from "@/lib/production-intelligence/vfx-director/execution";
import { reviewMedia } from "@/lib/production-intelligence/vfx-director/review-media";
import { VfxDirectorView } from "./VfxDirectorView";

export const dynamic = "force-dynamic";
export default async function VfxPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  let actor: string;
  try { actor = directorActor(user); } catch { notFound(); }
  const service = createServiceClient();
  const { data, error } = await service.from("vfx_director_jobs").select("id").eq("owner_id", actor).order("created_at", { ascending: false });
  if (error) throw new Error("No se pudo cargar el Director VFX.");
  const { id } = await searchParams;
  const selected = id ?? data?.[0]?.id;
  const job = selected ? await ownedJob(supabaseJobStore(service), selected, actor) : null;
  const media = job ? await reviewMedia(service, job) : {};
  const execution = job ? executionView(job, await supabaseDispatchLedger(service).list(job.id), executionConfig()) : null;
  return <VfxDirectorView projects={(data ?? []).map(row => row.id)} job={job} media={media} execution={execution} />;
}
