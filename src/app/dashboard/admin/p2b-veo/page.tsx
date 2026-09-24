import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isP2BAdmin } from "./access";
import { RunP2BForm } from "./RunP2BForm";

/** Igual criterio que el endpoint administrativo (route.ts): el sondeo de Veo puede tardar varios minutos. */
export const maxDuration = 300;

export default async function P2BVeoAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isP2BAdmin(user)) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold text-ink">P2B — Prueba real Veo (Pillar Transport)</h1>
      <p className="text-sm text-ink-muted">
        Página administrativa privada — inaccesible para cualquier otra cuenta. Ejecuta la generación real autorizada de Google
        Veo 3.1 Fast para el shot &quot;Pillar Transport&quot; (image-to-video, 16:9, 1080p, 8s). Requiere
        P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true en este entorno; se detiene automáticamente si el gasto acumulado de la misión
        alcanzaría o superaría los $10 autorizados. No habilita AI Video para usuarios normales.
      </p>
      <RunP2BForm />
    </div>
  );
}
