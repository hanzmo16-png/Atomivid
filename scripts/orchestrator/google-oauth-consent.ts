/**
 * One-time Google consent for the orchestrator, run by Hans ON HIS OWN COMPUTER (never in a chat or in CI):
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npx tsx scripts/orchestrator/google-oauth-consent.ts
 * Opens Google's consent page (loopback redirect + PKCE, scope drive), receives the code on 127.0.0.1, exchanges it
 * and stores the refresh token straight into the repository's GitHub secrets with the official `gh` CLI
 * (`gh secret set`, value passed on stdin: it is never printed). Without `gh`, it writes a 0600 file next to the
 * repository that Hans pastes into GitHub → Settings → Secrets and then deletes.
 * The client id/secret come from Hans's own Google Cloud OAuth client ("Desktop app").
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) { console.error("Define GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET (cliente OAuth tipo «Desktop app»)."); process.exit(1); }
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) { res.writeHead(400).end("Estado inválido."); return; }
  const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: url.searchParams.get("code")!, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }).toString() });
  const body = (await tok.json()) as { refresh_token?: string; scope?: string };
  if (!tok.ok || !body.refresh_token) { res.writeHead(500).end("No se obtuvo el token de renovación."); console.error("Fallo al canjear el código (¿consentimiento sin acceso offline?)."); process.exit(1); }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Listo. Puedes cerrar esta pestaña.");
  const secrets: [string, string][] = [["GOOGLE_OAUTH_CLIENT_ID", clientId], ["GOOGLE_OAUTH_CLIENT_SECRET", clientSecret], ["GOOGLE_OAUTH_REFRESH_TOKEN", body.refresh_token]];
  const gh = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (gh.status === 0) {
    for (const [name, value] of secrets) {
      const r = spawnSync("gh", ["secret", "set", name, "--repo", process.env.GH_REPO || "hanzmo16-png/Atomivid"], { input: value, stdio: ["pipe", "ignore", "inherit"] });
      console.log(`${name}: ${r.status === 0 ? "guardado en los secretos de GitHub" : "ERROR al guardar"}`);
    }
  } else {
    const file = "orquestador-google-secretos.txt";
    writeFileSync(file, secrets.map(([n, v]) => `${n}=${v}`).join("\n") + "\n", { mode: 0o600 });
    console.log(`No hay gh CLI: se guardó ${file} (permisos 600). Copia cada valor en GitHub → Settings → Secrets and variables → Actions y borra el archivo.`);
  }
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  console.log(`Abre esta dirección en tu navegador e inicia sesión con hansgtav777@gmail.com:\n\n${auth}\n`);
});
