/**
 * Mystery Shopper 3.0 — matriz de certificación por módulo.
 *
 *  GO_REAL     generación auténtica (proveedor real, gasto > 0 registrado) y resultado validado (ffprobe/criterios).
 *  GO_TECNICO  recorrido autenticado real en ATOMIVID, todos los criterios gratuitos cumplidos; falta la generación facturable.
 *  NO_GO       fallo confirmado en un recorrido real (P0 o criterio incumplido).
 *  BLOCKED     impedimento externo documentado (cuenta QA, protección, presupuesto) o sin ejecución real todavía.
 *
 * Regla dura: una ejecución de fixture / simulada / mock NUNCA produce GO_REAL ni GO_TECNICO.
 */
export type CertClass = "GO_REAL" | "GO_TECNICO" | "NO_GO" | "BLOCKED";
export type CertModule = "youtube" | "audio-podcast" | "video-podcast" | "reels" | "library" | "commercial" | "account-nav";

export type RunEvidence = {
  module: CertModule;
  /** fixture/simulated = arnés o mocks; free = navegador real sin generación facturable; real = generación facturable autorizada. */
  kind: "fixture" | "simulated" | "free" | "real";
  target: "production" | "preview" | "local";
  authenticated: boolean;
  allCriteriaMet: boolean;
  p0Count: number;
  confirmedFailure: string | null;
  externalBlock: string | null;
  spendUsd: number;
  mediaValidated: boolean;
  at: string;
  runUrl?: string | null;
};

export type CertRow = { module: CertModule; label: string; cls: CertClass; reason: string; basis: "real" | "free" | "none"; lastAt: string | null; runUrl: string | null };

export const CERT_LABEL: Record<CertModule, string> = {
  youtube: "YouTube Studio", "audio-podcast": "Audio Podcast Studio", "video-podcast": "Podcast audiovisual",
  reels: "Reels Studio", library: "Biblioteca", commercial: "Sistema comercial", "account-nav": "Cuenta y navegación",
};
export const CERT_MODULES = Object.keys(CERT_LABEL) as CertModule[];

/** Clasifica un módulo con TODA su evidencia; la más reciente válida manda, los fallos confirmados no se tapan. */
export function certifyModule(module: CertModule, runs: RunEvidence[]): CertRow {
  const base = { module, label: CERT_LABEL[module] };
  const valid = runs.filter((r) => r.module === module && (r.kind === "free" || r.kind === "real") && r.target !== "local")
    .sort((a, b) => b.at.localeCompare(a.at));
  const ignored = runs.filter((r) => r.module === module && (r.kind === "fixture" || r.kind === "simulated" || r.target === "local")).length;
  const latest = valid[0];
  if (!latest) {
    const blk = runs.filter((r) => r.module === module).map((r) => r.externalBlock).find(Boolean);
    return { ...base, cls: "BLOCKED", basis: "none", lastAt: null, runUrl: null, reason: blk ?? (ignored ? `Solo hay ${ignored} prueba(s) de arnés/simuladas: no cuentan como certificación.` : "Sin ejecución real todavía.") };
  }
  const meta = { lastAt: latest.at, runUrl: latest.runUrl ?? null };
  if (latest.externalBlock && !latest.authenticated) return { ...base, ...meta, cls: "BLOCKED", basis: "none", reason: latest.externalBlock };
  if (latest.authenticated && (latest.confirmedFailure || latest.p0Count > 0)) return { ...base, ...meta, cls: "NO_GO", basis: latest.kind === "real" ? "real" : "free", reason: latest.confirmedFailure ?? `${latest.p0Count} incidencia(s) P0.` };
  if (latest.kind === "real" && latest.authenticated && latest.allCriteriaMet && latest.mediaValidated && latest.spendUsd > 0) return { ...base, ...meta, cls: "GO_REAL", basis: "real", reason: `Generación real validada (USD ${latest.spendUsd.toFixed(2)}).` };
  if (latest.authenticated && latest.allCriteriaMet) {
    const real = valid.find((r) => r.kind === "real" && r.authenticated && r.allCriteriaMet && r.mediaValidated && r.spendUsd > 0 && !r.confirmedFailure && r.p0Count === 0);
    if (real) return { ...base, ...meta, cls: "GO_REAL", basis: "real", reason: `Generación real validada (USD ${real.spendUsd.toFixed(2)}) y recorrido gratuito posterior sin fallos.` };
    return { ...base, ...meta, cls: "GO_TECNICO", basis: "free", reason: "Recorrido autenticado real sin fallos; falta generación facturable autorizada." };
  }
  return { ...base, ...meta, cls: "BLOCKED", basis: "none", reason: latest.externalBlock ?? "Criterios sin comprobar en la última ejecución real." };
}

export function certificationMatrix(runs: RunEvidence[]): CertRow[] {
  return CERT_MODULES.map((m) => certifyModule(m, runs));
}

/** Producto del worker 2.0 → módulo de certificación. */
export const PRODUCT_TO_MODULE: Record<string, CertModule | null> = {
  "audio-podcast": "audio-podcast", "video-podcast": "video-podcast", reels: "reels", "long-form": "youtube", youtube: "youtube",
  library: "library", "account-nav": "account-nav", "command-center": null,
};

/** Adapta un resumen de trabajo 2.0 (status.result) a evidencia 3.0. */
export function evidenceFromJob(j: { job: { product: string; mode: string; target?: { kind?: string } }; status: { state: string; finishedAt: string | null; updatedAt: string; workerRunUrl: string | null; result?: { verdict: string; coverage: string; critical: string | null; humanGate: string | null } | null } }): RunEvidence | null {
  const mod = PRODUCT_TO_MODULE[j.job.product];
  if (!mod || !j.status.result) return null;
  const r = j.status.result;
  const authenticated = !(r.humanGate || /No se pudo entrar/i.test(r.critical ?? ""));
  const kind = j.job.mode === "real" ? "real" : j.job.mode === "gratuito" ? "free" : "simulated";
  const target = (j.job.target?.kind === "preview" ? "preview" : j.job.target?.kind === "local" ? "local" : "production") as RunEvidence["target"];
  return {
    module: mod, kind, target, authenticated, allCriteriaMet: r.verdict === "FUNCIONA" && r.coverage === "EVALUADO",
    p0Count: 0, confirmedFailure: authenticated && r.verdict === "CON_PROBLEMAS" ? (r.critical ?? "Criterios incumplidos.") : null,
    externalBlock: r.humanGate ?? (!authenticated ? (r.critical ?? "Sin sesión QA.") : null),
    spendUsd: 0, mediaValidated: false, at: j.status.finishedAt ?? j.status.updatedAt, runUrl: j.status.workerRunUrl,
  };
}
