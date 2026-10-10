/**
 * GitHub notification check for the owner's phone. Mode "send": one generic test comment by the Actions bot on the
 * notices issue (rate limited). Mode "verify": reads the owner's 👍 on the latest test comment. Free; no app data.
 * Env: GITHUB_TOKEN (Actions), GITHUB_REPOSITORY, NOTICE_MENTION, MODE.
 */
export {};
import { appendFile } from "node:fs/promises";
import { latestTest, reception, sendDecision, testCode, testComment, type BotComment, type Reaction } from "../src/lib/podcast/notice-check";

const NOTICE_ISSUE_TITLE = "Avisos de producción de Atomivid"; // same issue as src/lib/podcast/pilot-server.ts

async function main() {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY, owner = process.env.NOTICE_MENTION ?? "", mode = process.env.MODE;
  if (!token || !repo || !owner || (mode !== "send" && mode !== "verify")) throw new Error("configuración incompleta (token, repositorio, usuario o modo)");
  const gh = async (p: string, init?: RequestInit) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub ${res.status} en ${p.split("?")[0]}`);
    return res.json();
  };
  const report = async (line: string) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
  const issue = ((await gh("/issues?state=open&per_page=100")) as { number: number; title: string }[]).find((i) => i.title === NOTICE_ISSUE_TITLE);
  if (!issue) { await report("No hay un issue abierto de avisos; no se envió nada."); process.exitCode = 1; return; }
  const comments = (await gh(`/issues/${issue.number}/comments?per_page=100&since=${new Date(Date.now() - 30 * 24 * 3600_000).toISOString()}`)) as BotComment[];
  if (mode === "send") {
    const now = new Date();
    const d = sendDecision(comments, now);
    if (!d.ok) { await report(`No se envió: ${d.reason}.`); return; }
    const code = testCode(now);
    const posted = (await gh(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: testComment(owner, code) }) })) as BotComment;
    await report(`EMITIDO ${code}: comentario del bot ${posted.user?.login ?? "?"} a las ${posted.created_at}. Recepción: pendiente de la reacción 👍 del propietario.`);
    return;
  }
  const last = latestTest(comments);
  if (!last) { await report("No hay ninguna prueba enviada todavía."); process.exitCode = 1; return; }
  const reactions = (await gh(`/issues/comments/${last.id}/reactions?content=%2B1&per_page=100`)) as Reaction[];
  const r = reception(last, reactions, owner);
  await report(r.received
    ? `RECIBIDO: el propietario confirmó con 👍 a las ${r.reactedAt} (${r.secondsAfterEmission} s después de emitir ${last.created_at}).`
    : `EMITIDO ${last.created_at}, SIN CONFIRMAR: todavía no hay 👍 del propietario. Revisa los ajustes de notificaciones de GitHub en el teléfono.`);
  if (!r.received) process.exitCode = 2;
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
