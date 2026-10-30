import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import { buildVisualTestV2Manifest } from "@/lib/video/long-form/visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "@/lib/video/long-form/visual-test-v2-real";
import { buildVisualTestV2Gallery } from "@/lib/video/long-form/visual-test-v2-gallery";
import {
  issueVisualTestV2SpendAuthorization,
  visualTestV2SpendAuthSecret,
} from "@/lib/video/long-form/visual-test-v2-spend-auth";
import { DryRunButton } from "./DryRunButton";
import { RealGenerateButton } from "./RealGenerateButton";

/**
 * Herramienta interna de VIDEO #001 (Göbekli Tepe). Solo owner/admin
 * (`isCommandCenterAdmin`). Cualquier otra sesión, incluida una cuenta
 * de la allowlist de Long Form, recibe 404. El chequeo va ANTES de la
 * galería y de emitir la autorización de gasto.
 *
 *  - DRY_RUN: cero costo (DryRunButton).
 *  - Generación real: solo si el servidor pudo firmar una autorización
 *    de gasto atada a este usuario y al tope de US$0.50. El botón pide
 *    confirmación visible antes del POST. El API vuelve a validar admin
 *    y el token; sin eso no llama al proveedor.
 *  - Galería: solo lectura.
 */
export const dynamic = "force-dynamic";

export default async function VisualTestV2DryRunPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isCommandCenterAdmin(user)) {
    notFound();
  }

  const manifest = buildVisualTestV2Manifest();
  const realShots = VISUAL_TEST_V2_REAL_SHOT_IDS.map((shotId) =>
    manifest.shots.find((s) => s.shotId === shotId),
  ).filter((s): s is NonNullable<typeof s> => Boolean(s));
  const estimatedTotalUsd = realShots.reduce((sum, s) => sum + s.estimatedCostUsd, 0);

  const spendSecret = visualTestV2SpendAuthSecret();
  const spendAuthorization =
    user.id && spendSecret
      ? issueVisualTestV2SpendAuthorization({ userId: user.id, secret: spendSecret })
      : null;

  const gallery = await buildVisualTestV2Gallery(createServiceClient());

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-ink">Visual Test V2 (Long Form, interno)</h1>
        <p className="text-sm text-ink-muted">
          Herramienta de administración para VIDEO #001 (Göbekli Tepe). Solo cuentas owner/admin. El DRY_RUN
          (<code>POST /api/long-form/visual-test-v2</code>) nunca genera imágenes ni gasta crédito real. La
          generación real, más abajo, cubre exclusivamente 3 imágenes y el servidor rechaza la llamada si no
          hay una autorización de gasto válida para esta sesión.
        </p>
        <DryRunButton />
      </div>
      {spendAuthorization ? (
        <RealGenerateButton
          shotIds={VISUAL_TEST_V2_REAL_SHOT_IDS}
          estimatedTotalUsd={estimatedTotalUsd}
          maxTotalUsd={spendAuthorization.maxUsd}
          spendAuthorizationToken={spendAuthorization.token}
        />
      ) : (
        <p className="rounded-lg border border-border-strong p-4 text-sm text-ink-muted">
          La generación real está cerrada: el servidor no tiene una clave para firmar la autorización de gasto.
          No hay botón de pago en esta página.
        </p>
      )}
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
