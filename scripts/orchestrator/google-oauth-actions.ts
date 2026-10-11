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
 * GOOGLE_OAUTH_REFRESH_TOKEN (previous, optional), GH_TOKEN (fine-grained: this repository only, ONLY the
 * "Environments" permission read & write — the one GitHub requires for environment secrets — expiring within 30 days), GITHUB_TOKEN (run token, to verify the environment's branch
 * policy), DEFAULT_BRANCH, GITHUB_REPOSITORY, ORCH_DRIVE_ROOT, MODE.
 */
export {};
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { checkTokenResponse, consentUrl, newPending, OAUTH_ENVIRONMENT, parsePending, parseRedirect, tokenRequestBody } from "../../src/lib/orchestrator/google-oauth";
import { checkEnvironment, checkWriterToken } from "./github-checks";
import { checkDriveConnection } from "../../src/lib/orchestrator/drive-check";

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
  if (!secret(["set", "GOOGLE_OAUTH_PENDING"], JSON.stringify(pending))) return fail("GitHub no aceptó guardar el intento (revisa que el token tenga el permiso «Environments» de lectura y escritura sobre este repositorio y que exista el entorno «orchestrator»)");
  await say("1. Abre este enlace en el navegador del teléfono e inicia sesión con la cuenta dueña de la carpeta de coordinación (válido 15 minutos):");
  await say(`   ${consentUrl(clientId, pending)}`);
  await say("2. Si aparece «Google no verificó esta app», toca «Configuración avanzada» → «Ir a … (no seguro)»: la app es tuya. Marca el permiso de Google Drive.");
  await say("3. El navegador terminará en una página de error (127.0.0.1): es lo esperado. Copia la dirección COMPLETA de la barra.");
  await say("4. En GitHub → Settings → Environments → orchestrator → Add environment secret: nombre GOOGLE_OAUTH_REDIRECT, valor la dirección copiada. (No la pegues en ningún chat ni en ningún campo del workflow.)");
  await say("5. Ejecuta este flujo con modo «finish». Borrará ese secreto y el intento, pase lo que pase.");
}

/**
 * Google revokes the whole grant (this client + this account), not one token: revoking any token of the owner's
 * account would also kill the one already stored. So a token is revoked ONLY when it belongs to an account that is
 * NOT the folder owner; a replaced token of the owner is never revoked automatically (Hans can remove access by hand).
 */
