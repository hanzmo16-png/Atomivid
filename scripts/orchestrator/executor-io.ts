/**
 * Drive I/O for the Claude executor workflow (.github/workflows/claude-executor.yml). The subscription token from
 * `claude setup-token` can only make model requests (no claude.ai connectors), so the workflow itself brings the task
 * from Drive and takes the result back, with Hans's Drive OAuth credentials (GitHub secrets).
 *   fetch <taskId>   → orchestrator-out/task.md (only an orchestrated task for Claude that needs no spend/production)
 *   deliver <taskId> → Entregas/<taskId>__claude__hecha.md from orchestrator-out/result.md, or __bloqueada.md if absent
 * Secrets-looking strings are redacted before anything is written to Drive.
 */
export {};
import { mkdir, readFile, writeFile } from "node:fs/promises";

const REDACT = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|1\/\/[0-9A-Za-z_-]{20,})/g;
export const redactSecrets = (s: string) => s.replace(REDACT, "[REDACTADO]");

async function main() {
  const [cmd, taskId] = process.argv.slice(2);
  if (!/^(fetch|deliver)$/.test(cmd ?? "") || !/^T-\d{8}-\d{4}-[a-z]+-\d{2,}$/.test(taskId ?? "")) { console.error("uso: executor-io.ts fetch|deliver <taskId>"); process.exit(2); }
  const { DriveRestChannel, oauthRefreshTokenProvider } = await import("../../src/lib/orchestrator/channel");
  const { parseHeader, parseRequestName, renderHeader } = await import("../../src/lib/orchestrator/protocol");
  const o = { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "", refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "" };
  if (!o.clientId || !o.clientSecret || !o.refreshToken) { console.error("Faltan las credenciales OAuth de Google en los secretos."); process.exit(1); }
  const ch = new DriveRestChannel({ solicitudes: process.env.ORCH_DRIVE_SOLICITUDES!, entregas: process.env.ORCH_DRIVE_ENTREGAS! }, oauthRefreshTokenProvider(o));
  await mkdir("orchestrator-out", { recursive: true });
  if (cmd === "fetch") {
    const req = (await ch.list("solicitudes")).find((f) => parseRequestName(f.name)?.taskId === taskId);
    if (!req) { console.error("Solicitud no encontrada."); process.exit(1); }
    const text = await ch.read(req.id);
    const h = parseHeader(text);
    if (parseRequestName(req.name)!.to !== "claude" || (h.orquestar ?? "") !== "si" || (h.requiere_gasto_o_produccion ?? "no") !== "no") { console.error("La solicitud no es una tarea orquestada, gratuita y para Claude: no se ejecuta."); process.exit(1); }
    await writeFile("orchestrator-out/task.md", text);
    console.log("TASK_FETCHED", JSON.stringify({ taskId, chars: text.length }));
    return;
  }
  const result = await readFile("orchestrator-out/result.md", "utf8").catch(() => "");
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ok = result.trim().length > 0;
  const name = `${taskId}__claude__${ok ? "hecha" : "bloqueada"}.md`;
  const body = ok ? redactSecrets(result).slice(0, 20_000) : "El ejecutor automático no produjo resultado (orchestrator-out/result.md ausente o vacío).";
  const out = await ch.createIfAbsent("entregas", name, `${renderHeader({ id: taskId, de: "claude", estado: ok ? "hecha" : "bloqueada", fecha: at, ejecutor: "claude-code-action (suscripción)" })}\n\n${body}\n`);
  console.log("DELIVERED", JSON.stringify({ name, created: out.created }));
}
if (process.argv[1]?.endsWith("executor-io.ts")) main().catch((e) => { console.error("EXECUTOR_IO_FAILED", e instanceof Error ? e.message.slice(0, 160) : ""); process.exitCode = 1; });
