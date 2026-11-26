import Link from "next/link";
import type { NormalQuotaPreview } from "@/lib/billing/quota";

/**
 * Cuánto le queda al cliente de su plan antes de crear (Mystery Shopper en producción, 26-nov: el formulario no
 * informaba ni costo ni límite). Solo informa: el bloqueo real lo aplica el servidor al iniciar la producción.
 */
export function PlanQuotaNote({ preview }: { preview: NormalQuotaPreview | null }) {
  if (!preview || preview.kind === "internal") return null;
  if (preview.kind === "inactive") {
    return (
      <div data-testid="plan-quota" className="mt-5 rounded-md border border-border-strong p-3 text-sm text-ink-muted">
        <p>{preview.reason} Puedes preparar y revisar el guion; para producir el video final elige un plan.</p>
        <Link href="/dashboard/billing" className="mt-2 inline-flex min-h-11 items-center font-medium text-accent underline">
          Ver planes
        </Link>
      </div>
    );
  }
  const { planName, limit, remaining } = preview;
  return (
    <div data-testid="plan-quota" className="mt-5 rounded-md border border-border-strong p-3 text-sm text-ink-muted">
      {remaining > 0 ? (
        <p>
          <span className="font-medium text-ink">Tu plan {planName}:</span> te quedan {remaining} de {limit}{" "}
          {limit === 1 ? "video" : "videos"} este mes. Crear la solicitud y revisar el guion no consume; se descuenta
          al producir el video final.
        </p>
      ) : (
        <>
          <p>
            <span className="font-medium text-ink">Tu plan {planName}:</span> ya usaste los {limit} videos de este mes.
            Puedes preparar el guion; para producir el video final espera al próximo mes o mejora tu plan.
          </p>
          <Link href="/dashboard/billing" className="mt-2 inline-flex min-h-11 items-center font-medium text-accent underline">
            Mejorar plan
          </Link>
        </>
      )}
    </div>
  );
}