async function finish(clientId: string, clientSecret: string, root: string) {
  const p = parsePending(process.env.GOOGLE_OAUTH_PENDING);
  if (!p.ok) return fail(p.reason);
  mask(p.pending.verifier);
  const r = parseRedirect(process.env.GOOGLE_OAUTH_REDIRECT, p.pending.state);
  if (!r.ok) return fail(r.reason);
  mask(r.code);
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody({ code: r.code, verifier: p.pending.verifier, clientId, clientSecret }), signal: AbortSignal.timeout(20_000) });
  const body = (await tok.json().catch(() => null)) as { refresh_token?: string; access_token?: string; scope?: string; error?: string } | null;
  mask(body?.access_token); mask(body?.refresh_token);
  const check = checkTokenResponse(tok.status, body);
  if (!check.ok) return fail(check.reason);
  // The token must belong to the owner of the coordination folder (not any account that happened to consent).
  const f = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(root)}?fields=id,ownedByMe,capabilities(canAddChildren)`, { headers: { authorization: `Bearer ${body!.access_token}` }, signal: AbortSignal.timeout(20_000) });
  const folder = (await f.json().catch(() => null)) as { ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } } | null;
  if (f.status === 404 || (f.ok && folder?.ownedByMe !== true)) {
    await revoke(check.refreshToken); // another account: its grant can go, the owner's stored token is untouched
    return fail("la cuenta autorizada no es la dueña de la carpeta de coordinación; su acceso se revocó y no se guardó nada");
  }
  if (!f.ok || folder?.capabilities?.canAddChildren !== true) return fail("no se pudo comprobar la carpeta de coordinación; no se guardó nada (repite «start»)");
  if (!secret(["set", "GOOGLE_OAUTH_REFRESH_TOKEN"], check.refreshToken)) return fail("GitHub no aceptó guardar el secreto en el entorno «orchestrator»; no se guardó nada");
  // The writer token is not needed any more: remove it from the environment (Hans revokes it in GitHub, or it expires).
  const writerRemoved = secret(["delete", "ORCH_SECRETS_WRITER_TOKEN"]);
  await say(`LISTO: GOOGLE_OAUTH_REFRESH_TOKEN guardado en el entorno «${OAUTH_ENVIRONMENT}» (solo la rama por defecto puede leerlo). La cuenta es dueña de la carpeta y puede escribir en ella. Ningún token se mostró.${writerRemoved ? " ORCH_SECRETS_WRITER_TOKEN se borró del entorno; revócalo también en GitHub." : " Borra ORCH_SECRETS_WRITER_TOKEN del entorno y revócalo en GitHub."}`);
}

/** Always runs in "finish" mode, whatever happened: each secret deleted on its own (one failing never skips the other). */
async function cleanupFinish() {
  const redirect = secret(["delete", "GOOGLE_OAUTH_REDIRECT"]);
  const pending = secret(["delete", "GOOGLE_OAUTH_PENDING"]);
  if (!redirect || !pending) await say("Aviso: no se pudo borrar algún secreto temporal (GOOGLE_OAUTH_REDIRECT / GOOGLE_OAUTH_PENDING); el paso de limpieza lo reintenta, o bórralo a mano.");
}

/**
 * verify: no GitHub writer token needed. Reports which secrets exist in the environment (booleans), checks the
 * environment's branch policy, and, when a refresh token is stored, checks the real connection to Drive.
 */
async function verify(clientId: string | undefined, clientSecret: string | undefined, root: string | undefined) {
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  await say(`Secretos en el entorno «${OAUTH_ENVIRONMENT}»: GOOGLE_OAUTH_CLIENT_ID=${!!clientId} · GOOGLE_OAUTH_CLIENT_SECRET=${!!clientSecret} · GOOGLE_OAUTH_REFRESH_TOKEN=${!!refresh} · ORCH_SECRETS_WRITER_TOKEN=${!!process.env.GH_TOKEN}`);
  const env = await checkEnvironment();
  if (!env.ok) return fail(env.reason);
  await say(`Entorno: solo la rama por defecto puede usarlo${env.reviewers ? "; exige revisión" : "; sin revisor obligatorio"}.`);
  if (!clientId || !clientSecret) return fail("faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en el entorno");
  if (!refresh) { await say("Aún no hay GOOGLE_OAUTH_REFRESH_TOKEN: completa la autorización (docs/ORCHESTRATOR.md) y vuelve a ejecutar «verify»."); return; }
  if (!root || !process.env.ORCH_DRIVE_SOLICITUDES || !process.env.ORCH_DRIVE_ENTREGAS) return fail("faltan los identificadores de las carpetas");
  const r = await checkDriveConnection({ clientId, clientSecret, refreshToken: refresh }, { root, solicitudes: process.env.ORCH_DRIVE_SOLICITUDES, entregas: process.env.ORCH_DRIVE_ENTREGAS });
  await say(`Conexión real con Drive: ${JSON.stringify({ ok: r.ok, ...r.checks, ...(r.counts ?? {}) })}`);
  if (!r.ok) return fail(r.reason ?? "la conexión con Drive no pasó las comprobaciones");
  await say("LISTO: la cuenta autorizada es la dueña de la carpeta de coordinación, puede escribir en ella y ve Solicitudes/Entregas.");
}

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const root = process.env.ORCH_DRIVE_ROOT?.trim(), mode = process.env.MODE;
  if (mode === "verify") return verify(clientId, clientSecret, root);
  try {
    if (!clientId || !clientSecret) return fail("faltan los secretos GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en el entorno «orchestrator» (cliente OAuth «Desktop app»)");
    if (!process.env.GH_TOKEN) return fail("falta el secreto ORCH_SECRETS_WRITER_TOKEN en el entorno «orchestrator» (token de grano fino de este repositorio con solo el permiso «Environments» de lectura y escritura, 7 días)");
    if (!repo || !root) return fail("falta el repositorio o la carpeta de coordinación");
    // Never write a secret into an environment any branch could read, nor with a writer token that does not expire.
    const env = await checkEnvironment();
    if (!env.ok) return fail(env.reason);
    const writer = await checkWriterToken();
    if (!writer.ok) return fail(writer.reason);
    await say(`Comprobado: el entorno «${OAUTH_ENVIRONMENT}» solo lo usa la rama por defecto${env.reviewers ? " y exige revisión" : " (recomendado: añadir revisor obligatorio)"}; el token de escritura es de grano fino y caduca en ${writer.daysLeft} día(s).`);
    if (mode === "start") return await start(clientId);
    if (mode === "finish") return await finish(clientId, clientSecret, root);
    return fail("modo desconocido");
  } finally {
    if (mode === "finish" && process.env.GH_TOKEN && repo) await cleanupFinish();
  }
}
main().catch(async () => { await fail("error inesperado (sin detalles para no exponer datos)"); });
