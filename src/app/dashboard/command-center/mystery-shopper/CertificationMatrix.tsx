import type { JobView } from "@/lib/mystery-shopper/jobs";
import { certificationMatrix, evidenceFromJob, type CertClass, type RunEvidence } from "@/lib/mystery-shopper/v3/certify";

const CLS: Record<CertClass, { label: string; tone: string; hint: string }> = {
  GO_REAL: { label: "GO REAL", tone: "border-success text-success", hint: "Generación auténtica validada" },
  GO_TECNICO: { label: "GO TÉCNICO", tone: "border-accent text-accent", hint: "Funciona; falta la generación pagada" },
  NO_GO: { label: "NO-GO", tone: "border-danger text-danger", hint: "Fallo confirmado" },
  BLOCKED: { label: "BLOQUEADO", tone: "border-border text-ink-muted", hint: "Impedimento externo o sin prueba real" },
};

/**
 * Mystery Shopper 3.0 — «¿qué módulos funcionan de verdad?». Se calcula con las evaluaciones reales del historial;
 * las pruebas de arnés o simuladas nunca suben a GO. Gasto real mostrado: el registrado por el worker (hoy USD 0).
 */
export function CertificationMatrix({ jobs }: { jobs: JobView[] }) {
  const evidence = jobs.map((j) => evidenceFromJob(j as never)).filter((x): x is RunEvidence => !!x);
  const rows = certificationMatrix(evidence);
  const spent = evidence.reduce((a, e) => a + e.spendUsd, 0);
  const operational = rows.filter((r) => r.cls === "GO_REAL").length;
  return (
    <div className="mt-5" data-testid="ms-certificacion">
      <h3 className="text-sm font-semibold text-ink">Certificación por módulo</h3>
      <p className="mt-1 text-xs text-ink-muted">{operational} de {rows.length} módulos con generación real validada · gasto real registrado USD {spent.toFixed(2)} · las pruebas simuladas no cuentan.</p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.module} className="min-w-0 rounded-lg border border-border px-3 py-2 text-sm" data-cert={r.cls}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">{r.label}</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${CLS[r.cls].tone}`} title={CLS[r.cls].hint}>{CLS[r.cls].label}</span>
            </div>
            <p className="mt-1 break-words text-ink-muted">{r.reason}</p>
            {r.lastAt && <p className="text-xs text-ink-faint">Última: {new Date(r.lastAt).toLocaleString("es-MX")} · {r.basis === "real" ? "real" : "gratuita"}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
