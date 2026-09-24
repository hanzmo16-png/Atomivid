import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { buildVisualTestV2Manifest } from "@/lib/video/long-form/visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "@/lib/video/long-form/visual-test-v2-real";
import { DryRunButton } from "./DryRunButton";
import { RealGenerateButton } from "./RealGenerateButton";

/**
 * Página administrativa MÍNIMA y TEMPORAL para VIDEO #001 (Göbekli Tepe).
 * Gate de acceso: EXACTAMENTE el mismo control Long Form/allowlist que ya
 * usa el resto de Long Form (LONG_FORM_ENABLED + allowlist por id/email)
 * — mismas funciones que assertLongFormAccess usa internamente
 * (access.ts), nada nuevo. Usuario no autorizado → 404 (mismo patrón que
 * /dashboard/avatar/prepare), no revela que la página existe.
 *
 * Dos controles, claramente separados:
 *  - "Ejecutar Dry Run Long Form": DRY_RUN/PREFLIGHT, cero costo, cero
 *    llamada real — ver DryRunButton.tsx.
 *  - "Generar 3 imágenes — máximo US$0.50": generación REAL controlada,
 *    autorizada explícitamente por el usuario, EXACTAMENTE para los 3
 *    shots aprobados del Visual Test V2 — ver RealGenerateButton.tsx y
 *    visual-test-v2-real.ts. Nunca genera el documental completo.
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

  // Números calculados en el servidor a partir del manifest REAL ya
  // aprobado — nunca hardcodeados en el cliente, nunca editables (el
  // componente cliente los recibe como props de solo lectura, sin ningún
  // input asociado).
  const manifest = buildVisualTestV2Manifest();
  const realShots = VISUAL_TEST_V2_REAL_SHOT_IDS.map((shotId) =>
    manifest.shots.find((s) => s.shotId === shotId),
  ).filter((s): s is NonNullable<typeof s> => Boolean(s));
  const estimatedTotalUsd = realShots.reduce((sum, s) => sum + s.estimatedCostUsd, 0);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-ink">Visual Test V2 (Long Form, interno)</h1>
        <p className="text-sm text-ink-muted">
          Herramienta temporal de administración para VIDEO #001 (Göbekli Tepe). El DRY_RUN
          (<code>POST /api/long-form/visual-test-v2</code>) nunca genera imágenes ni gasta crédito real. El control
          de generación REAL, más abajo, genera EXCLUSIVAMENTE las 3 imágenes ya aprobadas — nunca el documental
          completo — y consume dinero real solo cuando lo pulsas explícitamente.
        </p>
        <DryRunButton />
      </div>
      <RealGenerateButton
        shotIds={VISUAL_TEST_V2_REAL_SHOT_IDS}
        estimatedTotalUsd={estimatedTotalUsd}
        maxTotalUsd={manifest.maxTotalUsd}
      />
    </div>
  );
}
