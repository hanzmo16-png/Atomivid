import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { ownerEditorStorage } from "@/lib/podcast/editor/storage";
import { checkDelivery, type DeliveryStatus } from "@/lib/podcast/editor/verify";
import { DELIVERY_LABEL } from "./labels";

/**
 * Results of the external podcast editor, read with the owner's own session. Only an account enrolled as
 * owner in podcast_editor.propietarios can list the bucket; anyone else sees an empty list.
 */
export default async function PodcastEditorResultsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!canAccessLongFormBeta(user)) notFound();

  let rows: { episodeId: string; version: number; status: DeliveryStatus }[] = [];
  let readError: string | null = null;
  try {
    const storage = ownerEditorStorage(supabase);
    const versions = (await storage.listVersions()).slice(0, 40);
    rows = await Promise.all(versions.map(async (v) => ({ ...v, status: await checkDelivery(storage, v.episodeId, v.version, { hashes: false }).catch(() => ({ state: "entrega_invalida", reason: "no se pudo leer" }) as DeliveryStatus) })));
  } catch (e) {
    readError = e instanceof Error ? e.message : "No se pudo leer el área del editor.";
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Editor externo de podcast</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Montajes entregados por el editor externo. Un episodio solo aparece como terminado cuando COMPLETO.json existe y
        cada archivo declarado coincide en tamaño y sha256 con lo guardado. Archivos privados: se abren con enlaces temporales.
      </p>
      {readError ? <p className="mt-6 text-sm text-danger">{readError}</p> : rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">No hay entregas visibles para tu cuenta. Si esperabas alguna, tu cuenta todavía no está registrada como propietaria del área del editor.</p>
      ) : (
        <ul className="mt-6 grid gap-2">
          {rows.map((r) => (
            <li key={`${r.episodeId}-${r.version}`} className="rounded-lg border border-border p-3 text-sm">
              <Link href={`/dashboard/podcast/editor/${r.episodeId}/v${r.version}`} className="font-medium text-ink underline">{r.episodeId} · v{r.version}</Link>
              <span className="ml-2 text-ink-muted">{DELIVERY_LABEL[r.status.state]}{r.status.state === "entrega_invalida" ? ` — ${r.status.reason}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-sm"><Link href="/dashboard/podcast" className="text-accent underline">Volver a Podcast</Link></p>
    </div>
  );
}
