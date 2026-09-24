import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isP2BAdmin } from "./access";
import { RunP2BForm } from "./RunP2BForm";

/** Igual criterio que el endpoint administrativo (route.ts): el sondeo de Veo puede tardar varios minutos. */
export const maxDuration = 300;

/**
 * `VERCEL_GIT_COMMIT_SHA`/`VERCEL_ENV` son variables de SISTEMA que Vercel
 * inyecta automáticamente en cada deployment (no son secretos, no
 * requieren configuración) — ver
 * https://vercel.com/docs/environment-variables/system-environment-variables.
 * Se muestran aquí, sin autenticación extra más allá del gate de la
 * página, para que Hans pueda confirmar DESDE EL NAVEGADOR qué commit
 * exacto está sirviendo esta página antes de pulsar el botón — sin
 * depender de que esta sesión de Claude tenga acceso al dashboard/API de
 * Vercel (nunca lo tiene).
 */
function deploymentInfo() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    sha: sha ? sha.slice(0, 12) : "desconocido (no corre en Vercel)",
    env: process.env.VERCEL_ENV ?? "local",
  };
}

export default async function P2BVeoAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isP2BAdmin(user)) notFound();
  const { sha, env } = deploymentInfo();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold text-ink">P2B — Prueba real Veo (Pillar Transport)</h1>
      <p className="rounded-md border border-border-strong bg-surface-raised px-3 py-2 font-mono text-xs text-ink-muted">
        Build/commit: {sha} — entorno: {env}
      </p>
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
