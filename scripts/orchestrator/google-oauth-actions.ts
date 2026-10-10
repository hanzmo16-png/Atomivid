/**
 * Google authorization for the orchestrator from GitHub Actions (.github/workflows/drive-oauth.yml), in two runs.
 * Nothing secret goes through workflow inputs, logs or the run summary:
 *  - start: creates a random attempt (state + PKCE verifier), stores it as the environment secret GOOGLE_OAUTH_PENDING
 *    and shows the consent link (public data only: client id, state, PKCE challenge);
 *  - the owner consents on the phone and stores the address the browser landed on (http://127.0.0.1…) as the
 *    environment secret GOOGLE_OAUTH_REDIRECT (GitHub → Settings → Environments → orchestrator);
 *  - finish: checks the attempt (≤ 15 min, same state), exchanges the code with the verifier, requires the account to
 *    own the coordination folder, stores GOOGLE_OAUTH_REFRESH_TOKEN in the environment (value on stdin), revokes the
 *    previous refresh token, and ALWAYS deletes GOOGLE_OAUTH_PENDING and GOOGLE_OAUTH_REDIRECT. On any failed check
 *    the new token is revoked and nothing is stored.
 * Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_PENDING, GOOGLE_OAUTH_REDIRECT,
 * GOOGLE_OAUTH_REFRESH_TOKEN (previous, optional), GH_TOKEN (fine-grained: this repository only, "Secrets" and
 * "Environments" read & write, expiring within 30 days), GITHUB_TOKEN (run token, to verify the environment's branch
 * policy), DEFAULT_BRANCH, GITHUB_REPOSITORY, ORCH_DRIVE_ROOT, MODE.
 */
export {};
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { checkTokenResponse, consentUrl, newPending, OAUTH_ENVIRONMENT, parsePending, parseRedirect, tokenRequestBody } from "../../src/lib/orchestrator/google-oauth";
import { checkEnvironment, checkWriterToken } from "./github-checks";

