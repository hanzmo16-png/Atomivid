import type { ScenarioResult } from "./report";

type Report = {
  simulator: string; task: string; generatedAt: string; commit: string; branch: string; mode: string; outDir: string;
  environment: Record<string, unknown>;
  zero_paid_controls: { actual_provider_spend_usd: 0; scrubbedEnvNames: string[]; blockedExternalAttempts: unknown[]; emulatedRequestsByHost: Record<string, number> };
  summary: Record<string, number>; elapsedSeconds: number; scenarios: ScenarioResult[];
};

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# ${r.simulator} — informe`, "");
  lines.push(`- Tarea: ${r.task}`, `- Generado: ${r.generatedAt}`, `- Commit: \`${r.commit}\` (rama \`${r.branch}\`)`, `- Modo: ${r.mode} · duración ${r.elapsedSeconds}s`, `- Entorno: ${esc(JSON.stringify(r.environment))}`);
  lines.push(`- **actual_provider_spend_usd: 0** · intentos externos bloqueados: ${r.zero_paid_controls.blockedExternalAttempts.length} · peticiones a hosts emulados: ${esc(JSON.stringify(r.zero_paid_controls.emulatedRequestsByHost))}`);
  lines.push(`- Resultado: **${r.summary.PASS} PASS · ${r.summary.FAIL} FAIL · ${r.summary.NOT_VERIFIED} NOT_VERIFIED**`, "");
  lines.push("| ID | Modo | Escenario | Estado | Motivo | Peticiones facturables (emuladas) | Tiempo |", "|---|---|---|---|---|---|---|");
  for (const s of r.scenarios) {
    const billable = Object.entries(s.billable_requests).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "0";
    lines.push(`| ${s.id} | ${s.mode} | ${esc(s.title)} | **${s.status}** | ${esc(s.reason).slice(0, 220)} | ${billable} | ${(s.elapsedMs / 1000).toFixed(1)}s |`);
  }
  const media = r.scenarios.flatMap((s) => s.artifacts.map((a) => ({ id: s.id, ...a })));
  if (media.length) {
    lines.push("", "## MP4 renderizados (SHA-256 y ffprobe)", "", "| Escenario | Archivo | SHA-256 | Bytes | Duración | Video | Audio |", "|---|---|---|---|---|---|---|");
    for (const m of media) lines.push(`| ${m.id} | ${m.path.split("/").pop()} | \`${m.sha256}\` | ${m.bytes} | ${m.ffprobe.durationSeconds.toFixed(3)}s | ${m.ffprobe.video ? `${m.ffprobe.video.codec} ${m.ffprobe.video.width}x${m.ffprobe.video.height} @${m.ffprobe.video.fps}` : "—"} | ${(m.ffprobe.audio ?? []).map((a) => `${a.codec} ${a.sampleRate}Hz ${a.channels}ch`).join(", ") || "—"} |`);
  }
  lines.push("", "## Detalle de checks fallidos o no verificados", "");
  for (const s of r.scenarios.filter((x) => x.status !== "PASS")) {
    lines.push(`### ${s.id} — ${s.status}`, `${s.title}`, "");
    for (const c of s.checks.filter((c) => !c.ok)) lines.push(`- ✗ ${c.name}: \`${esc(JSON.stringify(c.detail ?? null)).slice(0, 600)}\``);
    if (s.data.finding) lines.push(`- Hallazgo: ${s.data.finding}`);
    if (s.data.observed) lines.push(`- Observado: ${s.data.observed}`);
    if (s.data.reproduce) lines.push(`- Reproducir: \`${s.data.reproduce}\``);
    lines.push("");
  }
  const eco = r.scenarios.filter((s) => s.data.unit_economics);
  if (eco.length) {
    lines.push("## Economía unitaria (teórica, USD)", "");
    for (const s of eco) {
      const u = s.data.unit_economics as { theoretical_cost_usd: number; theoretical_cost_is_lower_bound: boolean; breakdown: { provider: string; resource: string; quantity: unknown; unit: string; rate: string; usd: unknown; source: string; note?: string }[]; unknown_components: string[]; rate_references: Record<string, { commit: string; date: string }> };
      lines.push(`### ${s.id} — actual_provider_spend_usd = 0 · theoretical_cost_usd = ${u.theoretical_cost_usd}${u.theoretical_cost_is_lower_bound ? " (cota inferior: hay componentes UNKNOWN)" : ""}`, "", "| Proveedor | Recurso | Cantidad | Tarifa | USD | Fuente |", "|---|---|---|---|---|---|");
      for (const l of u.breakdown) lines.push(`| ${l.provider} | ${esc(l.resource)} | ${l.quantity} ${l.unit} | ${esc(l.rate)} | ${l.usd} | ${esc(l.source)}${l.note ? ` — ${esc(l.note)}` : ""} |`);
      lines.push("", `Tarifas (versión = último commit del archivo): ${esc(JSON.stringify(u.rate_references))}`, "");
    }
  }
  return lines.join("\n") + "\n";
}
