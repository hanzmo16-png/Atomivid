import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { PreparationForm } from "./PreparationForm";

export default async function AvatarPreparationPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) notFound();
  return <div className="mx-auto max-w-2xl space-y-4">
    <h1 className="text-2xl font-bold text-ink">Video con avatar</h1>
    <p className="text-sm text-ink-muted">Prueba privada: prepara tu fotografía y tu voz original. Guardar los archivos no genera un video ni consume créditos D-ID.</p>
    <PreparationForm />
  </div>;
}
