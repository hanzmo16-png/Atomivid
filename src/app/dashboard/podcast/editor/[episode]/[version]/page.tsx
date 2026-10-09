import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { parseVersionSegment, validEpisodeId } from "@/lib/podcast/editor/contract";
import { ownerEditorStorage } from "@/lib/podcast/editor/storage";
import { checkDelivery } from "@/lib/podcast/editor/verify";
import { DELIVERY_LABEL } from "../../labels";
import { VerifyDelivery } from "./VerifyDelivery";

export default async function PodcastEditorVersionPage({ params }: { params: Promise<{ episode: string; version: string }> }) {
  const { episode, version: segment } = await params;
  const version = parseVersionSegment(segment);
  if (!validEpisodeId(episode) || !version) notFound();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();

  const status = await checkDelivery(ownerEditorStorage(supabase), episode, version, { hashes: false }).catch(() => null);
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">{episode} · v{version}</h1>
      <p className="mt-1 text-sm text-ink-muted">{status ? DELIVERY_LABEL[status.state] : "No se pudo leer la entrega."}</p>
      {status?.state === "entrega_invalida" && <p className="mt-3 text-sm text-danger">{status.reason}</p>}
      {status?.state === "pendiente_verificar" && (
        <>
          <ul className="mt-4 grid gap-1 text-sm text-ink-muted">
            {status.salidas.map((s) => <li key={s.archivo}>{s.archivo} · {(s.bytes / 1_048_576).toFixed(1)} MB</li>)}
          </ul>
          <VerifyDelivery endpoint={`/api/podcast-editor/${episode}/v${version}/verify`} />
        </>
      )}
      <p className="mt-6 text-sm"><Link href="/dashboard/podcast/editor" className="text-accent underline">Volver a las entregas</Link></p>
    </div>
  );
}
