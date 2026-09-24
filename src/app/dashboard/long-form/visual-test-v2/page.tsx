import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { buildVisualTestV2Manifest } from "@/lib/video/long-form/visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "@/lib/video/long-form/visual-test-v2-real";
import { buildVisualTestV2Gallery } from "@/lib/video/long-form/visual-test-v2-gallery";
import { DryRunButton } from "./DryRunButton";
import { RealGenerateButton } from "./RealGenerateButton";

/**
 * Página administrativa MÍNIMA y TEMPORAL para VIDEO #001 (Göbekli Tepe).
 * Gate de acceso: EXACTAMENTE el mismo control Long Form/allowlist que ya
 * usa el resto de Long Form (LONG_FORM_ENABLED + allowlist por id/email)
 * — mismas funciones que assertLongFormAccess usa internamente
 * (access.ts), nada nuevo. Usuario no autorizado → 404 (mismo patrón que
 * /dashboard/avatar/prepare), no revela que la página existe. TODO lo de
 * abajo (incluida la galería) queda DESPUÉS de ese chequeo.
 *
 * Tres secciones, claramente separadas:
 *  - "Ejecutar Dry Run Long Form": DRY_RUN/PREFLIGHT, cero costo, cero
 *    llamada real — ver DryRunButton.tsx.
 *  - "Generar 3 imágenes — máximo US$0.50": generación REAL controlada,
 *    autorizada explícitamente por el usuario, EXACTAMENTE para los 3
 *    shots aprobados del Visual Test V2 — ver RealGenerateButton.tsx y
 *    visual-test-v2-real.ts. Nunca genera el documental completo. Solo se
 *    ejecuta con un click explícito — nunca al cargar/refrescar la página.
 *  - "VISUAL TEST V2 — REVISIÓN": galería de SOLO LECTURA de las imágenes
 *    ya generadas (registros COMPLETED existentes) — ver
 *    visual-test-v2-gallery.ts. No genera nada, no llama a OpenAI.
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

  // Solo lectura: firma URLs de corta duración para los registros
  // COMPLETED que ya existen en Storage — nunca genera, nunca llama a OpenAI.
  const gallery = await buildVisualTestV2Gallery(createServiceClient());

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
      <div className="space-y-4">
        <h2 className="text-xl font-bold text-ink">VISUAL TEST V2 — REVISIÓN</h2>
        <p className="text-sm text-ink-muted">
          Solo lectura: las imágenes ya generadas y guardadas en Storage. Cargar o refrescar esta página nunca
          genera ni gasta nada — no hay ninguna llamada a OpenAI en esta sección.
        </p>
        {gallery.length === 0 ? (
          <p className="text-sm text-ink-muted">Todavía no hay imágenes generadas para revisar.</p>
        ) : (
          <div className="space-y-6">
            {gallery.map((item) => (
              <div key={item.shotId} className="space-y-2 rounded-lg border border-border-strong p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.signedUrl} alt={`Visual Test V2 — ${item.shotId}`} className="w-full rounded-md" />
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">{item.shotId}</p>
                  <p>Status: {item.status}</p>
                  <p>Costo real: ${item.costUsd.toFixed(4)}</p>
                  <p>
                    Dimensiones: {item.widthPx ?? "?"}×{item.heightPx ?? "?"}px
                  </p>
                  <p>
                    Proveedor / modelo / calidad: {item.provider ?? "?"} / {item.model ?? "?"} / {item.quality ?? "?"}
                  </p>
                  <a href={item.signedUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    Ver imagen completa
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