const say = async (line: string) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`); };
const fail = async (line: string) => { await say(`NO SE COMPLETÓ: ${line}`); process.exitCode = 1; };
const mask = (v: string | undefined) => { if (v) console.log(`::add-mask::${v}`); };
const repo = process.env.GITHUB_REPOSITORY ?? "";
/** `gh secret` on the protected environment; a value travels on stdin only (never argv, never logs). */
const secret = (args: string[], input?: string) => spawnSync("gh", ["secret", ...args, "--env", OAUTH_ENVIRONMENT, "--repo", repo], { input, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"], env: process.env }).status === 0;
const revoke = async (token: string | undefined) => { if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }).catch(() => undefined); };

async function start(clientId: string) {
  const pending = newPending();
  mask(pending.verifier);
  if (!secret(["set", "GOOGLE_OAUTH_PENDING"], JSON.stringify(pending))) return fail("GitHub no aceptó guardar el intento (revisa los permisos «Secrets» y «Environments» del token y que exista el entorno «orchestrator»)");
  await say("1. Abre este enlace en el navegador del teléfono e inicia sesión con la cuenta dueña de la carpeta de coordinación (válido 15 minutos):");
  await say(`   ${consentUrl(clientId, pending)}`);
  await say("2. Si aparece «Google no verificó esta app», toca «Configuración avanzada» → «Ir a … (no seguro)»: la app es tuya. Marca el permiso de Google Drive.");
  await say("3. El navegador terminará en una página de error (127.0.0.1): es lo esperado. Copia la dirección COMPLETA de la barra.");
  await say("4. En GitHub → Settings → Environments → orchestrator → Add environment secret: nombre GOOGLE_OAUTH_REDIRECT, valor la dirección copiada. (No la pegues en ningún chat ni en ningún campo del workflow.)");
  await say("5. Ejecuta este flujo con modo «finish». Borrará ese secreto y el intento, pase lo que pase.");
}

async function finish(clientId: string, clientSecret: string, root: string) {
  const previous = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || undefined;
  let fresh: string | undefined;
  try {
    const p = parsePending(process.env.GOOGLE_OAUTH_PENDING);
    if (!p.ok) return fail(p.reason);
    mask(p.pending.verifier);
    const r = parseRedirect(process.env.GOOGLE_OAUTH_REDIRECT, p.pending.state);
    if (!r.ok) return fail(r.reason);
    mask(r.code);
    const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody({ code: r.code, verifier: p.pending.verifier, clientId, clientSecret }), signal: AbortSignal.timeout(20_000) });
    const body = (await tok.json().catch(() => null)) as { refresh_token?: string; access_token?: string; scope?: string; error?: string } | null;
    mask(body?.access_token); mask(body?.refresh_token);
    fresh = body?.refresh_token;
    const check = checkTokenResponse(tok.status, body);
    if (!check.ok) return fail(check.reason);
    // The token must belong to the owner of the coordination folder (not any account that happened to consent).
    const f = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(root)}?fields=id,ownedByMe,capabilities(canAddChildren)`, { headers: { authorization: `Bearer ${body!.access_token}` }, signal: AbortSignal.timeout(20_000) });
    const folder = (await f.json().catch(() => null)) as { ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } } | null;
    if (!f.ok || folder?.ownedByMe !== true || folder.capabilities?.canAddChildren !== true) return fail("la cuenta autorizada no es la dueña de la carpeta de coordinación; el token se revocó y no se guardó nada");
    if (!secret(["set", "GOOGLE_OAUTH_REFRESH_TOKEN"], check.refreshToken)) return fail("GitHub no aceptó guardar el secreto en el entorno «orchestrator»; el token se revocó");
    fresh = undefined; // stored: keep it
    if (previous && previous !== check.refreshToken) await revoke(previous);
    await say(`LISTO: GOOGLE_OAUTH_REFRESH_TOKEN guardado en el entorno «${OAUTH_ENVIRONMENT}» (solo la rama por defecto puede leerlo). La cuenta es dueña de la carpeta y puede escribir en ella.${previous ? " El token anterior se revocó." : ""} Ningún token se mostró.`);
  } finally {
    await revoke(fresh); // a token obtained but not stored never stays valid
    const cleaned = secret(["delete", "GOOGLE_OAUTH_REDIRECT"]) && secret(["delete", "GOOGLE_OAUTH_PENDING"]);
    if (!cleaned) await say("Aviso: no se pudieron borrar GOOGLE_OAUTH_REDIRECT / GOOGLE_OAUTH_PENDING; bórralos a mano (ya no sirven: el código es de un solo uso).");
  }
}

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const root = process.env.ORCH_DRIVE_ROOT?.trim(), mode = process.env.MODE;
  if (!clientId || !clientSecret) return fail("faltan los secretos GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en el entorno «orchestrator» (cliente OAuth «Desktop app»)");
  if (!process.env.GH_TOKEN) return fail("falta el secreto ORCH_SECRETS_WRITER_TOKEN en el entorno «orchestrator» (token de grano fino de este repositorio, «Secrets» y «Environments» lectura y escritura)");
  if (!repo || !root) return fail("falta el repositorio o la carpeta de coordinación");
  // Never write a secret into an environment any branch could read, nor with a writer token that does not expire.
  const env = await checkEnvironment();
  if (!env.ok) return fail(env.reason);
  const writer = await checkWriterToken();
  if (!writer.ok) return fail(writer.reason);
  await say(`Comprobado: el entorno «${OAUTH_ENVIRONMENT}» solo lo usa la rama por defecto${env.reviewers ? " y exige revisión" : " (recomendado: añadir revisor obligatorio)"}; el token de escritura caduca en ${writer.daysLeft} día(s).`);
  if (mode === "start") return start(clientId);
  if (mode === "finish") return finish(clientId, clientSecret, root);
  return fail("modo desconocido");
}
main().catch(async () => { await fail("error inesperado (sin detalles para no exponer datos)"); });
