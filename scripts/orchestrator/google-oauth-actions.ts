/**
 * Google authorization for the orchestrator from GitHub Actions (.github/workflows/drive-oauth.yml), in two runs:
 *  - start: prints the consent link (public data only: client id, nonce, PKCE challenge) in the run summary;
 *  - finish: reads the address the phone's browser landed on FROM THE EVENT PAYLOAD (never from env, so it is not
 *    echoed in the logs), exchanges the code, checks that the account owns the coordination folder, and stores the
 *    refresh token as the repository secret GOOGLE_OAUTH_REFRESH_TOKEN with `gh secret set` (stdin). On any failed
 *    check the new token is revoked. Nothing secret is ever printed.
 * Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GH_TOKEN (fine-grained token: this repository, Secrets
 * read & write), GITHUB_REPOSITORY, ORCH_DRIVE_ROOT, MODE.
 */
export {};
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { checkTokenResponse, consentUrl, parseRedirect, tokenRequestBody } from "../../src/lib/orchestrator/google-oauth";

const say = async (line: string) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`); };
const fail = async (line: string) => { await say(`NO SE COMPLETÓ: ${line}`); process.exitCode = 1; };

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const repo = process.env.GITHUB_REPOSITORY, root = process.env.ORCH_DRIVE_ROOT?.trim(), mode = process.env.MODE;
  if (!clientId || !clientSecret) return fail("faltan los secretos GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (cliente OAuth «Desktop app»)");
  if (!process.env.GH_TOKEN) return fail("falta el secreto ORCH_SECRETS_WRITER_TOKEN (token de GitHub de grano fino: este repositorio, «Secrets: read and write»); sin él no se puede guardar el token");
  if (!repo || !root) return fail("falta el repositorio o la carpeta de coordinación");
  if (mode === "start") {
    const nonce = randomBytes(16).toString("hex");
    await say("1. Abre este enlace en el navegador del teléfono e inicia sesión con la cuenta dueña de la carpeta de coordinación.");
    await say(`   ${consentUrl(clientId, clientSecret, nonce)}`);
    await say("2. Si aparece «Google no verificó esta app», toca «Configuración avanzada» → «Ir a … (no seguro)»: la app es tuya. Marca el permiso de Google Drive.");
    await say("3. Al final el navegador mostrará un error de página (127.0.0.1): es lo esperado. Copia la dirección COMPLETA de la barra.");
    await say("4. Antes de 10 minutos, ejecuta este flujo con modo «finish» y pega esa dirección en «redirect_url». El código sirve una sola vez y solo junto con el secreto del cliente.");
    return;
  }
  if (mode !== "finish") return fail("modo desconocido");
  // The pasted address comes from the event payload, never from an env var (step env values are printed in logs).
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8").catch(() => "{}")) as { inputs?: { redirect_url?: string } };
  const parsed = parseRedirect(event.inputs?.redirect_url ?? "");
  if (!parsed.ok) return fail(parsed.reason);
  console.log(`::add-mask::${parsed.code}`);
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody({ ...parsed, clientId, clientSecret }), signal: AbortSignal.timeout(20_000) });
  const body = (await tok.json().catch(() => null)) as { refresh_token?: string; access_token?: string; scope?: string; error?: string } | null;
  if (body?.access_token) console.log(`::add-mask::${body.access_token}`);
  if (body?.refresh_token) console.log(`::add-mask::${body.refresh_token}`);
  const check = checkTokenResponse(tok.status, body);
  const revoke = async () => { if (body?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(body.refresh_token)}`, { method: "POST" }).catch(() => undefined); };
  if (!check.ok) { await revoke(); return fail(check.reason); }
  // The token must belong to the owner of the coordination folder (not any account that happened to consent).
  const f = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(root)}?fields=id,ownedByMe,capabilities(canAddChildren)`, { headers: { authorization: `Bearer ${body!.access_token}` }, signal: AbortSignal.timeout(20_000) });
  const folder = (await f.json().catch(() => null)) as { ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } } | null;
  if (!f.ok || folder?.ownedByMe !== true || folder.capabilities?.canAddChildren !== true) { await revoke(); return fail("la cuenta autorizada no es la dueña de la carpeta de coordinación; el token se revocó y no se guardó nada"); }
  const r = spawnSync("gh", ["secret", "set", "GOOGLE_OAUTH_REFRESH_TOKEN", "--repo", repo], { input: check.refreshToken, stdio: ["pipe", "ignore", "pipe"], env: process.env });
  if (r.status !== 0) { await revoke(); return fail("GitHub no aceptó guardar el secreto (revisa el permiso «Secrets: read and write» del token); el token se revocó"); }
  await say("LISTO: GOOGLE_OAUTH_REFRESH_TOKEN guardado en los secretos del repositorio. La cuenta es dueña de la carpeta de coordinación y puede escribir en ella. El token no se mostró en ningún momento.");
}
main().catch(async () => { await fail("error inesperado (sin detalles para no exponer datos)"); });
