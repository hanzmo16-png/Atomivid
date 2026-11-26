/**
 * Mystery Shopper 3.0 — reporte diario consolidado (solo lectura, USD 0).
 * Lee el historial del Storage privado (mismo bucket/prefijo del 2.0), calcula la matriz de certificación 3.0
 * y escribe report-diario.json + resumen Markdown. No crea trabajos ni llama a proveedores.
 * Entorno: NEXT_PUBLIC_SUPABASE_URL | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MS_OUT_DIR, GITHUB_STEP_SUMMARY (opcional).
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobStore, MS_BUCKET, type JobView, type StorageApi } from "../../src/lib/mystery-shopper/jobs";
import { certificationMatrix, evidenceFromJob, type RunEvidence } from "../../src/lib/mystery-shopper/v3/certify";

export function dailySummary(jobs: JobView[], now = new Date()) {
  const since = now.getTime() - 24 * 3600_000;
  const evidence = jobs.map((j) => evidenceFromJob(j as never)).filter((x): x is RunEvidence => !!x);
  const matrix = certificationMatrix(evidence);
  const last24 = jobs.filter((j) => new Date(j.status.updatedAt).getTime() >= since);
  const byState = last24.reduce<Record<string, number>>((a, j) => { a[j.status.state] = (a[j.status.state] ?? 0) + 1; return a; }, {});
  return { version: "mystery-shopper-3.0-daily", at: now.toISOString(), spendUsd: 0, jobsLast24h: last24.length, byState, matrix };
}

if (process.argv[1] && /daily-report\.ts$/.test(process.argv[1])) {
  (async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error("Faltan secretos de Supabase."); process.exit(1); }
    const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const s = jobStore(client.storage.from(MS_BUCKET) as unknown as StorageApi);
    const jobs = await s.list(50);
    const r = dailySummary(jobs);
    const md = `### Mystery Shopper — reporte diario\n\nTrabajos últimas 24 h: ${r.jobsLast24h} ${JSON.stringify(r.byState)} · gasto USD 0\n\n| Módulo | Certificación | Motivo | Última |\n|---|---|---|---|\n${r.matrix.map((m) => `| ${m.label} | ${m.cls} | ${m.reason.replace(/\|/g, "/")} | ${m.lastAt ?? "—"} |`).join("\n")}\n`;
    console.log(md);
    if (process.env.MS_OUT_DIR) { await mkdir(process.env.MS_OUT_DIR, { recursive: true }); await writeFile(path.join(process.env.MS_OUT_DIR, "reporte-diario.json"), JSON.stringify(r, null, 2)); }
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });
    const p0 = r.matrix.filter((m) => m.cls === "NO_GO").length;
    process.exit(p0 ? 5 : 0);
  })().catch(() => { console.error("El reporte diario falló."); process.exit(1); });
}
