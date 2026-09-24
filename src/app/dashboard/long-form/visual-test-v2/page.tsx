import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { DryRunButton } from "./DryRunButton";

/**
 * Página administrativa MÍNIMA y TEMPORAL — un único botón que ejecuta
 * EXCLUSIVAMENTE el DRY_RUN/PREFLIGHT de Visual Test V2 (VIDEO #001).
 * Gate de acceso: EXACTAMENTE el mismo control Long Form/allowlist que
 * ya usa el resto de Long Form (LONG_FORM_ENABLED + allowlist por
 * id/email) — mismas funciones que assertLongFormAccess usa
 * internamente (access.ts), nada nuevo. Usuario no autorizado → 404
 * (mismo patrón que /dashboard/avatar/prepare), no revela que la página
 * existe.
 */
export const dynamic = "force-dynamic";

export default async function VisualTestV2DryRunPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isLongFormEnabled() || !isLongFormAllowlisted(user)) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold text-ink">Visual Test V2 — Dry Run (Long Form, interno)</h1>
      <p className="text-sm text-ink-muted">
        Herramienta temporal de administración para VIDEO #001 (Göbekli Tepe). El único botón de esta página
        ejecuta un DRY_RUN/PREFLIGHT contra <code>POST /api/long-form/visual-test-v2</code> — nunca genera
        imágenes ni gasta crédito real. El modo REAL permanece bloqueado por código
        (<code>VISUAL_TEST_V2_REAL_MODE_LOCKED</code>), sin excepción posible desde esta página.
      </p>
      <DryRunButton />
    </div>
  );
}
