import { VideoModeNav } from "@/components/video/VideoModeNav";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { createServiceClient } from "@/lib/supabase/service";
import { RECORDING_BUCKET } from "@/lib/video/avatar/recording";
import { PreparationForm, SavedPreparationForm } from "./PreparationForm";

export const maxDuration = 60;

export default async function AvatarPreparationPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) notFound();
  const { data: saved, error } = await createServiceClient().storage.from(RECORDING_BUCKET)
    .list(`${user!.id}/preparations`, { limit: 100, sortBy: { column: "name", order: "asc" } });
  return <div className="mx-auto max-w-2xl space-y-4">
    <h1 className="text-2xl font-bold text-ink">Video con avatar</h1>
    <p className="text-sm text-ink-muted">Prueba privada: prepara tu fotografía y tu voz original. Guardar los archivos no genera un video ni consume saldo del proveedor.</p>
    <VideoModeNav current="avatar" />
    {error && <p role="alert">No se pudieron consultar las preparaciones guardadas.</p>}
    {saved?.filter(item => /^[a-f0-9-]{36}$/i.test(item.name)).map((item, i) => <SavedPreparationForm key={item.name} id={item.name} label={`Preparación guardada ${i + 1}`} />)}
    <PreparationForm />
  </div>;
}
